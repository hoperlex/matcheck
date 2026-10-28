import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { and, count, eq, inArray, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  estimatSupplierOrderEvents,
  estimatSupplierOrders,
  estimatSyncRuns,
  sites,
  type EstimatSyncTrigger,
} from '../../db/schema.js';
import { redact } from '../edo/sbis/sbis.http.js';
import type { EstimatConfig } from './config.js';
import {
  createEstimatClient,
  EstimatAborted,
  EstimatAuthError,
  EstimatCursorError,
  EstimatError,
  type EstimatClient,
  type EstimatClientOptions,
} from './estimat.http.js';
import type { EstimatCapabilities, ParsedOrder } from './estimat.types.js';
import { parseOrderRow } from './estimat.types.js';
import { diffOrder, matchSite, type OrderEventDraft, type SiteRef } from './order-diff.js';

/**
 * Полный обход заказов поставщикам EstiMat.
 *
 * Дельты в API нет: каждый обход читает все страницы и пишет заказы upsert'ом по
 * id. Полный обход нужен ещё и затем, чтобы заметить удалённые заказы, — и это
 * единственное разрушительное действие здесь, поэтому оно обставлено условиями:
 * обход дошёл до конца без рестарта, а полнота доступа токена подтверждена
 * ответами /capabilities до и после обхода (§2 п. 6 плана).
 */

/** Сколько ждать признаков жизни обхода, прежде чем считать его брошенным. */
const STALE_RUN_MINUTES = 30;
const MAX_RESTARTS = 2;
const MAX_PAGES = 5000;
const RUN_RETENTION_DAYS = 90;
/** Страховка от сбоя на стороне EstiMat: столько пропавших сразу — подозрительно. */
const MASS_DISAPPEARANCE_MIN = 20;
const MASS_DISAPPEARANCE_SHARE = 0.1;

/** Другой процесс счёл обход зависшим и закрыл его строку — писать больше нельзя. */
export class EstimatRunLost extends Error {
  constructor() {
    super('строка обхода EstiMat закрыта другим процессом');
    this.name = 'EstimatRunLost';
  }
}

export type EstimatSyncReport = {
  /** Обход завершился ошибкой (в т.ч. отказ токена). */
  onError?: (result: EstimatSyncFinished) => void;
  /** Подозрительная ситуация без ошибки: массовое исчезновение, битые строки. */
  onWarning?: (code: string, message: string, extra?: Record<string, unknown>) => void;
};

export type EstimatSyncDeps = {
  db: Db;
  log: FastifyBaseLogger;
  config: EstimatConfig;
  signal?: AbortSignal;
  /** Для тестов: клиент с подставным fetch. */
  createClient?: (opts: EstimatClientOptions) => EstimatClient;
  report?: EstimatSyncReport;
};

export type EstimatSyncOptions = {
  trigger: EstimatSyncTrigger;
  userId?: string | null;
  /** Разовое снятие предохранителя массового исчезновения (scripts/estimat-sync.ts). */
  acceptDeletions?: boolean;
};

export type EstimatSyncCounters = {
  pages: number;
  ordersSeen: number;
  inserted: number;
  updated: number;
  approvalChanges: number;
  statusChanges: number;
  markedDeleted: number;
  restored: number;
  invalidRows: number;
  invalidRowsNoId: number;
  restarts: number;
  unmatchedSites: number;
};

export type EstimatSyncFinished = {
  runId: string;
  outcome: 'completed' | 'error' | 'stopped';
  counters: EstimatSyncCounters;
  durationMs: number;
  errorCode: string | null;
  errorMessage: string | null;
  requestId: string | null;
  deletionSkippedReason: string | null;
  cause?: unknown;
};

export type EstimatSyncResult =
  | { skipped: 'disabled'; reason: string }
  | { skipped: 'already_running' }
  | { skipped: 'auth_blocked'; runId: string }
  | { skipped: 'run_lost'; runId: string }
  | EstimatSyncFinished;

/** Коды, после которых автообход останавливается до смены токена или ручного запуска. */
export function isAuthErrorCode(code: string | null): boolean {
  if (!code) return false;
  return code.startsWith('api_token_') || code === 'insufficient_scope' || code === 'http_401' || code === 'http_403';
}

function pgCode(err: unknown): string | null {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

function emptyCounters(): EstimatSyncCounters {
  return {
    pages: 0,
    ordersSeen: 0,
    inserted: 0,
    updated: 0,
    approvalChanges: 0,
    statusChanges: 0,
    markedDeleted: 0,
    restored: 0,
    invalidRows: 0,
    invalidRowsNoId: 0,
    restarts: 0,
    unmatchedSites: 0,
  };
}

const APPROVAL_KINDS = new Set(['approved', 'approval_revoked', 'reapproved']);

/** Колонки, которые upsert переписывает у существующего заказа. first_seen_at не трогается. */
const UPSERT_SET = {
  orderNo: sql`excluded.order_no`,
  subNo: sql`excluded.sub_no`,
  estimatProjectId: sql`excluded.estimat_project_id`,
  projectCode: sql`excluded.project_code`,
  projectName: sql`excluded.project_name`,
  siteId: sql`excluded.site_id`,
  contractors: sql`excluded.contractors`,
  supplierName: sql`excluded.supplier_name`,
  supplierInn: sql`excluded.supplier_inn`,
  amount: sql`excluded.amount`,
  sourcingStatus: sql`excluded.sourcing_status`,
  procurementMethod: sql`excluded.procurement_method`,
  acquisitionType: sql`excluded.acquisition_type`,
  contractNumber: sql`excluded.contract_number`,
  contractDate: sql`excluded.contract_date`,
  awardedAt: sql`excluded.awarded_at`,
  supplyApprovedAt: sql`excluded.supply_approved_at`,
  estimatCreatedAt: sql`excluded.estimat_created_at`,
  estimatUpdatedAt: sql`excluded.estimat_updated_at`,
  raw: sql`excluded.raw`,
  lastSeenAt: sql`now()`,
  lastSeenPassId: sql`excluded.last_seen_pass_id`,
  deletedAt: sql`null`,
};

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Первый оператор каждой транзакции обхода: жив ли ещё наш обход. */
async function touchRun(tx: Tx | Db, runId: string): Promise<void> {
  const rows = await tx
    .update(estimatSyncRuns)
    .set({ heartbeatAt: sql`now()` })
    .where(and(eq(estimatSyncRuns.id, runId), eq(estimatSyncRuns.outcome, 'running')))
    .returning({ id: estimatSyncRuns.id });
  if (rows.length === 0) throw new EstimatRunLost();
}

function countersSet(c: EstimatSyncCounters) {
  return {
    pages: c.pages,
    ordersSeen: c.ordersSeen,
    inserted: c.inserted,
    updated: c.updated,
    approvalChanges: c.approvalChanges,
    statusChanges: c.statusChanges,
    markedDeleted: c.markedDeleted,
    restored: c.restored,
    invalidRows: c.invalidRows,
    invalidRowsNoId: c.invalidRowsNoId,
    restarts: c.restarts,
    unmatchedSites: c.unmatchedSites,
  };
}

/**
 * Записать одну страницу. Транзакция: heartbeat с проверкой, что обход ещё наш →
 * текущее состояние заказов страницы → upsert → события журнала → счётчики.
 */
async function writePage(
  db: Db,
  ctx: { runId: string; passId: string; sites: readonly SiteRef[]; log: FastifyBaseLogger; unmatchedCodes: Set<string> },
  rows: unknown[],
  c: EstimatSyncCounters,
): Promise<void> {
  const byId = new Map<string, ParsedOrder>();
  const invalidIds = new Set<string>();
  for (const raw of rows) {
    const parsed = parseOrderRow(raw);
    if (parsed.ok) {
      byId.set(parsed.order.id, parsed.order);
      continue;
    }
    if (parsed.id) {
      c.invalidRows++;
      invalidIds.add(parsed.id);
    } else {
      c.invalidRowsNoId++;
    }
    ctx.log.warn({ runId: ctx.runId, orderId: parsed.id, issue: parsed.issue }, 'estimat sync: строка заказа не разобрана');
  }
  for (const id of byId.keys()) invalidIds.delete(id);
  c.ordersSeen += byId.size + invalidIds.size;

  await db.transaction(async (tx) => {
    await touchRun(tx, ctx.runId);

    const ids = [...byId.keys(), ...invalidIds];
    const existing = ids.length
      ? await tx
          .select({
            id: estimatSupplierOrders.id,
            supplyApprovedAt: estimatSupplierOrders.supplyApprovedAt,
            sourcingStatus: estimatSupplierOrders.sourcingStatus,
            deletedAt: estimatSupplierOrders.deletedAt,
          })
          .from(estimatSupplierOrders)
          .where(inArray(estimatSupplierOrders.id, ids))
          .for('no key update')
      : [];
    const prevById = new Map(existing.map((r) => [r.id, r]));
    const existingIds = existing.map((r) => r.id);
    const approvedBefore = new Set(
      existingIds.length
        ? (
            await tx
              .selectDistinct({ orderId: estimatSupplierOrderEvents.orderId })
              .from(estimatSupplierOrderEvents)
              .where(
                and(
                  inArray(estimatSupplierOrderEvents.orderId, existingIds),
                  inArray(estimatSupplierOrderEvents.kind, ['approved', 'reapproved']),
                ),
              )
          ).map((r) => r.orderId)
        : [],
    );

    const values: (typeof estimatSupplierOrders.$inferInsert)[] = [];
    const events: (typeof estimatSupplierOrderEvents.$inferInsert)[] = [];
    const push = (orderId: string, drafts: OrderEventDraft[]) => {
      for (const d of drafts) events.push({ ...d, orderId, runId: ctx.runId });
    };

    for (const o of byId.values()) {
      const site = matchSite(o.projectCode, ctx.sites);
      if (site.status === 'not_found' || site.status === 'ambiguous') {
        c.unmatchedSites++;
        ctx.unmatchedCodes.add(`${o.projectCode} (${site.status === 'ambiguous' ? 'неоднозначен' : 'не найден'})`);
      }
      values.push({
        id: o.id,
        orderNo: o.orderNo,
        subNo: o.subNo,
        estimatProjectId: o.projectId,
        projectCode: o.projectCode,
        projectName: o.projectName,
        siteId: site.siteId,
        contractors: o.contractors,
        supplierName: o.supplierName,
        supplierInn: o.supplierInn,
        amount: o.amount,
        sourcingStatus: o.sourcingStatus,
        procurementMethod: o.procurementMethod,
        acquisitionType: o.acquisitionType,
        contractNumber: o.contractNumber,
        contractDate: o.contractDate,
        awardedAt: o.awardedAt,
        supplyApprovedAt: o.supplyApprovedAt,
        estimatCreatedAt: o.createdAt,
        estimatUpdatedAt: o.updatedAt,
        raw: o.raw,
        lastSeenPassId: ctx.passId,
      });
      const prev = prevById.get(o.id) ?? null;
      const drafts = diffOrder(prev, o, approvedBefore.has(o.id));
      push(o.id, drafts);
      if (prev) {
        c.updated++;
        if (drafts.some((d) => APPROVAL_KINDS.has(d.kind))) c.approvalChanges++;
        if (drafts.some((d) => d.kind === 'status_changed')) c.statusChanges++;
        if (drafts.some((d) => d.kind === 'restored')) c.restored++;
      } else {
        c.inserted++;
      }
    }

    if (values.length) {
      await tx
        .insert(estimatSupplierOrders)
        .values(values)
        .onConflictDoUpdate({ target: estimatSupplierOrders.id, set: UPSERT_SET });
    }

    // Битая строка с валидным id: заказ в EstiMat есть — отмечаем увиденным, но
    // данных не трогаем (их нечем заменить). Помеченный удалённым — возвращаем.
    const invalidKnown = [...invalidIds].filter((id) => prevById.has(id));
    if (invalidKnown.length) {
      for (const id of invalidKnown) {
        const prev = prevById.get(id)!;
        if (prev.deletedAt) {
          c.restored++;
          push(id, [{ kind: 'restored', fromValue: prev.deletedAt.toISOString(), toValue: null, details: null }]);
        }
      }
      await tx
        .update(estimatSupplierOrders)
        .set({ lastSeenPassId: ctx.passId, lastSeenAt: sql`now()`, deletedAt: null })
        .where(inArray(estimatSupplierOrders.id, invalidKnown));
    }

    if (events.length) await tx.insert(estimatSupplierOrderEvents).values(events);

    c.pages++;
    await tx.update(estimatSyncRuns).set(countersSet(c)).where(eq(estimatSyncRuns.id, ctx.runId));
  });
}

async function safeCapabilities(
  client: EstimatClient,
  log: FastifyBaseLogger,
  runId: string,
): Promise<EstimatCapabilities | null> {
  try {
    return await client.capabilities();
  } catch (err) {
    // Отказ токена — это ошибка обхода, а не «доступ не подтверждён».
    if (err instanceof EstimatAuthError || err instanceof EstimatAborted) throw err;
    log.warn({ runId, err: err instanceof Error ? err.message : String(err) }, 'estimat sync: /capabilities не ответил');
    return null;
  }
}

function assertPurchasesRead(caps: EstimatCapabilities): void {
  if (!caps.scopes.includes('purchases:read')) {
    throw new EstimatAuthError('insufficient_scope', 'токену EstiMat не выдано право purchases:read');
  }
}

/**
 * Пометка удалённых и закрытие обхода — одна транзакция под блокировкой строки
 * обхода: если её успел закрыть другой процесс, ничего не пишем.
 */
async function finishCompleted(
  deps: EstimatSyncDeps,
  ctx: { runId: string; passId: string },
  c: EstimatSyncCounters,
  scope: { before: EstimatCapabilities | null; after: EstimatCapabilities | null },
  acceptDeletions: boolean,
): Promise<string | null> {
  let reason: string | null = null;
  if (!scope.before || !scope.after) reason = 'scope_unconfirmed';
  else if (!scope.after.scopes.includes('purchases:read') || scope.before.projectId !== scope.after.projectId) {
    reason = 'scope_changed';
  } else if (c.invalidRowsNoId > 0) reason = 'invalid_rows_no_id';
  const scopeConfirmed = reason !== 'scope_unconfirmed' && reason !== 'scope_changed';

  await deps.db.transaction(async (tx) => {
    const [run] = await tx
      .select({ outcome: estimatSyncRuns.outcome })
      .from(estimatSyncRuns)
      .where(eq(estimatSyncRuns.id, ctx.runId))
      .for('update');
    if (!run || run.outcome !== 'running') throw new EstimatRunLost();

    if (reason === null) {
      // В пределах подтверждённого доступа: суженный токен не видит чужих
      // объектов и заказов без объекта — их отсутствие ничего не значит.
      const projectId = scope.before!.projectId;
      const within: SQL[] = [isNull(estimatSupplierOrders.deletedAt)];
      if (projectId) within.push(eq(estimatSupplierOrders.estimatProjectId, projectId));
      const candidates = await tx
        .select({ id: estimatSupplierOrders.id, sourcingStatus: estimatSupplierOrders.sourcingStatus })
        .from(estimatSupplierOrders)
        .where(and(...within, ne(estimatSupplierOrders.lastSeenPassId, ctx.passId)));
      const [live] = await tx.select({ n: count() }).from(estimatSupplierOrders).where(and(...within));
      const liveCount = Number(live?.n ?? 0);
      if (
        !acceptDeletions &&
        candidates.length > MASS_DISAPPEARANCE_MIN &&
        candidates.length > liveCount * MASS_DISAPPEARANCE_SHARE
      ) {
        reason = 'mass_disappearance';
        deps.report?.onWarning?.(
          'mass_disappearance',
          `EstiMat: из полного обхода пропали ${candidates.length} из ${liveCount} заказов — удалёнными не помечены`,
          { runId: ctx.runId, missing: candidates.length, live: liveCount },
        );
      } else if (candidates.length) {
        const ids = candidates.map((r) => r.id);
        await tx
          .update(estimatSupplierOrders)
          .set({ deletedAt: sql`now()` })
          .where(inArray(estimatSupplierOrders.id, ids));
        await tx.insert(estimatSupplierOrderEvents).values(
          candidates.map((r) => ({
            orderId: r.id,
            kind: 'deleted' as const,
            fromValue: r.sourcingStatus,
            toValue: null,
            runId: ctx.runId,
          })),
        );
        c.markedDeleted = ids.length;
      }
    }

    await tx
      .update(estimatSyncRuns)
      .set({
        ...countersSet(c),
        outcome: 'completed',
        finishedAt: sql`now()`,
        heartbeatAt: sql`now()`,
        scopeConfirmed,
        tokenProjectId: scope.before?.projectId ?? null,
        deletionSkippedReason: reason,
      })
      .where(eq(estimatSyncRuns.id, ctx.runId));
  });
  return reason;
}

async function finishFailed(
  db: Db,
  runId: string,
  c: EstimatSyncCounters,
  outcome: 'error' | 'stopped',
  fields: { errorCode: string; errorMessage: string; requestId: string | null },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ outcome: estimatSyncRuns.outcome })
      .from(estimatSyncRuns)
      .where(eq(estimatSyncRuns.id, runId))
      .for('update');
    if (!run || run.outcome !== 'running') return false;
    await tx
      .update(estimatSyncRuns)
      .set({ ...countersSet(c), outcome, finishedAt: sql`now()`, ...fields })
      .where(eq(estimatSyncRuns.id, runId));
    return true;
  });
}

export async function runEstimatSync(deps: EstimatSyncDeps, opts: EstimatSyncOptions): Promise<EstimatSyncResult> {
  const { db, log, config } = deps;
  if (!config.ok) return { skipped: 'disabled', reason: config.reason };

  // Брошенный обход (процесс убили) — закрываем, иначе новый не стартует.
  await db
    .update(estimatSyncRuns)
    .set({
      outcome: 'error',
      errorCode: 'run_lost',
      errorMessage: `прервано: обход не подавал признаков жизни ${STALE_RUN_MINUTES} мин`,
      finishedAt: sql`now()`,
    })
    .where(
      and(
        eq(estimatSyncRuns.outcome, 'running'),
        lt(estimatSyncRuns.heartbeatAt, sql`now() - ${sql.raw(`interval '${STALE_RUN_MINUTES} minutes'`)}`),
      ),
    );

  if (opts.trigger === 'auto') {
    const [last] = await db
      .select({ errorCode: estimatSyncRuns.errorCode, tokenFingerprint: estimatSyncRuns.tokenFingerprint })
      .from(estimatSyncRuns)
      .where(inArray(estimatSyncRuns.outcome, ['completed', 'error', 'stopped']))
      .orderBy(sql`${estimatSyncRuns.startedAt} desc`)
      .limit(1);
    if (last && isAuthErrorCode(last.errorCode) && last.tokenFingerprint === config.fingerprint) {
      const [row] = await db
        .insert(estimatSyncRuns)
        .values({
          trigger: 'auto',
          outcome: 'skipped',
          finishedAt: sql`now()`,
          errorCode: 'auth_blocked',
          errorMessage: `токен EstiMat отклонён (${last.errorCode}) — автообход остановлен до смены токена или ручного «Обновить»`,
          tokenFingerprint: config.fingerprint,
        })
        .returning({ id: estimatSyncRuns.id });
      return { skipped: 'auth_blocked', runId: row!.id };
    }
  }

  let runId: string;
  let passId: string;
  try {
    const [row] = await db
      .insert(estimatSyncRuns)
      .values({
        trigger: opts.trigger,
        triggeredByUserId: opts.userId ?? null,
        tokenFingerprint: config.fingerprint,
      })
      .returning({ id: estimatSyncRuns.id, passId: estimatSyncRuns.currentPassId });
    runId = row!.id;
    passId = row!.passId;
  } catch (err) {
    if (pgCode(err) === '23505') return { skipped: 'already_running' };
    throw err;
  }

  const startedAt = Date.now();
  const c = emptyCounters();
  const unmatchedCodes = new Set<string>();
  const client = (deps.createClient ?? createEstimatClient)({
    baseUrl: config.baseUrl,
    token: config.token,
    signal: deps.signal,
    onWait: async (ms, reason) => {
      log.info({ runId, waitMs: ms, reason }, 'estimat sync: пауза перед повтором');
      await touchRun(db, runId);
    },
  });

  try {
    const before = await safeCapabilities(client, log, runId);
    if (before) {
      assertPurchasesRead(before);
      await db.update(estimatSyncRuns).set({ tokenProjectId: before.projectId }).where(eq(estimatSyncRuns.id, runId));
    }
    const siteRows = await db.select({ id: sites.id, code: sites.code }).from(sites);

    // Попытка обхода. Рестарт с первой страницы получает новый id попытки:
    // заказ, встреченный только в брошенной попытке, не считается увиденным.
    for (;;) {
      let cursor: string | null = null;
      const seenCursors = new Set<string>();
      let restart = false;
      c.pages = 0;
      c.ordersSeen = 0;
      c.invalidRows = 0;
      c.invalidRowsNoId = 0;
      c.unmatchedSites = 0;
      unmatchedCodes.clear();

      for (;;) {
        let page;
        try {
          page = await client.listSupplierOrders(cursor);
        } catch (err) {
          if (err instanceof EstimatCursorError) {
            restart = true;
            break;
          }
          throw err;
        }
        if (cursor !== null && page.meta.warnings?.some((w) => w.startsWith('cursor_ignored'))) {
          // EstiMat не учёл курсор и отдал ПЕРВУЮ страницу — читать её дальше
          // значило бы перепутать страницы.
          restart = true;
          break;
        }
        await writePage(db, { runId, passId, sites: siteRows, log, unmatchedCodes }, page.data, c);
        const next = page.meta.nextCursor;
        if (next === null) break;
        if (next === cursor || seenCursors.has(next)) {
          throw new EstimatError('cursor_loop', 'EstiMat вернул уже пройденный курсор — обход остановлен');
        }
        if (c.pages >= MAX_PAGES) {
          throw new EstimatError('too_many_pages', `обход EstiMat превысил ${MAX_PAGES} страниц`);
        }
        seenCursors.add(next);
        cursor = next;
      }

      if (!restart) break;
      c.restarts++;
      if (c.restarts > MAX_RESTARTS) {
        throw new EstimatError('cursor_restarts', `EstiMat ${c.restarts} раза не принял курсор — обход остановлен`);
      }
      passId = randomUUID();
      const rows = await db
        .update(estimatSyncRuns)
        .set({ currentPassId: passId, restarts: c.restarts, heartbeatAt: sql`now()` })
        .where(and(eq(estimatSyncRuns.id, runId), eq(estimatSyncRuns.outcome, 'running')))
        .returning({ id: estimatSyncRuns.id });
      if (rows.length === 0) throw new EstimatRunLost();
      log.warn({ runId, restarts: c.restarts }, 'estimat sync: курсор не принят — обход заново');
    }

    if (c.invalidRows + c.invalidRowsNoId > 0) {
      deps.report?.onWarning?.(
        'invalid_rows',
        `EstiMat: ${c.invalidRows + c.invalidRowsNoId} строк заказов не разобраны`,
        { runId, invalidRows: c.invalidRows, invalidRowsNoId: c.invalidRowsNoId },
      );
    }
    const after = await safeCapabilities(client, log, runId);
    const reason = await finishCompleted(deps, { runId, passId }, c, { before, after }, opts.acceptDeletions === true);

    const durationMs = Date.now() - startedAt;
    log.info(
      { runId, trigger: opts.trigger, durationMs, ...c, deletionSkippedReason: reason, unmatchedCodes: [...unmatchedCodes].slice(0, 50) },
      'estimat sync: обход завершён',
    );
    await cleanupOldRuns(db);
    return {
      runId,
      outcome: 'completed',
      counters: c,
      durationMs,
      errorCode: null,
      errorMessage: null,
      requestId: null,
      deletionSkippedReason: reason,
    };
  } catch (err) {
    if (err instanceof EstimatRunLost) {
      log.warn({ runId }, 'estimat sync: строку обхода закрыл другой процесс — запись прекращена');
      return { skipped: 'run_lost', runId };
    }
    const outcome = err instanceof EstimatAborted ? 'stopped' : 'error';
    const errorCode = err instanceof EstimatError ? err.code : outcome === 'stopped' ? 'stopped' : 'internal';
    const requestId = err instanceof EstimatError ? err.requestId : null;
    const errorMessage = redact(err instanceof Error ? err.message : String(err), [config.token]).slice(0, 1000);
    const written = await finishFailed(db, runId, c, outcome, { errorCode, errorMessage, requestId }).catch(
      (writeErr: unknown) => {
        log.error({ runId, err: writeErr }, 'estimat sync: не удалось записать исход обхода');
        return false;
      },
    );
    const durationMs = Date.now() - startedAt;
    log.warn({ runId, outcome, errorCode, requestId, durationMs, written, ...c }, `estimat sync: ${errorMessage}`);
    const result: EstimatSyncFinished = {
      runId,
      outcome,
      counters: c,
      durationMs,
      errorCode,
      errorMessage,
      requestId,
      deletionSkippedReason: null,
      cause: err,
    };
    if (outcome === 'error') deps.report?.onError?.(result);
    return result;
  }
}

async function cleanupOldRuns(db: Db): Promise<void> {
  await db
    .delete(estimatSyncRuns)
    .where(
      and(
        ne(estimatSyncRuns.outcome, 'running'),
        lt(estimatSyncRuns.startedAt, sql`now() - ${sql.raw(`interval '${RUN_RETENTION_DAYS} days'`)}`),
      ),
    );
}

export type EstimatDryRunReport = {
  orders: number;
  pages: number;
  byStage: Record<string, number>;
  approved: number;
  invalidRows: number;
  unmatchedCodes: Record<string, number>;
  ambiguousCodes: Record<string, number>;
  /** «СОБ6.1 → СОБ61»: совпало только без точек и пробелов — проверить глазами. */
  compactMatches: Record<string, number>;
  noCode: number;
};

/** Обход без записи — для первой проверки токена (scripts/estimat-sync.ts --dry-run). */
export async function estimatDryRun(client: EstimatClient, siteRows: readonly SiteRef[]): Promise<EstimatDryRunReport> {
  const report: EstimatDryRunReport = {
    orders: 0,
    pages: 0,
    byStage: {},
    approved: 0,
    invalidRows: 0,
    unmatchedCodes: {},
    ambiguousCodes: {},
    compactMatches: {},
    noCode: 0,
  };
  const codeById = new Map(siteRows.map((s) => [s.id, s.code]));
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (;;) {
    const page = await client.listSupplierOrders(cursor);
    report.pages++;
    for (const raw of page.data) {
      const parsed = parseOrderRow(raw);
      if (!parsed.ok) {
        report.invalidRows++;
        continue;
      }
      const o = parsed.order;
      report.orders++;
      report.byStage[o.sourcingStatus] = (report.byStage[o.sourcingStatus] ?? 0) + 1;
      if (o.supplyApprovedAt) report.approved++;
      const m = matchSite(o.projectCode, siteRows);
      const key = o.projectCode ?? '';
      if (m.status === 'no_code') report.noCode++;
      else if (m.status === 'not_found') report.unmatchedCodes[key] = (report.unmatchedCodes[key] ?? 0) + 1;
      else if (m.status === 'ambiguous') report.ambiguousCodes[key] = (report.ambiguousCodes[key] ?? 0) + 1;
      else if (m.status === 'matched_compact') {
        const pair = `${key} → ${codeById.get(m.siteId) ?? m.siteId}`;
        report.compactMatches[pair] = (report.compactMatches[pair] ?? 0) + 1;
      }
    }
    const next = page.meta.nextCursor;
    if (next === null) return report;
    if (next === cursor || seen.has(next) || report.pages >= MAX_PAGES) {
      throw new EstimatError('cursor_loop', 'EstiMat вернул уже пройденный курсор');
    }
    seen.add(next);
    cursor = next;
  }
}
