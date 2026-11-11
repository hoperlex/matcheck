/**
 * Машинные учётки внешних систем (docs/fin_auth.md §2, «portal-to-portal»).
 *
 * Схема: client_id + секрет → короткий machine JWT (10 минут, без refresh) →
 * Bearer на /api/v1/integration/*. В базе лежит только sha256 секрета: секрет
 * 256-битный случайный, перебор по хешу бессмыслен, bcrypt тут ничего не даёт.
 *
 * Что проверяется на КАЖДОМ запросе с токеном (а не только при выдаче): учётка
 * активна и не отозвана, поколение секрета совпадает с claim gen, адрес входит в
 * разрешённые сети. Поэтому отзыв и ротация действуют мгновенно, а не через
 * 10 минут жизни уже выданного токена.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { authEvents, serviceAccounts } from '../../db/schema.js';
import { sha256Hex } from './crypto.js';
import {
  MACHINE_TOKEN_TTL_SECONDS,
  signMachineToken,
  verifyMachineToken,
} from './jwt.js';

export const SCOPE_ONEC_READ = 'onec.deliveries:read';
export const SCOPE_ONEC_ACK = 'onec.deliveries:ack';
export const KNOWN_SCOPES = [SCOPE_ONEC_READ, SCOPE_ONEC_ACK] as const;

export type ServicePrincipal = {
  id: string;
  clientId: string;
  scopes: string[];
};

/** Новый секрет: 256 бит, префикс помогает узнать его в утечке и в сканерах. */
export function generateClientSecret(): string {
  return `mcs_${randomBytes(32).toString('base64url')}`;
}

export function hashClientSecret(secret: string): string {
  return sha256Hex(secret);
}

// Хеш, с которым сравнивается секрет неизвестного client_id: сравнение идёт
// всегда, и по времени ответа нельзя понять, существует ли учётка.
const DUMMY_HASH = sha256Hex('matcheck:no-such-client');

function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== 32 || bb.length !== 32) return false;
  return timingSafeEqual(ba, bb);
}

/** Запись сети «адрес[/биты]»; null — не разбирается. */
export function parseCidr(raw: string): { net: string; bits: number; family: 'ipv4' | 'ipv6' } | null {
  const [net, bitsRaw, extra] = raw.trim().split('/');
  if (!net || extra !== undefined) return null;
  const netFamily = isIP(net);
  if (netFamily === 0) return null;
  const max = netFamily === 4 ? 32 : 128;
  if (bitsRaw !== undefined && !/^\d{1,3}$/.test(bitsRaw)) return null;
  const bits = bitsRaw === undefined ? max : Number(bitsRaw);
  if (bits < 0 || bits > max) return null;
  return { net, bits, family: netFamily === 4 ? 'ipv4' : 'ipv6' };
}

/**
 * Адрес в разрешённых сетях. NULL/пустой список — без ограничения.
 *
 * IPv4, пришедший как IPv4-mapped IPv6 (`::ffff:1.2.3.4`), сравнивается как
 * IPv4: так его отдаёт Node при dual-stack сокете. Неразборчивая запись CIDR —
 * отказ, а не «пропустить»: ошибка в настройке не должна открывать доступ.
 */
export function ipAllowed(ip: string, cidrs: readonly string[] | null): boolean {
  if (!cidrs || cidrs.length === 0) return true;
  const addr = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const family = isIP(addr);
  if (family === 0) return false;
  const list = new BlockList();
  for (const raw of cidrs) {
    const cidr = parseCidr(raw);
    if (!cidr) return false;
    list.addSubnet(cidr.net, cidr.bits, cidr.family);
  }
  return list.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}

export type IssueTokenInput = {
  clientId: string;
  clientSecret: string;
  ip: string;
  userAgent: string | null;
};

export type IssueTokenResult =
  | { ok: true; accessToken: string; expiresIn: number; scopes: string[] }
  | { ok: false; reason: 'invalid_client' | 'inactive' | 'network' };

/**
 * Выдача machine-токена. Наружу любая неудача — одна ошибка invalid_client;
 * reason нужен журналу (auth_events), не ответу.
 */
export async function issueMachineToken(db: Db, input: IssueTokenInput): Promise<IssueTokenResult> {
  const [account] = await db
    .select()
    .from(serviceAccounts)
    .where(eq(serviceAccounts.clientId, input.clientId))
    .limit(1);
  const secretOk = hashesEqual(
    hashClientSecret(input.clientSecret),
    account?.secretHash ?? DUMMY_HASH,
  );

  let result: IssueTokenResult;
  if (!account || !secretOk) {
    result = { ok: false, reason: 'invalid_client' };
  } else if (!account.isActive || account.revokedAt) {
    result = { ok: false, reason: 'inactive' };
  } else if (!ipAllowed(input.ip, account.allowedCidrs)) {
    result = { ok: false, reason: 'network' };
  } else {
    const accessToken = await signMachineToken({
      sub: account.id,
      scopes: account.scopes,
      gen: account.secretGeneration,
    });
    await db
      .update(serviceAccounts)
      .set({ lastTokenAt: new Date(), lastTokenIp: input.ip.slice(0, 64) })
      .where(eq(serviceAccounts.id, account.id));
    result = {
      ok: true,
      accessToken,
      expiresIn: MACHINE_TOKEN_TTL_SECONDS,
      scopes: account.scopes,
    };
  }

  // Аудит выдачи — требование fin_auth. client_id пишем только для
  // существующей учётки: перебор чужих имён не должен забивать журнал мусором,
  // но и следа «кто-то стучался» достаточно (ip + причина).
  try {
    await db.insert(authEvents).values({
      userId: null,
      event: result.ok ? 'machine_token_issued' : 'machine_token_denied',
      ip: input.ip.slice(0, 64),
      userAgent: input.userAgent,
      meta: {
        clientId: account ? account.clientId : null,
        ...(result.ok ? {} : { reason: result.reason }),
      },
    });
  } catch {
    // Журнал не должен ронять выдачу; отказ записи виден в логах БД.
  }
  return result;
}

/**
 * Принципал по Bearer-токену. null — любой отказ (подпись, срок, audience, тип,
 * учётка неактивна или отозвана, сменилось поколение секрета, чужая сеть).
 */
export async function resolveServicePrincipal(
  db: Db,
  token: string,
  ip: string,
): Promise<ServicePrincipal | null> {
  let claims;
  try {
    claims = await verifyMachineToken(token);
  } catch {
    return null;
  }
  const [account] = await db
    .select({
      id: serviceAccounts.id,
      clientId: serviceAccounts.clientId,
      scopes: serviceAccounts.scopes,
      isActive: serviceAccounts.isActive,
      revokedAt: serviceAccounts.revokedAt,
      secretGeneration: serviceAccounts.secretGeneration,
      allowedCidrs: serviceAccounts.allowedCidrs,
    })
    .from(serviceAccounts)
    .where(eq(serviceAccounts.id, claims.sub))
    .limit(1);
  if (!account || !account.isActive || account.revokedAt) return null;
  if (account.secretGeneration !== claims.gen) return null;
  if (!ipAllowed(ip, account.allowedCidrs)) return null;
  // Права — пересечение выданного в токене и текущего у учётки: сужение прав
  // учётки действует сразу, не дожидаясь истечения токена.
  const current = new Set(account.scopes);
  return {
    id: account.id,
    clientId: account.clientId,
    scopes: claims.scopes.filter((s) => current.has(s)),
  };
}
