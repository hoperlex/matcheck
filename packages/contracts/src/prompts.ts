import { z } from 'zod';

// transport_waybill_1t — ОТДЕЛЬНЫЙ вид промпта, а не версия транспортного.
// Промпт transport_waybill распознаёт только формы 2116 и ОС-2 и по своей же
// инструкции обязан игнорировать всё прочее; товарно-транспортная накладная
// формы 1-Т (Госкомстат №78, ОКУД 0345009) под него не подходит и получает
// пустой ответ. Заводить её в тот же промпт значило бы переписать текст,
// которым сегодня успешно разбираются ТН-2116, — поэтому 1-Т живёт своим
// видом и запускается ВТОРЫМ проходом, только когда первый ничего не нашёл.
export const PromptDocKindSchema = z.enum([
  'upd',
  'request',
  'transport_waybill',
  'transport_waybill_1t',
  'm15',
]);
export type PromptDocKind = z.infer<typeof PromptDocKindSchema>;

export const PromptDtoSchema = z.object({
  id: z.string().uuid(),
  docKind: PromptDocKindSchema,
  name: z.string(),
  content: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PromptDto = z.infer<typeof PromptDtoSchema>;

export const PromptUpsertSchema = z.object({
  docKind: PromptDocKindSchema,
  name: z.string().min(1).max(200),
  content: z.string().min(1).max(50_000),
  isActive: z.boolean().optional(),
});
export type PromptUpsert = z.infer<typeof PromptUpsertSchema>;

export const PromptPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  content: z.string().min(1).max(50_000).optional(),
});
export type PromptPatch = z.infer<typeof PromptPatchSchema>;
