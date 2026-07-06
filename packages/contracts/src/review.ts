import { z } from 'zod';

/**
 * Отметка проверки качества (роль «Мониторинг»). Ортогональна операционному
 * статусу приёмки/отгрузки: запись остаётся «Подтверждено МОЛ», а поверх лежит
 * независимая отметка контроля качества.
 *   approved — «Проверено» (фото/материалы/суммы в порядке).
 *   issues   — «Есть замечания» (требует обязательного комментария).
 * NULL в DTO (reviewState) = «Не проверено».
 */
export const ReviewStateSchema = z.enum(['approved', 'issues']);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

/**
 * Тело запроса простановки/смены отметки: PATCH /api/v1/{deliveries|shipments}/:id/review.
 * Снятия отметки (state: null) нет — только approved/issues. Для «Есть замечания»
 * комментарий обязателен.
 */
export const ReviewRequestSchema = z
  .object({
    state: ReviewStateSchema,
    note: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((b) => b.state !== 'issues' || (b.note != null && b.note.trim().length > 0), {
    message: 'Для «Есть замечания» комментарий обязателен',
    path: ['note'],
  });
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

/**
 * Поля отметки проверки в DTO приёмки/отгрузки (spread в Delivery/Shipment).
 * Видны только admin/manager/monitor — для прочих ролей сервер обнуляет их в
 * buildDeliveryDto/buildShipmentDto (внутренняя QC-кухня менеджмента).
 *
 * .optional() — намеренно: мобильный sync переиспользует Delivery/ShipmentSchema
 * (SyncDeltaResponseSchema), но review-поля в sync-payload НЕ кладёт. optional
 * позволяет sync-билдеру их опускать без ошибки сериализации (review в мобилку не
 * уходит вовсе), а web-билдер их всегда проставляет (null или значение).
 */
export const ReviewFieldsShape = {
  reviewState: ReviewStateSchema.nullable().optional(),
  reviewNote: z.string().nullable().optional(),
  reviewedByUserId: z.string().uuid().nullable().optional(),
  reviewedByUserEmail: z.string().nullable().optional(),
  reviewedAt: z.string().nullable().optional(),
};
