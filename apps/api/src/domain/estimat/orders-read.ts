import { and, count, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import {
  approvalState,
  ESTIMAT_SOURCING_STATUSES,
  formatOrderNo,
  type EstimatApprovalState,
  type EstimatOrderDetail,
  type EstimatOrderLinkedDelivery,
  type EstimatOrderListItem,
  type EstimatOrderSummary,
  type EstimatSyncInfo,
  type EstimatSyncRun,
  type EstimatSyncStatus,
  type SupplierOrderCandidateDetail,
} from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import {
  deliveries,
  deliverySupplierOrders,
  estimatSupplierOrderEvents,
  estimatSupplierOrders,
  estimatSyncRuns,
  sites,
  users,
} from '../../db/schema.js';
import type { EstimatConfig } from './config.js';

export type OrderRow = typeof estimatSupplierOrders.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Сводка заказа из строки таблицы. Номер и состояние визы — общими функциями контракта. */
export function toSummary(
  row: OrderRow,
  extra: { siteCode: string | null; lastApprovalRevokedAt: Date | null },
): EstimatOrderSummary {
  return {
    id: row.id,
    number: formatOrderNo(row.orderNo, row.subNo),
    orderNo: row.orderNo,
    subNo: row.subNo,
    sourcingStatus: row.sourcingStatus,
    approvalState: approvalState(row.sourcingStatus, row.supplyApprovedAt, row.deletedAt),
    projectCode: row.projectCode,
    projectName: row.projectName,
    siteId: row.siteId,
    siteCode: extra.siteCode,
    contractors: row.contractors ?? [],
    supplierName: row.supplierName,
    supplierInn: row.supplierInn,
    amount: row.amount,
    awardedAt: iso(row.awardedAt),
    supplyApprovedAt: iso(row.supplyApprovedAt),
    lastApprovalRevokedAt: iso(extra.lastApprovalRevokedAt),
    deletedAt: iso(row.deletedAt),
    lastSeenAt: row.lastSeenAt.toISOString(),
    estimatCreatedAt: iso(row.estimatCreatedAt),
  };
}

/** Когда визу снимали последний раз (время, когда обход это заметил). */
export async function loadLastRevokedAt(db: Db, orderIds: string[]): Promise<Map<string, Date>> {
  if (orderIds.length === 0) return new Map();
  const rows = await db
    .select({
      orderId: estimatSupplierOrderEvents.orderId,
      at: sql<Date>`max(${estimatSupplierOrderEvents.createdAt})`.mapWith((v) => new Date(v as string)),
    })
    .from(estimatSupplierOrderEvents)
    .where(
      and(
        inArray(estimatSupplierOrderEvents.orderId, orderIds),
        eq(estimatSupplierOrderEvents.kind, 'approval_revoked'),
      ),
    )
    .groupBy(estimatSupplierOrderEvents.orderId);
  return new Map(rows.map((r) => [r.orderId, r.at]));
}

const KNOWN = [...ESTIMAT_SOURCING_STATUSES];
const ACTIVE_STAGES = ['forming', 'sourcing', 'approval', 'awarded'];

/**
 * SQL-предикат состояния согласования — зеркало approvalState() из контракта.
 * Их совпадение закреплено тестом: фильтр списка и цвет чипа обязаны считать одно.
 */
export function approvalStateSql(state: EstimatApprovalState): SQL {
  const o = estimatSupplierOrders;
  const alive = isNull(o.deletedAt);
  switch (state) {
    case 'deleted':
      return isNotNull(o.deletedAt);
    case 'cancelled':
      return and(alive, inArray(o.sourcingStatus, ['cancelled', 'no_award']))!;
    case 'cancelling':
      return and(alive, eq(o.sourcingStatus, 'cancel_pending'))!;
    case 'not_required':
      return and(alive, eq(o.sourcingStatus, 'recorded'))!;
    case 'approved':
      return and(alive, inArray(o.sourcingStatus, ACTIVE_STAGES), isNotNull(o.supplyApprovedAt))!;
    case 'pending':
      return and(alive, inArray(o.sourcingStatus, ACTIVE_STAGES), isNull(o.supplyApprovedAt))!;
    case 'unknown':
      return and(alive, notInArray(o.sourcingStatus, KNOWN))!;
  }
}

/**
 * Поиск по номеру и тексту. «З-12», «12», «012», «12/1» — номер; любой запрос
 * заодно ищется в поставщике, подрядчиках, ИНН и коде объекта.
 */
export function orderSearchSql(q: string): SQL | undefined {
  const text = q.trim();
  if (!text) return undefined;
  const o = estimatSupplierOrders;
  const like = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const parts: SQL[] = [
    sql`${o.supplierName} ilike ${like}`,
    sql`${o.supplierInn} like ${like}`,
    sql`${o.projectCode} ilike ${like}`,
    sql`${o.contractors}::text ilike ${like}`,
  ];
  const num = /^\s*(?:[ЗзZz3]\s*-?\s*)?0*(\d{1,9})(?:\s*\/\s*(\d{1,9}))?\s*$/.exec(text);
  if (num) {
    const orderNo = Number(num[1]);
    parts.push(
      num[2] !== undefined
        ? and(eq(o.orderNo, orderNo), eq(o.subNo, Number(num[2])))!
        : eq(o.orderNo, orderNo),
    );
  }
  return or(...parts);
}

/** Сколько живых (не помеченных на удаление) приёмок у заказа. */
export const linkedDeliveriesCountSql = sql<number>`(
  select count(*)::int from ${deliverySupplierOrders}
  join ${deliveries} on ${deliveries.id} = ${deliverySupplierOrders.deliveryId}
  where ${deliverySupplierOrders.orderId} = ${estimatSupplierOrders.id}
    and ${deliveries.pendingDeletionAt} is null
)`;

export type OrderListQuery = {
  q?: string;
  siteId?: string;
  statuses?: string[];
  approval?: EstimatApprovalState[];
  includeDeleted?: boolean;
  limit: number;
  offset: number;
};

export function orderListWhere(query: Omit<OrderListQuery, 'limit' | 'offset'>): SQL | undefined {
  const o = estimatSupplierOrders;
  const conds: SQL[] = [];
  const wantsDeleted = query.includeDeleted || query.approval?.includes('deleted');
  if (!wantsDeleted) conds.push(isNull(o.deletedAt));
  if (query.siteId) conds.push(eq(o.siteId, query.siteId));
  if (query.statuses?.length) conds.push(inArray(o.sourcingStatus, query.statuses));
  if (query.approval?.length) conds.push(or(...query.approval.map(approvalStateSql))!);
  const search = query.q ? orderSearchSql(query.q) : undefined;
  if (search) conds.push(search);
  return conds.length ? and(...conds) : undefined;
}

/** Список вкладки «Заказы»: фильтры и сортировка — только здесь, на сервере. */
export async function listOrders(
  db: Db,
  query: OrderListQuery,
): Promise<{ items: EstimatOrderListItem[]; total: number }> {
  const where = orderListWhere(query);
  const o = estimatSupplierOrders;
  const [rows, [totalRow]] = await Promise.all([
    db
      .select({ order: o, siteCode: sites.code, linkedDeliveriesCount: linkedDeliveriesCountSql })
      .from(o)
      .leftJoin(sites, eq(sites.id, o.siteId))
      .where(where)
      .orderBy(sql`${o.estimatCreatedAt} desc nulls last`, desc(o.orderNo), o.subNo, o.id)
      .limit(query.limit)
      .offset(query.offset),
    db.select({ n: count() }).from(o).where(where),
  ]);
  const revoked = await loadLastRevokedAt(db, rows.map((r) => r.order.id));
  return {
    items: rows.map((r) => ({
      ...toSummary(r.order, { siteCode: r.siteCode, lastApprovalRevokedAt: revoked.get(r.order.id) ?? null }),
      linkedDeliveriesCount: Number(r.linkedDeliveriesCount ?? 0),
    })),
    total: Number(totalRow?.n ?? 0),
  };
}

/** Приёмки, к которым привязан заказ, — свежие сверху. */
async function loadLinkedDeliveries(db: Db, orderId: string): Promise<EstimatOrderLinkedDelivery[]> {
  const links = await db
    .select({
      deliveryId: deliverySupplierOrders.deliveryId,
      linkedAt: deliverySupplierOrders.linkedAt,
      siteMismatch: deliverySupplierOrders.siteMismatch,
      displayId: deliveries.displayId,
      arrivedAt: deliveries.arrivedAt,
      pendingDeletionAt: deliveries.pendingDeletionAt,
      siteCode: sites.code,
    })
    .from(deliverySupplierOrders)
    .innerJoin(deliveries, eq(deliveries.id, deliverySupplierOrders.deliveryId))
    .leftJoin(sites, eq(sites.id, deliveries.siteId))
    .where(eq(deliverySupplierOrders.orderId, orderId))
    .orderBy(desc(deliverySupplierOrders.linkedAt));
  return links.map((l) => ({
    deliveryId: l.deliveryId,
    displayId: l.displayId === null ? null : Number(l.displayId),
    siteCode: l.siteCode,
    arrivedAt: iso(l.arrivedAt),
    pendingDeletion: l.pendingDeletionAt !== null,
    siteMismatch: l.siteMismatch,
    linkedAt: l.linkedAt.toISOString(),
  }));
}

async function loadOrderRow(db: Db, id: string, opts: { liveOnly: boolean }) {
  const o = estimatSupplierOrders;
  const [row] = await db
    .select({ order: o, siteCode: sites.code })
    .from(o)
    .leftJoin(sites, eq(sites.id, o.siteId))
    .where(opts.liveOnly ? and(eq(o.id, id), isNull(o.deletedAt)) : eq(o.id, id))
    .limit(1);
  return row ?? null;
}

function detailFields(r: OrderRow) {
  return {
    procurementMethod: r.procurementMethod,
    acquisitionType: r.acquisitionType,
    contractNumber: r.contractNumber,
    contractDate: r.contractDate,
  };
}

/**
 * Подробности заказа для окна подбора: поля и привязанные приёмки, без журнала.
 * Удалённый в EstiMat заказ — null: подбор его не показывает, привязать нельзя.
 */
export async function getCandidateDetail(db: Db, id: string): Promise<SupplierOrderCandidateDetail | null> {
  const row = await loadOrderRow(db, id, { liveOnly: true });
  if (!row) return null;
  const [revoked, linked] = await Promise.all([loadLastRevokedAt(db, [id]), loadLinkedDeliveries(db, id)]);
  return {
    ...toSummary(row.order, { siteCode: row.siteCode, lastApprovalRevokedAt: revoked.get(id) ?? null }),
    ...detailFields(row.order),
    deliveries: linked,
  };
}

/** Есть ли заказ и не удалён ли он в EstiMat — до похода за составом. */
export async function isOrderLive(db: Db, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: estimatSupplierOrders.id })
    .from(estimatSupplierOrders)
    .where(and(eq(estimatSupplierOrders.id, id), isNull(estimatSupplierOrders.deletedAt)))
    .limit(1);
  return !!row;
}

/** Карточка заказа: поля, журнал, привязанные приёмки. */
export async function getOrderDetail(db: Db, id: string): Promise<EstimatOrderDetail | null> {
  const row = await loadOrderRow(db, id, { liveOnly: false });
  if (!row) return null;
  const e = estimatSupplierOrderEvents;
  const [events, linked] = await Promise.all([
    db
      .select({ event: e, userEmail: users.email })
      .from(e)
      .leftJoin(users, eq(users.id, e.userId))
      .where(eq(e.orderId, id))
      .orderBy(desc(e.id))
      .limit(500),
    loadLinkedDeliveries(db, id),
  ]);
  const lastRevoked = events.find((x) => x.event.kind === 'approval_revoked')?.event.createdAt ?? null;
  const r = row.order;
  return {
    ...toSummary(r, { siteCode: row.siteCode, lastApprovalRevokedAt: lastRevoked }),
    ...detailFields(r),
    firstSeenAt: r.firstSeenAt.toISOString(),
    events: events.map(({ event: ev, userEmail }) => ({
      id: ev.id,
      kind: ev.kind,
      fromValue: ev.fromValue,
      toValue: ev.toValue,
      details: ev.details ?? null,
      deliveryId: ev.deliveryId,
      userEmail: userEmail ?? null,
      createdAt: ev.createdAt.toISOString(),
    })),
    deliveries: linked,
  };
}

// ─── Состояние синхронизации ────────────────────────────────────────────────

export type SyncSettings = { enabledFlag: boolean; config: EstimatConfig; intervalSec: number };

/** Включена ли синхронизация и почему нет — одна формулировка для всех экранов. */
export function syncEnabled(settings: SyncSettings): { enabled: boolean; reason: string | null } {
  if (!settings.config.ok) return { enabled: false, reason: settings.config.reason };
  if (!settings.enabledFlag) return { enabled: false, reason: 'синхронизация выключена (ESTIMAT_SYNC_ENABLED=0)' };
  return { enabled: true, reason: null };
}

type RunRow = typeof estimatSyncRuns.$inferSelect;

function toRun(r: RunRow): EstimatSyncRun {
  return {
    id: r.id,
    trigger: r.trigger,
    outcome: r.outcome,
    startedAt: r.startedAt.toISOString(),
    finishedAt: iso(r.finishedAt),
    durationMs: r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
    pages: r.pages,
    ordersSeen: r.ordersSeen,
    inserted: r.inserted,
    updated: r.updated,
    approvalChanges: r.approvalChanges,
    statusChanges: r.statusChanges,
    markedDeleted: r.markedDeleted,
    restored: r.restored,
    invalidRows: r.invalidRows + r.invalidRowsNoId,
    restarts: r.restarts,
    unmatchedSites: r.unmatchedSites,
    tokenProjectId: r.tokenProjectId,
    scopeConfirmed: r.scopeConfirmed,
    deletionSkippedReason: r.deletionSkippedReason,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    requestId: r.requestId,
  };
}

async function latestRun(db: Db, where: SQL): Promise<RunRow | null> {
  const [row] = await db
    .select()
    .from(estimatSyncRuns)
    .where(where)
    .orderBy(desc(estimatSyncRuns.startedAt))
    .limit(1);
  return row ?? null;
}

export async function loadSyncStatus(db: Db, settings: SyncSettings): Promise<EstimatSyncStatus> {
  const { enabled, reason } = syncEnabled(settings);
  const [running, lastRun, lastCompleted] = await Promise.all([
    latestRun(db, eq(estimatSyncRuns.outcome, 'running')),
    latestRun(db, ne(estimatSyncRuns.outcome, 'running')),
    latestRun(db, eq(estimatSyncRuns.outcome, 'completed')),
  ]);
  return {
    enabled,
    reason,
    intervalSec: settings.intervalSec,
    running: running ? toRun(running) : null,
    lastRun: lastRun ? toRun(lastRun) : null,
    lastCompleted: lastCompleted ? toRun(lastCompleted) : null,
  };
}

/** Короткая сводка для карточки приёмки и окна подбора. */
export async function loadSyncInfo(db: Db, settings: SyncSettings): Promise<EstimatSyncInfo> {
  const { enabled, reason } = syncEnabled(settings);
  const [lastRun, lastCompleted] = await Promise.all([
    latestRun(db, ne(estimatSyncRuns.outcome, 'running')),
    latestRun(db, eq(estimatSyncRuns.outcome, 'completed')),
  ]);
  return {
    enabled,
    reason,
    lastCompletedAt: iso(lastCompleted?.finishedAt ?? null),
    lastOutcome: lastRun?.outcome ?? null,
    lastErrorCode: lastRun?.errorCode ?? null,
  };
}
