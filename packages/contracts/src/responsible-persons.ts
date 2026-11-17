import { z } from 'zod';

export const ResponsiblePersonSchema = z.object({
  id: z.string().uuid(),
  fullName: z.string(),
  phone: z.string().nullable(),
  position: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ResponsiblePerson = z.infer<typeof ResponsiblePersonSchema>;

export const ResponsiblePersonUpsertSchema = z.object({
  // trim до проверки длины: строка из одних пробелов — не ФИО, и дедуп
  // по нормализованному имени не должен видеть «пустого» МОЛ.
  fullName: z.string().trim().min(1).max(500),
  phone: z.string().max(64).nullable().optional(),
  position: z.string().max(200).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type ResponsiblePersonUpsert = z.infer<typeof ResponsiblePersonUpsertSchema>;

/**
 * Ответ POST /responsible-persons. Сервер сам говорит, что произошло, — по
 * клиентскому кэшу списка этого не понять (его может не быть или он устарел):
 *  created  — заведена новая ручная запись (HTTP 201);
 *  existing — активный МОЛ с таким ФИО уже есть, он и возвращён (HTTP 200),
 *             запись не менялась.
 */
export const ResponsiblePersonCreateResponseSchema = ResponsiblePersonSchema.extend({
  outcome: z.enum(['created', 'existing']),
});
export type ResponsiblePersonCreateResponse = z.infer<typeof ResponsiblePersonCreateResponseSchema>;

/**
 * 409 при создании/правке МОЛ:
 *  mol_archived   — POST: ручная запись с таким ФИО лежит в архиве. POST её не
 *                   трогает: вернуть из архива — правка (PATCH), отдельное право;
 *  mol_name_taken — PATCH: после правки было бы два активных МОЛ с одним ФИО.
 * `existing` — та запись, с которой совпало ФИО.
 */
export const ResponsiblePersonConflictSchema = z.object({
  error: z.enum(['mol_archived', 'mol_name_taken']),
  message: z.string(),
  existing: ResponsiblePersonSchema,
});
export type ResponsiblePersonConflict = z.infer<typeof ResponsiblePersonConflictSchema>;

export const ResponsiblePersonListResponseSchema = z.object({
  items: z.array(ResponsiblePersonSchema),
  total: z.number(),
});

export const ResponsiblePersonImportErrorSchema = z.object({
  row: z.number().int().positive(),
  reason: z.string(),
});
export type ResponsiblePersonImportError = z.infer<typeof ResponsiblePersonImportErrorSchema>;

export const ResponsiblePersonImportResponseSchema = z.object({
  created: z.number().int().nonnegative(),
  skippedDuplicates: z.number().int().nonnegative(),
  errors: z.array(ResponsiblePersonImportErrorSchema),
});
export type ResponsiblePersonImportResponse = z.infer<typeof ResponsiblePersonImportResponseSchema>;
