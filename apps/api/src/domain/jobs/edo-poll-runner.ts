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
import { EdoLeaseLost, inventoryBox } from '../edo/inventory.js';
import {
  EdoExportStopped,
  exportUpdFromBox,
  type ExportPut,
  type ExportSummary,
} from '../edo/export-upd.js';
import {
  acquireEdoLease,
  listPollableEdoAccounts,
  releaseEdoLease,
  renewEdoLease,
  type LeaseHandle,
} from '../edo/poll-lease.js';
import { pollEdoAccount, type EdoPollResult } from './edo-poll.js';

export type EdoRunnerDeps = {
  db: Db;
  log: FastifyBaseLogger;
  /** UUID экземпляра процесса — по нему в логах видно, кто держал лиз. */
  owner: string;
  /** Клиент Диадока — для тестов; по умолчанию настоящий. */
  createClient?: (account: typeof edoAccounts.$inferSelect) => DiadocClient;
};

export type EdoRunOutcome =
  | { skipped: 'lease_taken' | 'lease_lost' | 'no_box' | 'not_found' }
  | { ok: true; detail?: string };

/**
 * Проверка содержимого при осмотре: сотня УПД в память, по одному. Предел
 * времени щедрый — работа идёт в очереди, а не в ожидании браузера, — но
 * конечный: зависший Диадок не должен держать учётку бесконечно.
 */
const CONTENT_CHECK_MAX_DOWNLOADS = 100;
const CONTENT_CHECK_DEADLINE_MS = 10 * 60_000;

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
  opts: { checkContent?: boolean } = {},
): Promise<EdoRunOutcome> {
  const account = await loadAccount(deps.db, accountId);
  if (!account) return { skipped: 'not_found' };
  if (!account.boxId) return { skipped: 'no_box' };

  const result = await withLease(deps, accountId, false, async (lease) => {
    const client = deps.createClient
      ? deps.createClient(account)
      : new DiadocClient({
          auth: createDiadocAuth({ db: deps.db }, account),
          environment: account.environment,
        });
    const from = since ? new Date(since) : account.backfillSince;

    try {
      const ttlSeconds = loadEnv().EDO_POLL_LEASE_SEC;
      const report = await inventoryBox(
        client,
        {
          boxId: account.boxId as string,
          since: from ?? null,
          contentCheck: opts.checkContent
            ? {
                maxDownloads: CONTENT_CHECK_MAX_DOWNLOADS,
                deadlineMs: CONTENT_CHECK_DEADLINE_MS,
                renewLease: () => renewEdoLease(deps.db, lease, ttlSeconds),
              }
            : undefined,
        },
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
        detail: `событий: ${report.eventsSeen}, вложений: ${report.entitiesSeen}${
          report.contentCheck ? `, проверено УПД: ${report.contentCheck.checked}` : ''
        }`,
      };
    } catch (err) {
      // Лиз потерян посреди проверки содержимого: учётку мог взять другой
      // процесс. Отчёт не сохраняем — он неполон, а ошибкой учётки это не
      // является: связь с Диадоком в порядке.
      if (err instanceof EdoLeaseLost) {
        deps.log.warn({ accountId }, 'edo inventory stopped: lease lost');
        return { skipped: 'lease_lost' as const };
      }
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

export type EdoExportOutcome =
  | { skipped: 'lease_taken' | 'no_box' | 'not_found' }
  | { skipped: 'lease_lost'; summary: Readonly<ExportSummary> }
  | { ok: true; summary: ExportSummary };

/**
 * Выгрузка УПД по списку поставщиков в хранилище (скрипт edo-export-upd.ts).
 *
 * Под тем же лизом, что осмотр и опрос: под ним обменивается refresh_token,
 * поэтому выгрузка и любая другая работа по учётке не идут одновременно.
 * Состояние учётной записи (курсор, last_error, отчёт осмотра) не трогается —
 * выгрузка ничего не знает об импорте и не должна на него влиять.
 *
 * Обход, прерванный не потерей лиза, выходит наружу как EdoExportStopped со
 * сводкой: повторный запуск продолжит, а человек видит, сколько успело.
 */
export async function runEdoExport(
  deps: EdoRunnerDeps & { put: ExportPut },
  accountId: string,
  opts: {
    since: Date;
    suppliers: ReadonlyMap<string, string>;
    onPage?: (summary: Readonly<ExportSummary>) => void;
  },
): Promise<EdoExportOutcome> {
  const account = await loadAccount(deps.db, accountId);
  if (!account) return { skipped: 'not_found' };
  if (!account.boxId) return { skipped: 'no_box' };
  const env = loadEnv();

  return withLease(deps, accountId, false, async (lease) => {
    const client = deps.createClient
      ? deps.createClient(account)
      : new DiadocClient({
          auth: createDiadocAuth({ db: deps.db }, account),
          environment: account.environment,
        });
    try {
      const summary = await exportUpdFromBox(
        { db: deps.db, client, log: deps.log, put: deps.put, xmlMaxBytes: env.EDO_XML_MAX_BYTES },
        {
          accountId: account.id,
          boxId: account.boxId as string,
          since: opts.since,
          suppliers: opts.suppliers,
          renewLease: () => renewEdoLease(deps.db, lease, env.EDO_POLL_LEASE_SEC),
          onPage: opts.onPage,
        },
      );
      return { ok: true as const, summary };
    } catch (err) {
      if (err instanceof EdoExportStopped && err.reason instanceof EdoLeaseLost) {
        deps.log.warn({ accountId }, 'edo export stopped: lease lost');
        return { skipped: 'lease_lost' as const, summary: err.summary };
      }
      throw err;
    }
  });
}

/** Ручной проход по кнопке «Синхронизировать»: работает и до включения опроса. */
export async function pollEdoAccountById(
  deps: EdoRunnerDeps,
  accountId: string,
): Promise<EdoPollResult> {
  return pollEdoAccount(
    { db: deps.db, log: deps.log, owner: deps.owner },
    accountId,
    { manual: true },
  );
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
      const result = await pollEdoAccount(
        { db: deps.db, log: deps.log, owner: deps.owner },
        account.id,
      );
      if (result.imported || result.unparsed || result.skipped) {
        deps.log.info({ accountId: account.id, ...result }, 'edo: проход завершён');
      }
    } catch (err) {
      deps.log.warn({ err, accountId: account.id }, 'edo poll failed for account');
    }
  }
}
