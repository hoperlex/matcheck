import { z } from 'zod';

// Допустимая длина 1-16: исторически было 5, но при сиде объектов из
// внешнего источника (см. миграция 0054) встречаются коды по 6 символов
// (ПРИМ22 и т.п.), а также с точкой (МЕ1.0, МЕ2.0) — расширили regex.
// Менеджер локальные коды короче 5 делать никто не запрещает.
export const SiteCodeSchema = z
  .string()
  .min(1)
  .max(16)
  .regex(/^[A-Za-zА-Яа-я0-9_.\-]+$/, 'Code allows letters, digits, dash, dot and underscore');

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
