import { z } from 'zod';

export const InnSchema = z.string().regex(/^(\d{10}|\d{12})$/, 'INN must be 10 or 12 digits');
export const KppSchema = z
  .string()
  .regex(/^\d{9}$/, 'KPP must be 9 digits')
  .nullable()
  .optional();

export const CounterpartySchema = z.object({
  id: z.string().uuid(),
  // ИНН не nullable: для контрагентов, созданных «на лету» через combobox
  // без указания ИНН, сервер генерирует placeholder `0000{8 hex}`.
  // UI скрывает такой ИНН как «—», а дедуп-логика при появлении реального
  // ИНН (например от LLM) заменяет placeholder на настоящий.
  inn: z.string(),
  kpp: z.string().nullable(),
  name: z.string(),
  // Альтернативные написания для дедупа в combobox («ООО Лютик» / «Лютик ООО»).
  aliases: z.array(z.string()).default([]),
  address: z.string().nullable(),
  isSelf: z.boolean(),
  isSupplier: z.boolean(),
  isCustomer: z.boolean(),
  isContractor: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Counterparty = z.infer<typeof CounterpartySchema>;

export const CounterpartyUpsertSchema = z.object({
  // ИНН необязателен — без него сервер сгенерирует placeholder.
  inn: InnSchema.optional(),
  kpp: KppSchema,
  name: z.string().min(1).max(500),
  aliases: z.array(z.string().min(1).max(500)).max(20).optional(),
  address: z.string().max(500).nullable().optional(),
  isSelf: z.boolean().optional(),
  isSupplier: z.boolean().optional(),
  isCustomer: z.boolean().optional(),
  isContractor: z.boolean().optional(),
});
export type CounterpartyUpsert = z.infer<typeof CounterpartyUpsertSchema>;

/**
 * ИНН-плейсхолдер для контрагентов, созданных «на лету» без указания ИНН.
 * Шаблон: 12 символов, начинаются с 0000 — у реальных юрлиц РФ ИНН так
 * не начинается, что даёт надёжный признак отличия.
 */
export const PLACEHOLDER_INN_PREFIX = '0000';
export function isPlaceholderInn(inn: string | null | undefined): boolean {
  return typeof inn === 'string' && inn.startsWith(PLACEHOLDER_INN_PREFIX);
}

export const CounterpartyListResponseSchema = z.object({
  items: z.array(CounterpartySchema),
  total: z.number(),
});
