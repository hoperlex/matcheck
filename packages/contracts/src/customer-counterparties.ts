import { z } from 'zod';

/**
 * Справочник контрагентов заказчика (импорт из JSON-источника, миграция 0055).
 * ОТДЕЛЬНАЯ таблица `customer_counterparties`, не путать с операционной
 * `counterparties` (та завязана на FK приёмок/отгрузок и sync мобилы).
 * `inn` — свободная строка по тем же причинам, что и у поставщиков.
 */
export const CustomerCounterpartySchema = z.object({
  id: z.string().uuid(),
  inn: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  address: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CustomerCounterparty = z.infer<typeof CustomerCounterpartySchema>;

export const CustomerCounterpartyUpsertSchema = z.object({
  inn: z.string().max(64).optional(),
  name: z.string().min(1).max(500),
  aliases: z.array(z.string().min(1).max(500)).max(20).optional(),
  address: z.string().max(500).nullable().optional(),
});
export type CustomerCounterpartyUpsert = z.infer<typeof CustomerCounterpartyUpsertSchema>;

export const CustomerCounterpartyListResponseSchema = z.object({
  items: z.array(CustomerCounterpartySchema),
  total: z.number(),
});
