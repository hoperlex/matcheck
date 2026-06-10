import { z } from 'zod';

/**
 * Единица измерения из справочника. Используется как whitelist для
 * выпадающего списка «Ед.» в позициях УПД / приёмок / отгрузок.
 *
 * В самих позициях `unit` хранится как text без FK на эту таблицу —
 * legacy-значения, которых нет в whitelist, UI показывает через
 * virtual-опцию (как в CustomerCounterpartySelect) и не теряет.
 */
export const UnitSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  okeiCode: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Unit = z.infer<typeof UnitSchema>;

export const UnitUpsertSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(128),
  okeiCode: z.string().max(8).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type UnitUpsert = z.infer<typeof UnitUpsertSchema>;

export const UnitListResponseSchema = z.object({
  items: z.array(UnitSchema),
  total: z.number(),
});
