import { z } from 'zod';

// Общие схемы для массового удаления записей справочников.
// source_documents.bulk-delete использует свою специфичную схему
// (см. SourceDocumentBulkDelete*) — там reason ограничен enum-ом
// has_references / not_found / internal_error и есть журналирование.
// Здесь — упрощённый универсальный вариант для справочников.

export const BulkDeleteRequestSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
});
export type BulkDeleteRequest = z.infer<typeof BulkDeleteRequestSchema>;

export const BulkDeleteSkipReasonSchema = z.enum([
  // Запись не найдена (уже удалена, либо чужой id).
  'not_found',
  // У записи есть зависимые объекты (например, объект используется в приёмках).
  'has_references',
  // Технически запрещено удалять (например, системная запись).
  'system_readonly',
  // Неизвестная ошибка при удалении конкретной записи (см. логи бэка).
  'internal_error',
]);
export type BulkDeleteSkipReason = z.infer<typeof BulkDeleteSkipReasonSchema>;

export const BulkDeleteResponseSchema = z.object({
  deleted: z.array(z.string().uuid()),
  skipped: z.array(
    z.object({
      id: z.string().uuid(),
      reason: BulkDeleteSkipReasonSchema,
    }),
  ),
});
export type BulkDeleteResponse = z.infer<typeof BulkDeleteResponseSchema>;
