import { inArray, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { AuthUser } from '../plugins/auth.js';

// Скоуп наблюдателя по объектам (роль observer, таблица user_sites).
//
// Контракт тот же, что у resolveContractorOpIds (lib/contractor-scope.ts):
//   null   — ограничения по объекту у пользователя нет, вызывающий фильтр не
//            добавляет;
//   []     — ограничение есть, но объектов нет: видно НИЧЕГО (вызывающий
//            добавляет `false`). Это не «видно всё»: удаление объекта
//            (CASCADE в user_sites) и пустой выбор в админке только сужают
//            доступ;
//   [...]  — видно только эти объекты.
//
// Инспектор КПП сюда намеренно НЕ входит: его ветки (`role === 'inspector_kpp'`
// + users.site_id) обслуживают планшет и остаются как были. Наблюдатель живёт
// только в вебе и только читает — записи ему не выдаются вовсе
// (WRITE_BLOCKED_ROLES в contracts/permissions.ts).

/** Список объектов, которыми ограничен пользователь, или null — без ограничения. */
export function siteScopeOf(
  user: { role?: AuthUser['role'] | string; siteIds?: readonly string[] } | undefined,
): string[] | null {
  if (!user || user.role !== 'observer') return null;
  return [...(user.siteIds ?? [])];
}

/** Входит ли объект записи в скоуп. Запись без объекта в ограниченный скоуп не входит. */
export function siteInScope(scope: string[] | null, siteId: string | null | undefined): boolean {
  if (scope === null) return true;
  return !!siteId && scope.includes(siteId);
}

/** Условие для drizzle-запроса: колонка объекта ∈ скоуп; пустой скоуп — `false`. */
export function siteScopeCondition(scope: string[], column: AnyColumn | SQL): SQL {
  if (scope.length === 0) return sql`false`;
  return inArray(column as AnyColumn, scope);
}

/**
 * Литерал для сырого SQL (`col = ANY(...)`). JS-массив прямо в шаблоне drizzle
 * разворачивает в список плейсхолдеров, и Postgres получает не массив.
 */
export function siteScopeArraySql(scope: string[]): SQL {
  return sql`ARRAY[${sql.join(
    scope.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
}

/**
 * Пересечение пользовательского фильтра «Объект» со скоупом. Фильтр не может
 * расширить скоуп: `?siteIds=C` у наблюдателя с [A, B] даёт пусто, а не C.
 */
export function intersectSiteFilter(scope: string[] | null, requested: string[]): string[] {
  if (scope === null) return requested;
  if (requested.length === 0) return scope;
  return requested.filter((id) => scope.includes(id));
}
