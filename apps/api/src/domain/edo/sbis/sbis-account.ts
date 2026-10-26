/**
 * Учётка СБИС: ключи из базы и «Проверить доступ».
 *
 * Ключи хранятся так же, как у Диадока: зашифрованы с AAD по id учётки
 * (`domain/auth/crypto.ts`). Токен входа не хранится: вход — раз за работу
 * (проверка, проход выгрузки), это 1–2 входа в полчаса при лимите СБИС 300 в
 * минуту, а лишнее состояние с секретом в базе не нужно.
 *
 * Проверка идёт под лизом учётки, как у Диадока: выгрузка и проверка одной
 * учётки не должны идти одновременно.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  StoredEdoCredentialsSchema,
  type EdoSbisCheckResult,
  type EdoSbisCredentials,
} from '@matcheck/contracts';
import type { Db } from '../../../db/client.js';
import { edoAccounts } from '../../../db/schema.js';
import { buildAad, decryptField } from '../../auth/crypto.js';
import { loadEnv } from '../../../lib/env.js';
import type { CheckFailure } from '../check-access.js';
import { acquireEdoLease, releaseEdoLease } from '../poll-lease.js';
import { loginByKey, type SbisSession } from './sbis.auth.js';
import { createSbisClient, orgRefOf, type SbisClient } from './sbis.client.js';
import { SbisAuthExpired, SbisAuthRejected, SbisRequestNotAllowed } from './sbis.http.js';
import { formatOrgRef } from './sbis.org-ref.js';
import { isYes } from './sbis.types.js';

export const SBIS_PROVIDER = 'sbis';

type AccountRow = typeof edoAccounts.$inferSelect;

export function isSbisAccount(account: { provider: string }): boolean {
  return account.provider === SBIS_PROVIDER;
}

/** Ключи учётки СБИС; не СБИС или нечитаемые ключи — исключение с понятным текстом. */
export function readSbisCredentials(account: Pick<AccountRow, 'id' | 'credentialsEncrypted'>): EdoSbisCredentials {
  const creds = StoredEdoCredentialsSchema.parse(
    JSON.parse(decryptField(account.credentialsEncrypted, buildAad('edo_accounts', account.id))),
  );
  if (creds.authMode !== 'sbis_service_key') {
    throw new Error('у учётки нет ключей СБИС');
  }
  return creds;
}

export type SbisAccountDeps = {
  login?: (creds: EdoSbisCredentials) => Promise<SbisSession>;
  createClient?: (session: SbisSession) => SbisClient;
};

export function sbisLogin(deps: SbisAccountDeps, creds: EdoSbisCredentials): Promise<SbisSession> {
  return (deps.login ?? loginByKey)(creds);
}

export function sbisClientFor(deps: SbisAccountDeps, session: SbisSession): SbisClient {
  return (deps.createClient ?? ((s) => createSbisClient({ session: s })))(session);
}

/** Ошибка СБИС → ответ админке: отказ ключей — 409 (чинит человек), прочее — 502. */
export function describeSbisFailure(err: unknown): CheckFailure {
  if (err instanceof SbisAuthRejected || err instanceof SbisAuthExpired) {
    return { error: 'sbis_auth_rejected', status: 409, message: err.message };
  }
  if (err instanceof SbisRequestNotAllowed) {
    return { error: 'sbis_request_not_allowed', status: 502, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: 'sbis_unavailable', status: 502, message: `СБИС не ответил: ${message}` };
}

export async function checkSbisAccess(
  db: Db,
  account: AccountRow,
  log: FastifyBaseLogger,
  deps: SbisAccountDeps = {},
): Promise<{ value: EdoSbisCheckResult } | CheckFailure> {
  if (!isSbisAccount(account)) {
    return { error: 'provider_not_supported', status: 409, message: 'Учётка не СБИС.' };
  }
  const env = loadEnv();
  const lease = await acquireEdoLease(db, {
    accountId: account.id,
    owner: randomUUID(),
    ttlSeconds: Math.min(env.EDO_POLL_LEASE_SEC, 120),
    requirePollEnabled: false,
  });
  if (!lease) {
    return { error: 'lease_taken', status: 409, message: 'Учётная запись сейчас занята выгрузкой. Повторите через минуту.' };
  }
  try {
    let creds: EdoSbisCredentials;
    try {
      creds = readSbisCredentials(account);
    } catch (err) {
      return { error: 'credentials_unreadable', status: 409, message: `Ключи не читаются: ${err instanceof Error ? err.message : String(err)}` };
    }
    const session = await sbisLogin(deps, creds);
    const list = await sbisClientFor(deps, session).listOurOrganizations();
    const organizations = list.orgs.flatMap((org) => {
      const ref = orgRefOf(org);
      if (!ref) return [];
      return [{ ...ref, ref: formatOrgRef(ref), edo: isYes(org.ДокументооборотПодключен) }];
    });
    await db
      .update(edoAccounts)
      .set({ lastOkAt: new Date(), lastError: null, updatedAt: new Date() })
      .where(eq(edoAccounts.id, account.id));
    return { value: { provider: 'sbis', organizations, complete: list.complete } };
  } catch (err) {
    const failure = describeSbisFailure(err);
    log.warn({ accountId: account.id, error: failure.error }, 'проверка доступа СБИС не прошла');
    await db
      .update(edoAccounts)
      .set({ lastError: failure.message, updatedAt: new Date() })
      .where(eq(edoAccounts.id, account.id));
    return failure;
  } finally {
    await releaseEdoLease(db, lease).catch(() => {});
  }
}
