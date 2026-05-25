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
