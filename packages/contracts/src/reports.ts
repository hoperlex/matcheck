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
 * Лёгкие счётчики для шапки раздела «Операции»: завершённые сегодня
 * (status='confirmed_mol' AND confirmed_by_mol_at в МСК-дне) и сейчас в работе
 * (delivery='filled' + shipment='shipped'). Для inspector_kpp фильтруются
 * по его site_id, для admin/manager — глобально.
 */
export const OperationsCountersResponseSchema = z.object({
  completedToday: z.number().int().nonnegative(),
  inProgress: z.number().int().nonnegative(),
});
export type OperationsCountersResponse = z.infer<typeof OperationsCountersResponseSchema>;
