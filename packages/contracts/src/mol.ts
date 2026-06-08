import { z } from 'zod';

/**
 * МОЛ (материально-ответственное лицо) из внешней БД ФОТ (read-only).
 * Источник — представление `public.mol_persons`. В отличие от внутренней
 * сущности ResponsiblePerson, этот справочник не редактируется в MATCHECK
 * и обновляется на стороне ФОТ при найме/увольнении.
 *
 * employeeId — стабильный ключ сотрудника в ФОТ (bigint). Именно его следует
 * хранить в записи поставки как ссылку на МОЛ (не ФИО).
 */
export const MolPersonSchema = z.object({
  employeeId: z.number().int(),
  fullName: z.string(),
  tabNumber: z.string().nullable(),
  positionName: z.string(),
});
export type MolPerson = z.infer<typeof MolPersonSchema>;

export const MolListResponseSchema = z.object({
  items: z.array(MolPersonSchema),
  total: z.number().int().nonnegative(),
  // true — список отдан из устаревшего кэша (ФОТ-БД была недоступна) либо
  // пуст из-за ошибки доступа. UI показывает подпись «список мог устареть».
  stale: z.boolean(),
  // ISO-время, когда список реально получен из ФОТ; null — ещё ни разу.
  fetchedAt: z.string().nullable(),
});
export type MolListResponse = z.infer<typeof MolListResponseSchema>;
