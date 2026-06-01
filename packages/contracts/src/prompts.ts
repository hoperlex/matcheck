import { z } from 'zod';

export const PromptDocKindSchema = z.enum(['upd', 'request', 'transport_waybill']);
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
