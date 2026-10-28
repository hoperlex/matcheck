import { z } from 'zod';

/**
 * Заказы поставщикам из EstiMat (сметный портал СУ-10, внешний read-only API).
 * Портал зеркалит их полным обходом и привязывает к приёмкам (миграция 0141).
 */

/** Стадии заказа, известные на версию контракта 1.6.0. Новые показываются как есть. */
export const ESTIMAT_SOURCING_STATUSES = [
  'forming',
  'sourcing',
  'approval',
  'awarded',
  'recorded',
  'cancel_pending',
  'cancelled',
  'no_award',
] as const;
export type EstimatSourcingStatus = (typeof ESTIMAT_SOURCING_STATUSES)[number];

/**
 * Номер заказа для людей: `З-012`, при подзаказе `З-012/1`. Номер дополняется
 * нулями до трёх знаков; заказ без номера — «без номера».
 */
export function formatOrderNo(orderNo: number | null, subNo: number | null): string {
  if (orderNo === null) return 'без номера';
  const base = `З-${String(orderNo).padStart(3, '0')}`;
  return subNo !== null && subNo > 0 ? `${base}/${subNo}` : base;
}

/**
 * Состояние согласования — ОДИН предикат для чипа, блока приёмки, фильтра списка
 * и подбора. Порядок проверок важен: удалённый и отменённый заказ не становятся
 * «согласованными» из-за оставшейся даты визы, а `recorded` — не «не
 * согласован»: подрядчик закупает сам, виза к такому заказу не приходит никогда.
 */
export const ESTIMAT_APPROVAL_STATES = [
  'approved',
  'pending',
  'not_required',
  'cancelling',
  'cancelled',
  'deleted',
  'unknown',
] as const;
export const EstimatApprovalStateSchema = z.enum(ESTIMAT_APPROVAL_STATES);
export type EstimatApprovalState = z.infer<typeof EstimatApprovalStateSchema>;

export function approvalState(
  stage: string,
  supplyApprovedAt: string | Date | null,
  deletedAt: string | Date | null,
): EstimatApprovalState {
  if (deletedAt !== null) return 'deleted';
  if (stage === 'cancelled' || stage === 'no_award') return 'cancelled';
  if (stage === 'cancel_pending') return 'cancelling';
  if (stage === 'recorded') return 'not_required';
  if (!(ESTIMAT_SOURCING_STATUSES as readonly string[]).includes(stage)) return 'unknown';
  return supplyApprovedAt !== null ? 'approved' : 'pending';
}

export const EstimatOrderContractorSchema = z.object({
  id: z.string(),
  name: z.string(),
  inn: z.string().nullable(),
  /** subcontractor — субподрядчик, mol — МОЛ; прочие значения — как пришли. */
  type: z.string().nullable(),
});
export type EstimatOrderContractor = z.infer<typeof EstimatOrderContractorSchema>;

/** Сводка заказа — одна для списка, подбора и блока приёмки. */
export const EstimatOrderSummarySchema = z.object({
  id: z.string().uuid(),
  number: z.string(),
  orderNo: z.number().int().nullable(),
  subNo: z.number().int().nullable(),
  sourcingStatus: z.string(),
  approvalState: EstimatApprovalStateSchema,
  projectCode: z.string().nullable(),
  projectName: z.string().nullable(),
  siteId: z.string().uuid().nullable(),
  siteCode: z.string().nullable(),
  contractors: z.array(EstimatOrderContractorSchema),
  supplierName: z.string().nullable(),
  supplierInn: z.string().nullable(),
  /** Рубли с копейками, с НДС, строкой decimal — без float. */
  amount: z.string().nullable(),
  awardedAt: z.string().nullable(),
  supplyApprovedAt: z.string().nullable(),
  /** Когда визу сняли последний раз (из журнала); null — не снимали. */
  lastApprovalRevokedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  lastSeenAt: z.string(),
  estimatCreatedAt: z.string().nullable(),
});
export type EstimatOrderSummary = z.infer<typeof EstimatOrderSummarySchema>;

/**
 * Совпадение стороны заказа со сторонами приёмки по ИНН. null — у приёмки нет
 * ИНН этой стороны: отсутствие ИНН несовпадением не считается.
 */
const MatchFlagSchema = z.boolean().nullable();

/** Заказ, привязанный к приёмке. */
export const DeliverySupplierOrderSchema = EstimatOrderSummarySchema.extend({
  linkedAt: z.string(),
  siteMismatch: z.boolean(),
  supplierMatch: MatchFlagSchema,
  contractorMatch: MatchFlagSchema,
});
export type DeliverySupplierOrder = z.infer<typeof DeliverySupplierOrderSchema>;

/** Состояние синхронизации в объёме, нужном карточке приёмки и окну подбора. */
export const EstimatSyncInfoSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().nullable(),
  lastCompletedAt: z.string().nullable(),
  lastOutcome: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
});
export type EstimatSyncInfo = z.infer<typeof EstimatSyncInfoSchema>;

export const DeliverySupplierOrdersResponseSchema = z.object({
  items: z.array(DeliverySupplierOrderSchema),
  sync: EstimatSyncInfoSchema,
});
export type DeliverySupplierOrdersResponse = z.infer<typeof DeliverySupplierOrdersResponseSchema>;

export const SupplierOrderCandidateSchema = EstimatOrderSummarySchema.extend({
  supplierMatch: MatchFlagSchema,
  contractorMatch: MatchFlagSchema,
  /** Объект заказа совпадает с объектом приёмки. */
  siteMatch: z.boolean(),
  /** Уже привязан к этой приёмке. */
  linked: z.boolean(),
  /** К скольким приёмкам привязан (без помеченных на удаление). */
  linkedDeliveriesCount: z.number().int(),
});
export type SupplierOrderCandidate = z.infer<typeof SupplierOrderCandidateSchema>;

export const SupplierOrderCandidatesResponseSchema = z.object({
  items: z.array(SupplierOrderCandidateSchema),
  total: z.number().int(),
  syncInfo: EstimatSyncInfoSchema,
});
export type SupplierOrderCandidatesResponse = z.infer<typeof SupplierOrderCandidatesResponseSchema>;

export const LinkSupplierOrderBodySchema = z.object({
  orderId: z.string().uuid(),
  /** Заказ другого или неопределённого объекта — привязать всё равно. */
  confirmSiteMismatch: z.boolean().optional(),
});
export type LinkSupplierOrderBody = z.infer<typeof LinkSupplierOrderBodySchema>;

/** 409 при привязке заказа другого объекта без подтверждения. */
export const SupplierOrderSiteMismatchSchema = z.object({
  error: z.literal('site_mismatch'),
  message: z.string(),
  orderSiteCode: z.string().nullable(),
  projectCode: z.string().nullable(),
  deliverySiteCode: z.string().nullable(),
});
export type SupplierOrderSiteMismatch = z.infer<typeof SupplierOrderSiteMismatchSchema>;

/** Строка вкладки «Заказы». */
export const EstimatOrderListItemSchema = EstimatOrderSummarySchema.extend({
  linkedDeliveriesCount: z.number().int(),
});
export type EstimatOrderListItem = z.infer<typeof EstimatOrderListItemSchema>;

export const EstimatOrderListResponseSchema = z.object({
  items: z.array(EstimatOrderListItemSchema),
  total: z.number().int(),
});
export type EstimatOrderListResponse = z.infer<typeof EstimatOrderListResponseSchema>;

export const ESTIMAT_ORDER_EVENT_KINDS = [
  'first_seen',
  'approved',
  'approval_revoked',
  'reapproved',
  'status_changed',
  'deleted',
  'restored',
  'delivery_linked',
  'delivery_unlinked',
] as const;

export const EstimatOrderEventSchema = z.object({
  id: z.number().int(),
  kind: z.enum(ESTIMAT_ORDER_EVENT_KINDS),
  fromValue: z.string().nullable(),
  toValue: z.string().nullable(),
  details: z.record(z.unknown()).nullable(),
  deliveryId: z.string().uuid().nullable(),
  userEmail: z.string().nullable(),
  createdAt: z.string(),
});
export type EstimatOrderEvent = z.infer<typeof EstimatOrderEventSchema>;

export const EstimatOrderLinkedDeliverySchema = z.object({
  deliveryId: z.string().uuid(),
  displayId: z.number().int().nullable(),
  siteCode: z.string().nullable(),
  arrivedAt: z.string().nullable(),
  pendingDeletion: z.boolean(),
  siteMismatch: z.boolean(),
  linkedAt: z.string(),
});
export type EstimatOrderLinkedDelivery = z.infer<typeof EstimatOrderLinkedDeliverySchema>;

export const EstimatOrderDetailSchema = EstimatOrderSummarySchema.extend({
  procurementMethod: z.string().nullable(),
  acquisitionType: z.string().nullable(),
  contractNumber: z.string().nullable(),
  contractDate: z.string().nullable(),
  firstSeenAt: z.string(),
  events: z.array(EstimatOrderEventSchema),
  deliveries: z.array(EstimatOrderLinkedDeliverySchema),
});
export type EstimatOrderDetail = z.infer<typeof EstimatOrderDetailSchema>;

export const EstimatOrderItemSchema = z.object({
  id: z.string(),
  materialName: z.string(),
  unit: z.string(),
  quantity: z.number(),
  deliveryDate: z.string().nullable(),
  contractorName: z.string().nullable(),
});
export type EstimatOrderItem = z.infer<typeof EstimatOrderItemSchema>;

/**
 * Состав заказа запрашивается у EstiMat по требованию. `unavailable` — EstiMat
 * не ответил или занят (текст в message), `disabled` — интеграция не настроена.
 */
export const EstimatOrderItemsResponseSchema = z.object({
  state: z.enum(['ready', 'unavailable', 'disabled']),
  fetchedAt: z.string().nullable(),
  message: z.string().nullable(),
  items: z.array(EstimatOrderItemSchema),
});
export type EstimatOrderItemsResponse = z.infer<typeof EstimatOrderItemsResponseSchema>;

export const EstimatSyncRunSchema = z.object({
  id: z.string().uuid(),
  trigger: z.string(),
  outcome: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  pages: z.number().int(),
  ordersSeen: z.number().int(),
  inserted: z.number().int(),
  updated: z.number().int(),
  approvalChanges: z.number().int(),
  statusChanges: z.number().int(),
  markedDeleted: z.number().int(),
  restored: z.number().int(),
  invalidRows: z.number().int(),
  restarts: z.number().int(),
  unmatchedSites: z.number().int(),
  tokenProjectId: z.string().uuid().nullable(),
  scopeConfirmed: z.boolean(),
  deletionSkippedReason: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  requestId: z.string().nullable(),
});
export type EstimatSyncRun = z.infer<typeof EstimatSyncRunSchema>;

export const EstimatSyncStatusSchema = z.object({
  /** Синхронизация включена флагом и настройки токена в порядке. */
  enabled: z.boolean(),
  /** Почему выключена: флаг, нет токена, неверный формат. */
  reason: z.string().nullable(),
  intervalSec: z.number().int(),
  running: EstimatSyncRunSchema.nullable(),
  lastRun: EstimatSyncRunSchema.nullable(),
  lastCompleted: EstimatSyncRunSchema.nullable(),
});
export type EstimatSyncStatus = z.infer<typeof EstimatSyncStatusSchema>;

export const EstimatSyncTriggerResponseSchema = z.object({
  status: z.enum(['queued', 'already_queued']),
});
export type EstimatSyncTriggerResponse = z.infer<typeof EstimatSyncTriggerResponseSchema>;
