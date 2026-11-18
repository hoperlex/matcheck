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

/**
 * Отметка «Диспетчер» у приёмки: ставят и видят те же роли, что «Проверено»
 * (действие `review`). Независима от reviewState. В отличие от «Проверено»,
 * снимается: PATCH /api/v1/deliveries/:id/dispatcher-check { checked: false }.
 * optional — по той же причине, что ReviewFieldsShape: в /sync не уходит.
 */
export const DispatcherCheckRequestSchema = z.object({ checked: z.boolean() });
export type DispatcherCheckRequest = z.infer<typeof DispatcherCheckRequestSchema>;

/**
 * Отметка «Диспетчер» у многих приёмок разом — строка группы и отмеченные
 * строки «Принятых»: POST /api/v1/deliveries/bulk-dispatcher-check.
 * Уже стоящие отметки не перезаписываются (автор и время сохраняются),
 * снятие трогает только отмеченные.
 */
export const DispatcherBulkCheckRequestSchema = z.object({
  ids: z
    .array(z.string().uuid())
    .min(1)
    .max(500)
    .refine((list) => new Set(list).size === list.length, 'Приёмка указана дважды'),
  checked: z.boolean(),
});
export type DispatcherBulkCheckRequest = z.infer<typeof DispatcherBulkCheckRequestSchema>;

/**
 * Почему приёмка не изменилась: не найдена, помечена на удаление, ещё не
 * оформлена или уже в нужном состоянии.
 */
export const DispatcherBulkSkipReasonSchema = z.enum([
  'not_found',
  'pending_deletion',
  'not_reviewable',
  'already',
]);
export type DispatcherBulkSkipReason = z.infer<typeof DispatcherBulkSkipReasonSchema>;

export const DispatcherBulkCheckResponseSchema = z.object({
  changed: z.array(z.string().uuid()),
  skipped: z.array(z.object({ id: z.string().uuid(), reason: DispatcherBulkSkipReasonSchema })),
});
export type DispatcherBulkCheckResponse = z.infer<typeof DispatcherBulkCheckResponseSchema>;

export const DispatcherCheckFieldsShape = {
  dispatcherCheckedAt: z.string().nullable().optional(),
  dispatcherCheckedByUserEmail: z.string().nullable().optional(),
};
