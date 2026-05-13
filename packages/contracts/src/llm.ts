import { z } from 'zod';

export const LlmKindSchema = z.enum([
  'openrouter',
  'google_ai_studio',
  'qwen_self_hosted',
  'vertex',
]);
export type LlmKind = z.infer<typeof LlmKindSchema>;

export const LlmProviderDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: LlmKindSchema,
  apiBaseUrl: z.string(),
  model: z.string(),
  temperature: z.string(),
  maxTokens: z.number(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LlmProviderDto = z.infer<typeof LlmProviderDtoSchema>;

export const LlmProviderUpsertSchema = z.object({
  name: z.string().min(1).max(100),
  kind: LlmKindSchema,
  apiBaseUrl: z.string().url(),
  model: z.string().min(1).max(200),
  apiKey: z.string().min(1).optional(),
  temperature: z.string().default('0.2'),
  maxTokens: z.number().int().positive().max(200_000).default(4096),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
});
export type LlmProviderUpsert = z.infer<typeof LlmProviderUpsertSchema>;

export const LlmTestResponseSchema = z.object({
  ok: z.boolean(),
  output: z.string().optional(),
  error: z.string().optional(),
  durationMs: z.number(),
});
