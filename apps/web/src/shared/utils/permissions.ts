/**
 * Права текущего пользователя на стороне веба — чистая логика, без React,
 * стора и сети.
 *
 * Источник правды — сервер (GET /api/v1/me/permissions). Здесь только разбор
 * ответа, доступ к ячейкам и ОДИН важный инвариант:
 *
 *   отсутствие данных ≠ отсутствие прав.
 *
 * Права могут не приехать по десятку причин (404 на старом API, 5xx, обрыв
 * сети, таймаут, вкладка проснулась раньше сервера). Ни одна из них не должна
 * оставлять человека перед пустым меню — во всех таких случаях действует
 * DEFAULT_PERMISSIONS, то есть ровно те права, что были до появления матрицы.
 * Матрица умеет только сужать, поэтому «не знаем» безопаснее трактовать как
 * «как раньше»: сервер всё равно проверяет каждое действие сам.
 */
import {
  DEFAULT_MATRIX,
  PAGE_BY_ID,
  PAGE_CATALOG,
  type MePermissionsResponse,
  type ManagedRole,
  type PageAction,
  type PageGroup,
  type PageId,
  type PagePermissions,
  type UserRole,
} from '@matcheck/contracts';

export type PermissionSet = {
  role: UserRole;
  /** false — сервер матрицу не применяет (PERMISSIONS_ENFORCE=0). */
  enforced: boolean;
  pages: Record<PageId, PagePermissions>;
};

const ALL_ALLOWED: PagePermissions = {
  view: true,
  create: true,
  edit: true,
  delete: true,
  review: true,
};

/**
 * Копия, а не ссылка на DEFAULT_MATRIX: возвращённый набор попадает в стор и
 * в компоненты, и случайная мутация испортила бы общий для всего приложения
 * дефолт — с эффектом «у части ролей права поехали после захода на страницу».
 */
function permissionsForRole(role: UserRole): Record<PageId, PagePermissions> {
  // admin вне матрицы — и на сервере тоже (резолвер пропускает его целиком).
  if (role === 'admin') {
    return Object.fromEntries(PAGE_CATALOG.map((p) => [p.id, { ...ALL_ALLOWED }])) as Record<
      PageId,
      PagePermissions
    >;
  }
  const base = DEFAULT_MATRIX[role as ManagedRole];
  return Object.fromEntries(
    PAGE_CATALOG.map((p) => [p.id, { ...base[p.id] }]),
  ) as Record<PageId, PagePermissions>;
}

/**
 * Права «как было до матрицы» — фолбэк, когда сервер их не отдал.
 *
 * Не отдельный слепок, а тот же DEFAULT_MATRIX из контрактов, что и на
 * сервере: два независимых списка неизбежно разъехались бы, и веб начал бы
 * прятать кнопки, которые API разрешает.
 */
export function defaultPermissions(role: UserRole): PermissionSet {
  return { role, enforced: false, pages: permissionsForRole(role) };
}

/**
 * Разбор ответа сервера.
 *
 * Страницы, которых в ответе нет, берём из дефолта роли: при раздельном
 * выкате веб может знать страницу, о которой API ещё не в курсе, и «нет
 * ключа» тогда означает «сервер о ней не рассказал», а не «запрещено».
 */
export function buildPermissionSet(payload: MePermissionsResponse): PermissionSet {
  const base = permissionsForRole(payload.role);
  const pages = {} as Record<PageId, PagePermissions>;
  for (const page of PAGE_CATALOG) {
    const fromServer = payload.pages[page.id];
    pages[page.id] = fromServer ? { ...fromServer } : { ...base[page.id] };
  }
  return { role: payload.role, enforced: payload.enforced, pages };
}

/**
 * Разрешено ли действие. `perms === null` (ещё не загрузились или не удалось
 * загрузить) — НЕ отказ: см. заголовок файла.
 */
export function can(
  perms: PermissionSet | null,
  page: PageId,
  action: PageAction,
  fallbackRole?: UserRole,
): boolean {
  const source = perms ?? (fallbackRole ? defaultPermissions(fallbackRole) : null);
  if (!source) return true;
  // Неприменимое действие (например «Удалять» у Статистики) права не имеет
  // в принципе — вызывающему проще получить false, чем помнить каталог.
  if (!PAGE_BY_ID[page]?.actions.includes(action)) return false;
  return source.pages[page]?.[action] ?? true;
}

export function canView(
  perms: PermissionSet | null,
  page: PageId,
  fallbackRole?: UserRole,
): boolean {
  return can(perms, page, 'view', fallbackRole);
}

/**
 * Виден ли раздел меню — то есть доступна ли ХОТЬ ОДНА его страница.
 *
 * Разделы своих строк в БД не имеют: два независимых источника «закрытости»
 * (раздел и страницы) неизбежно разошлись бы.
 */
export function canViewGroup(
  perms: PermissionSet | null,
  group: PageGroup,
  fallbackRole?: UserRole,
): boolean {
  return PAGE_CATALOG.filter((p) => p.group === group).some((p) =>
    canView(perms, p.id, fallbackRole),
  );
}
