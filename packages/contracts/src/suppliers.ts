import { z } from 'zod';

/**
 * Справочник поставщиков заказчика (импорт из JSON-источника, миграция 0055).
 * ОТДЕЛЬНАЯ сущность, не путать с операционными `counterparties` (роль
 * isSupplier). `inn` — свободная строка: в источнике встречаются «грязные»
 * значения (запятые, 11 знаков, префикс «ИНН …»), которые правятся вручную.
 */
export const SupplierSchema = z.object({
  id: z.string().uuid(),
  inn: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  // approved | rejected | null — статус проверки СБ заказчика. Строка (не
  // enum) в ответе, чтобы не падать на новых статусах со стороны заказчика.
  lastSecurityStatus: z.string().nullable(),
  foundingDocumentsComment: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Supplier = z.infer<typeof SupplierSchema>;

export const SupplierUpsertSchema = z.object({
  // ИНН необязателен и без строгой маски — справочник допускает свободный ввод.
  inn: z.string().max(64).optional(),
  name: z.string().min(1).max(500),
  aliases: z.array(z.string().min(1).max(500)).max(20).optional(),
  lastSecurityStatus: z.enum(['approved', 'rejected']).nullable().optional(),
  foundingDocumentsComment: z.string().max(2000).nullable().optional(),
});
export type SupplierUpsert = z.infer<typeof SupplierUpsertSchema>;

export const SupplierListResponseSchema = z.object({
  items: z.array(SupplierSchema),
  total: z.number(),
});
