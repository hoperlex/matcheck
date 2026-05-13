import { z } from 'zod';

export const EdoAccountDtoSchema = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  name: z.string(),
  isActive: z.boolean(),
  lastSyncAt: z.string().nullable(),
  createdAt: z.string(),
});
export type EdoAccountDto = z.infer<typeof EdoAccountDtoSchema>;

export const EdoAccountUpsertSchema = z.object({
  provider: z.literal('diadoc').default('diadoc'),
  name: z.string().min(1).max(100),
  credentials: z.object({
    apiClientId: z.string().min(1),
    login: z.string().min(1),
    password: z.string().min(1),
    boxId: z.string().min(1),
  }),
  isActive: z.boolean().default(true),
});
export type EdoAccountUpsert = z.infer<typeof EdoAccountUpsertSchema>;
