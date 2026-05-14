import { z } from 'zod';

export const SiteCodeSchema = z
  .string()
  .min(1)
  .max(5)
  .regex(/^[A-Za-zА-Яа-я0-9_-]+$/, 'Code allows letters, digits, dash and underscore');

export const SiteSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  fullName: z.string().nullable(),
  address: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Site = z.infer<typeof SiteSchema>;

export const SiteUpsertSchema = z.object({
  code: SiteCodeSchema,
  name: z.string().min(1).max(500),
  fullName: z.string().max(1000).nullable().optional(),
  address: z.string().max(1000).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type SiteUpsert = z.infer<typeof SiteUpsertSchema>;

export const SitePatchSchema = SiteUpsertSchema.partial();
export type SitePatch = z.infer<typeof SitePatchSchema>;

export const SiteListResponseSchema = z.object({
  items: z.array(SiteSchema),
  total: z.number(),
});
