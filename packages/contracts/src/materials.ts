import { z } from 'zod';

export const MaterialSchema = z.object({
  id: z.string().uuid(),
  code: z.string().nullable(),
  name: z.string(),
  unit: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Material = z.infer<typeof MaterialSchema>;

export const MaterialUpsertSchema = z.object({
  code: z.string().max(64).nullable().optional(),
  name: z.string().min(1).max(500),
  unit: z.string().min(1).max(16).default('шт'),
});
export type MaterialUpsert = z.infer<typeof MaterialUpsertSchema>;

export const MaterialListResponseSchema = z.object({
  items: z.array(MaterialSchema),
  total: z.number(),
});
