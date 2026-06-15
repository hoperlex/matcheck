import { z } from 'zod';
import { ShipmentKindSchema } from './shipments.js';

/**
 * Строка отчёта «На объекте» (остатки сейчас).
 */
export const StockBalanceRowSchema = z.object({
  materialId: z.string().uuid().nullable(),
  materialName: z.string(),
  siteId: z.string().uuid(),
  siteCode: z.string(),
  siteName: z.string(),
  unit: z.string(),
  qtyIn: z.string(),
  qtyOut: z.string(),
  balance: z.string(),
  // Имена всех подрядчиков, чьи приёмки этого материала на этом объекте
  // вошли в qty_in. Несколько — через запятую. Может быть null, если у
  // приёмок не задан contractor_id.
  contractorName: z.string().nullable(),
  // Σ qty × price по всем приёмкам этого материала на этом объекте.
  // Null, если ни в одной приёмке не задана цена.
  sum: z.string().nullable(),
});
export type StockBalanceRow = z.infer<typeof StockBalanceRowSchema>;

export const StockBalanceResponseSchema = z.object({
  items: z.array(StockBalanceRowSchema),
  total: z.number(),
});
export type StockBalanceResponse = z.infer<typeof StockBalanceResponseSchema>;

/**
 * Строка журнала «Поступление».
 */
export const IntakeJournalRowSchema = z.object({
  itemId: z.string().uuid(),
  deliveryId: z.string().uuid(),
  arrivedAt: z.string().nullable(),
  siteId: z.string().uuid(),
  siteCode: z.string(),
  siteName: z.string(),
  materialId: z.string().uuid().nullable(),
  materialName: z.string(),
  qty: z.string().nullable(),
  unit: z.string(),
  // Цена за единицу и сумма НДС — снимок из УПД, заполняется при создании
  // приёмки. Может быть null, если позиция добавлена руками без цены.
  price: z.string().nullable(),
  vatSum: z.string().nullable(),
  // Σ qty × price для этой строки приёмки. Null, если цены нет.
  sum: z.string().nullable(),
  supplierId: z.string().uuid().nullable(),
  supplierName: z.string().nullable(),
  contractorId: z.string().uuid().nullable(),
  contractorName: z.string().nullable(),
  docNumber: z.string().nullable(),
  docDate: z.string().nullable(),
  statusCode: z.string(),
  statusLabel: z.string(),
});
export type IntakeJournalRow = z.infer<typeof IntakeJournalRowSchema>;

export const IntakeJournalResponseSchema = z.object({
  items: z.array(IntakeJournalRowSchema),
  total: z.number(),
});
export type IntakeJournalResponse = z.infer<typeof IntakeJournalResponseSchema>;

/**
 * Строка журнала «Отгрузка».
 */
export const ShipmentJournalRowSchema = z.object({
  itemId: z.string().uuid(),
  shipmentId: z.string().uuid(),
  shippedAt: z.string().nullable(),
  kind: ShipmentKindSchema,
  siteId: z.string().uuid(),
  siteCode: z.string(),
  siteName: z.string(),
  destSiteId: z.string().uuid().nullable(),
  destSiteName: z.string().nullable(),
  receiverCounterpartyId: z.string().uuid().nullable(),
  receiverName: z.string().nullable(),
  materialId: z.string().uuid().nullable(),
  materialName: z.string(),
  qty: z.string().nullable(),
  unit: z.string(),
  docNumber: z.string().nullable(),
  docDate: z.string().nullable(),
  statusCode: z.string(),
  statusLabel: z.string(),
});
export type ShipmentJournalRow = z.infer<typeof ShipmentJournalRowSchema>;

export const ShipmentJournalResponseSchema = z.object({
  items: z.array(ShipmentJournalRowSchema),
  total: z.number(),
});
export type ShipmentJournalResponse = z.infer<typeof ShipmentJournalResponseSchema>;

/**
 * Строка отчёта «Статистика по инспекторам КПП».
 * Одна тройка (день × инспектор × объект): сколько машин он провёл и какая
 * суммарная стоимость без НДС (Σ qtyActual × price по delivery_items).
 * У отгрузок цены обычно нет — для них считаем только машины.
 */
export const InspectorStatsRowSchema = z.object({
  date: z.string(),                               // 'YYYY-MM-DD' в МСК
  inspectorId: z.string().uuid(),
  inspectorFullName: z.string().nullable(),
  inspectorEmail: z.string(),
  siteId: z.string().uuid(),
  siteCode: z.string(),
  siteName: z.string(),
  // Разбивка машин: приёмки и отгрузки отдельно + итог vehicles.
  // Инвариант: deliveries + shipments == vehicles (по построению UNION
  // в /reports/inspector-stats).
  deliveries: z.number().int(),
  shipments: z.number().int(),
  vehicles: z.number().int(),
  sumNoVat: z.string(),                           // numeric → string, как остальные деньги
});
export type InspectorStatsRow = z.infer<typeof InspectorStatsRowSchema>;

export const InspectorStatsResponseSchema = z.object({
  items: z.array(InspectorStatsRowSchema),
  total: z.number(),
});
export type InspectorStatsResponse = z.infer<typeof InspectorStatsResponseSchema>;

/**
 * Лёгкие счётчики для шапки раздела «Операции»:
 *  - completedToday — приёмки+отгрузки со status='confirmed_mol' и
 *    confirmed_by_mol_at в МСК-дне (≈ «закрыты сегодня»);
 *  - inProgressToday — filled/shipped без МОЛ, чей arrived_at/shipped_at
 *    в МСК-дне сегодня (≈ «текущая работа дня»);
 *  - overdue — filled/shipped без МОЛ, чей arrived_at/shipped_at строго
 *    раньше сегодня (или NULL) — это «зависшие со вчера и старше».
 * Для inspector_kpp фильтруются по его site_id, для admin/manager —
 * глобально.
 */
export const OperationsCountersResponseSchema = z.object({
  completedToday: z.number().int().nonnegative(),
  inProgressToday: z.number().int().nonnegative(),
  overdue: z.number().int().nonnegative(),
});
export type OperationsCountersResponse = z.infer<typeof OperationsCountersResponseSchema>;

/**
 * Сводка для дашборда /stats — KPI + динамика по дням + «требует внимания».
 * Один запрос обслуживает все три виджета сводки, чтобы не плодить
 * параллельные шапочные запросы при открытии страницы.
 *
 * Гарантии числовой консистентности:
 *  - inProgressToday / overdue считаются ровно тем же SQL, что и
 *    /reports/operations-counters → цифры в виджете «Требует внимания»
 *    и в шапке Операций совпадают по построению.
 *  - sumDeliveries — Σ qty × price ТОЛЬКО по приёмкам. Отгрузки сюда не
 *    попадают: в shipment_items цена обычно не заполняется, и суммирование
 *    давало бы 0 c вводом в заблуждение. Метка в UI — «Сумма приёмок».
 *
 * Фильтры query:
 *  - from / to — границы периода в формате YYYY-MM-DD (МСК-день).
 *    Default — последние 30 дней до сегодня (включительно).
 *  - siteIds / inspectorIds — CSV uuid'ов. Опциональны.
 *  - Для роли inspector_kpp siteId принудительно ограничивается его
 *    назначенным объектом (как в /operations-counters).
 */
export const StatsSummaryRequestSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  siteIds: z.string().optional(),
  inspectorIds: z.string().optional(),
});
export type StatsSummaryRequest = z.infer<typeof StatsSummaryRequestSchema>;

const StatsKpiSchema = z.object({
  deliveries: z.number().int().nonnegative(),
  shipments: z.number().int().nonnegative(),
  vehicles: z.number().int().nonnegative(),
  // Σ qty × price только по приёмкам — у отгрузок цены нет. UI подписывает
  // эту цифру как «Сумма приёмок», не «Общая сумма», чтобы не путать.
  sumDeliveries: z.string(),
  // (deliveries + shipments) / max(1, days).
  avgPerDay: z.number().nonnegative(),
  inProgressToday: z.number().int().nonnegative(),
});

const StatsDailyPointSchema = z.object({
  date: z.string(), // 'YYYY-MM-DD' в МСК
  deliveries: z.number().int().nonnegative(),
  shipments: z.number().int().nonnegative(),
});

const StatsAttentionSchema = z.object({
  // Активные приёмки/отгрузки за период с пустым списком source_documents.
  noDocumentDeliveries: z.number().int().nonnegative(),
  noDocumentShipments: z.number().int().nonnegative(),
  // Активные приёмки/отгрузки за период без единого фото.
  noPhotosDeliveries: z.number().int().nonnegative(),
  noPhotosShipments: z.number().int().nonnegative(),
  // Зависшие со вчера и старше (filled/shipped без МОЛ). Не зависит от
  // выбранного периода — это «сейчас».
  overdue: z.number().int().nonnegative(),
  // Документы с расхождением сумм (source_documents.parse_error_code =
  // 'validation_mismatch') — за период.
  mismatchDocs: z.number().int().nonnegative(),
  // Транзитные рейсы за период — суммарно по приёмкам и отгрузкам,
  // т.к. на проде транзит чаще встречается у приёмок (машина приехала,
  // частично разгрузилась и поехала дальше с чужим грузом — отсюда
  // не пустой кузов на 2-м этапе).
  transit: z.number().int().nonnegative(),
});

export const StatsSummaryResponseSchema = z.object({
  range: z.object({
    from: z.string(),
    to: z.string(),
    days: z.number().int().positive(),
  }),
  kpi: StatsKpiSchema,
  daily: z.array(StatsDailyPointSchema),
  attention: StatsAttentionSchema,
});
export type StatsSummaryResponse = z.infer<typeof StatsSummaryResponseSchema>;
