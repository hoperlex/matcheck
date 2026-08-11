import {
  DEFAULT_MATRIX,
  MANAGED_ROLES,
  PAGE_ACTIONS,
  PAGE_BY_ID,
  canExpand,
  isActionApplicable,
  isLockedCell,
  type ManagedRole,
  type PageAction,
  type PageId,
  type PagePermissions,
  type PermissionMatrix,
} from '@matcheck/contracts';
import type { UserRole } from '@matcheck/contracts';

/**
 * Резолвер прав. Единственное место, где решается «можно или нет».
 *
 * Порядок проверок здесь — часть контракта фичи, а не деталь реализации:
 * каждый шаг закрывает конкретный способ выстрелить себе в ногу, и все они
 * продублированы на входе в PATCH. Двойная защита нужна потому, что БД
 * правят и руками.
 */

/** Overrides, вычитанные из role_page_permissions: ключ `${role}:${pageId}`. */
export type OverrideMap = ReadonlyMap<string, PagePermissions>;

export function overrideKey(role: ManagedRole, page: PageId): string {
  return `${role}:${page}`;
}

/**
 * Эффективное право роли на (страница, действие).
 *
 * @param overrides сохранённые отклонения от дефолта; пустая карта = «всё как в коде».
 */
export function isAllowed(
  overrides: OverrideMap,
  role: UserRole,
  page: PageId,
  action: PageAction,
): boolean {
  // 1. admin вне матрицы. Иначе он способен снять себе доступ к вкладке
  //    «Роли» и остаться без пути назад — чинить пришлось бы psql'ем на бою.
  if (role === 'admin') return true;

  const managed = role as ManagedRole;

  // 2. Страница или действие, которых нет в каталоге, не режем: каталог
  //    меняется вместе с релизом, и новый маршрут не должен превращаться в
  //    403 из-за того, что запись о нём ещё не доехала.
  if (!PAGE_BY_ID[page]) return true;
  if (!isActionApplicable(page, action)) return true;

  // 3. Ячейки, без которых мобильный клиент КПП перестаёт работать. Форсируем
  //    true ДО чтения overrides: прямой UPDATE в psql не должен ронять
  //    планшеты на объектах (403 мобилка не показывает — залипает молча).
  if (isLockedCell(managed, page, action)) return true;

  const base = DEFAULT_MATRIX[managed]?.[page]?.[action] ?? false;
  const row = overrides.get(overrideKey(managed, page));
  const stored = row?.[action];

  // 4. Границы РАСШИРЕНИЯ проверяются здесь, а не только в PATCH: строку
  //    можно записать прямым UPDATE, и тогда единственная преграда — эта.
  //    Проверяем ровно расширение (дефолт запрещал, строка разрешает), чтобы
  //    базовое право осталось рабочим: у monitor, например, operations.*:edit
  //    в дефолте есть ради отметки проверки, и запрет write-расширения не
  //    должен его отнимать.
  if (!base && stored === true && !canExpand(managed, page, action)) return false;

  // 5. Строка в БД задаёт итог как есть — и сужение, и расширение.
  if (stored !== undefined) return stored;

  // 6. Строки нет — «как в коде».
  return base;
}

/**
 * Является ли разрешение РАСШИРЕНИЕМ — то есть правом, которого у роли нет в
 * дефолте и которое админ выдал явной строкой в БД.
 *
 * Ровно на этом различии держится безопасность отметки в plugins/permissions.ts:
 * обходить allow-list маршрута можно только по явно выданному праву. Отметка на
 * дефолтных правах открыла бы роли все маршруты ячейки, включая те, что сегодня
 * закрыты более узким authorize (monitor → редактирование операций, manager →
 * bulk-hard-delete).
 */
export function isExpanded(
  overrides: OverrideMap,
  role: UserRole,
  page: PageId,
  action: PageAction,
): boolean {
  if (role === 'admin') return false;
  const managed = role as ManagedRole;
  if (!PAGE_BY_ID[page] || !isActionApplicable(page, action)) return false;

  const base = DEFAULT_MATRIX[managed]?.[page]?.[action] ?? false;
  if (base) return false;
  if (overrides.get(overrideKey(managed, page))?.[action] !== true) return false;
  // isAllowed отсекает never-grantable и запрещённое write-расширение.
  return isAllowed(overrides, role, page, action);
}

/**
 * Эффективные права роли целиком — для GET /me/permissions и для отрисовки
 * матрицы в админке.
 */
export function effectiveFor(
  overrides: OverrideMap,
  role: UserRole,
): Record<PageId, PagePermissions> {
  const out = {} as Record<PageId, PagePermissions>;
  for (const page of Object.keys(PAGE_BY_ID) as PageId[]) {
    const perms = {} as PagePermissions;
    for (const action of PAGE_ACTIONS) {
      // Неприменимое действие в ответе всегда false: «не режем» из п.2 — про
      // enforcement, а UI не должен рисовать галочку там, где её нет смысла
      // ставить.
      perms[action] = isActionApplicable(page, action)
        ? isAllowed(overrides, role, page, action)
        : false;
    }
    out[page] = perms;
  }
  return out;
}

/** Матрица всех managed-ролей — для админского GET. */
export function fullMatrix(overrides: OverrideMap): PermissionMatrix {
  const out = {} as PermissionMatrix;
  for (const role of MANAGED_ROLES) {
    out[role] = effectiveFor(overrides, role);
  }
  return out;
}
