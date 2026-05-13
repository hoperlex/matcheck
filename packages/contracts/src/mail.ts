import { z } from 'zod';

export const MailAccountDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  host: z.string(),
  port: z.number(),
  useTls: z.boolean(),
  username: z.string(),
  folder: z.string(),
  lastUid: z.number().nullable(),
  isActive: z.boolean(),
  createdAt: z.string(),
});
export type MailAccountDto = z.infer<typeof MailAccountDtoSchema>;

export const MailAccountUpsertSchema = z.object({
  name: z.string().min(1).max(100),
  host: z.string().min(1).max(255),
  port: z.number().int().positive().max(65535).default(993),
  useTls: z.boolean().default(true),
  username: z.string().min(1),
  password: z.string().min(1).optional(),
  folder: z.string().default('INBOX'),
  isActive: z.boolean().default(true),
});
export type MailAccountUpsert = z.infer<typeof MailAccountUpsertSchema>;
