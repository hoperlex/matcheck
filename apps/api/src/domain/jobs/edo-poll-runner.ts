/**
 * Обход учётных записей ЭДО: точка входа и для расписания, и для кнопки.
 *
 * Логика живёт здесь, а не в процессе-воркере, сознательно: сегодня опрос
 * крутится внутри mail-worker (опрос Диадока — это несколько HTTP-запросов и
 * небольшой XML, отдельный контейнер ради такой нагрузки завести проще, чем
 * оправдать — сервер уже уходит в swap). Если поток вырастет, вынос в свой
 * процесс сведётся к новому файлу запуска, а не к переписыванию.
 */
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/client.js';
import { edoAccounts } from '../../db/schema.js';
import { loadEnv } from '../../lib/env.js';
import { createDiadocAuth } from '../edo/diadoc.auth.js';
import { DiadocClient } from '../edo/diadoc.client.js';
import { inventoryBox } from '../edo/inventory.js';
import {
  acquireEdoLease,
  listPollableEdoAccounts,
  releaseEdoLease,
  type LeaseHandle,
} from '../edo/poll-lease.js';

export type EdoRunnerDeps = {
  db: Db;
  log: FastifyBaseLogger;
  /** UUID экземпляра процесса — по нему в логах видно, кто держал лиз. */
  owner: string;
};

export type EdoRunOutcome =
  | { skipped: 'lease_taken' | 'no_box' | 'not_found' }
  | { ok: true; detail?: string };

/**
 * Учётная запись без выбранного ящика опрашиваться не может: boxId — часть
 * каждого запроса. Это не ошибка, а «ещё не настроено», поэтому отдельный
 * исход, а не исключение.
 */
async function loadAccount(db: Db, accountId: string) {
  const [row] = await db.select().from(edoAccounts).where(eq(edoAccounts.id, accountId)).limit(1);
  return row ?? null;
}

async function withLease<T>(
  deps: EdoRunnerDeps,
  accountId: string,
  requirePollEnabled: boolean,
  fn: (lease: LeaseHandle) => Promise<T>,
): Promise<T | { skipped: 'lease_taken' }> {
  const lease = await acquireEdoLease(deps.db, {
    accountId,
    owner: deps.owner,
    ttlSeconds: loadEnv().EDO_POLL_LEASE_SEC,
    requirePollEnabled,
  });
  if (!lease) return { skipped: 'lease_taken' };
  try {
    return await fn(lease);
  } finally {
    await releaseEdoLease(deps.db, lease).catch(() => {});
  }
}

/**
 * Разведка ящика по кнопке.
 *
 * Идёт под лизом, как и всё остальное: под ним обменивается refresh_token, а
 * два параллельных обмена оставили бы одного из участников с отозванным
 * токеном.
 */
export async function runEdoInventory(
  deps: EdoRunnerDeps,
  accountId: string,
  since?: string,
): Promise<EdoRunOutcome> {
  const account = await loadAccount(deps.db, accountId);
  if (!account) return { skipped: 'not_found' };
  if (!account.boxId) return { skipped: 'no_box' };

  const result = await withLease(deps, accountId, false, async () => {
    const auth = createDiadocAuth({ db: deps.db }, account);
    const client = new DiadocClient({ auth, environment: account.environment });
    const from = since ? new Date(since) : account.backfillSince;

    try {
      const report = await inventoryBox(
        client,
        { boxId: account.boxId as string, since: from ?? null },
        deps.log,
      );
      await deps.db
        .update(edoAccounts)
        .set({
          lastInventory: report,
          lastInventoryAt: new Date(),
          lastOkAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(edoAccounts.id, account.id));
      return {
        ok: true as const,
        detail: `событий: ${report.eventsSeen}, вложений: ${report.entitiesSeen}`,
      };
    } catch (err) {
      // Текст ошибки виден администратору в админке, поэтому он без тел
      // ответов и внутренних деталей.
      const message = err instanceof Error ? err.message : 'разведка не удалась';
      deps.log.warn({ err, accountId }, 'edo inventory failed');
      await deps.db
        .update(edoAccounts)
        .set({ lastError: message, updatedAt: new Date() })
        .where(eq(edoAccounts.id, account.id));
      throw err;
    }
  });

  return result;
}

/**
 * Обход всех включённых учётных записей.
 *
 * Ошибка одной не останавливает остальные: ящики независимы, и падение из-за
 * чужой просроченной подписки было бы худшим видом связности.
 */
export async function pollAllEdoAccounts(deps: EdoRunnerDeps): Promise<void> {
  const accounts = await listPollableEdoAccounts(deps.db);
  for (const account of accounts) {
    try {
      // Сам проход по ленте появится вместе с журналом событий (Э3).
      // До тех пор обход существует, чтобы расписание и рубильники можно было
      // включить и проверить отдельно от импорта.
      deps.log.debug({ accountId: account.id }, 'edo poll: account ready');
    } catch (err) {
      deps.log.warn({ err, accountId: account.id }, 'edo poll failed for account');
    }
  }
}
