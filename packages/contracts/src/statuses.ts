import { z } from 'zod';

export const StatusSchema = z.object({
  id: z.string().uuid(),
  entityType: z.string(),
  code: z.string(),
  label: z.string(),
  color: z.string().nullable(),
  sortOrder: z.number(),
});
export type Status = z.infer<typeof StatusSchema>;

export const StatusListResponseSchema = z.object({
  items: z.array(StatusSchema),
});
export type StatusListResponse = z.infer<typeof StatusListResponseSchema>;

/**
 * Допустимые коды статусов для приёмки.
 * Берутся из таблицы statuses (entity_type='delivery').
 *
 * Признак «нет привязанной УПД» — ортогональное измерение, вычисляется как
 * `sourceDocumentIds.length === 0` и отображается отдельным тегом, а не
 * через отдельный код статуса.
 */
export const DeliveryStatusCodeSchema = z.enum([
  'not_filled',
  'draft',
  'filled',
  'confirmed_mol',
]);
export type DeliveryStatusCode = z.infer<typeof DeliveryStatusCodeSchema>;

/**
 * Допустимые коды статусов для отгрузки (entity_type='shipment').
 */
export const ShipmentStatusCodeSchema = z.enum([
  'not_filled',
  'draft',
  'shipped',
  'confirmed_mol',
]);
export type ShipmentStatusCode = z.infer<typeof ShipmentStatusCodeSchema>;

/**
 * Наборы статусов для двухэтапной модели удаления. Общий источник для API и
 * web: раньше оба набора дублировались в routes/*.ts и в *History.tsx, и в
 * копии для отгрузок остался код приёмки `filled` вместо `shipped` — статус
 * «Оформлена» у отгрузки называется иначе, чем у приёмки (label одинаковый).
 * Из-за этого `shipped` не попадал ни в один набор: hard-delete отвечал 409
 * `must_mark_first`, а mark-deletion — 400 `cannot_mark_status`, и отгрузку
 * было невозможно удалить вообще. Тест delete-statuses.test.ts следит, чтобы
 * каждый код статуса попадал ровно в один из наборов своей сущности.
 */

/** Статусы, при которых разрешено окончательное удаление без предварительной пометки. */
export const DELIVERY_HARD_DELETE_STATUSES: ReadonlySet<string> = new Set(['draft', 'not_filled']);
export const SHIPMENT_HARD_DELETE_STATUSES: ReadonlySet<string> = new Set(['draft', 'not_filled']);

/** Статусы, требующие двухэтапного удаления: пометка → hard-delete админом. */
export const DELIVERY_SOFT_DELETE_STATUSES: ReadonlySet<string> = new Set([
  'filled',
  'confirmed_mol',
]);
export const SHIPMENT_SOFT_DELETE_STATUSES: ReadonlySet<string> = new Set([
  'shipped',
  'confirmed_mol',
]);
