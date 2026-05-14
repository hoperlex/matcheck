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
 */
export const DeliveryStatusCodeSchema = z.enum(['not_filled', 'draft', 'filled']);
export type DeliveryStatusCode = z.infer<typeof DeliveryStatusCodeSchema>;
