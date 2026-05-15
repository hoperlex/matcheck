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
  model: z.string().min(1).max(200),
  temperature: z.string().default('0.2'),
  maxTokens: z.number().int().positive().max(200_000).default(16384),
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

// ─── Credentials: один ключ на тип провайдера (kind) ─────────────────────────

export const LlmProviderCredentialDtoSchema = z.object({
  kind: LlmKindSchema,
  apiBaseUrl: z.string(),
  hasKey: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LlmProviderCredentialDto = z.infer<typeof LlmProviderCredentialDtoSchema>;

export const LlmProviderCredentialUpsertSchema = z.object({
  apiBaseUrl: z.string().url(),
  apiKey: z.string().min(1).optional(),
});
export type LlmProviderCredentialUpsert = z.infer<typeof LlmProviderCredentialUpsertSchema>;
