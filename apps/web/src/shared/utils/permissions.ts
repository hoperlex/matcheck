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
  /**
   * Что реально доступно поверх «страница × действие». null — сервер списка не
   * прислал (старый API или права не приехали): тогда действует то же правило,
   * что и для страниц — «не знаем» трактуем как «как раньше», см. hasCapability.
   */
  capabilities: ReadonlySet<string> | null;
};

const ALL_ALLOWED: PagePermissions = {
  view: true,
  create: true,
  edit: true,
  delete: true,
  review: true,
  reparse: true,
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
  return { role, enforced: false, pages: permissionsForRole(role), capabilities: null };
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
  return {
    role: payload.role,
    enforced: payload.enforced,
    pages,
    // Поле необязательное: старый API его не отдаёт. Отличаем «не прислал»
    // (null → работаем как раньше) от «прислал пустой» (ничего не доступно).
    capabilities: payload.capabilities ? new Set(payload.capabilities) : null,
  };
}

/**
 * Доступна ли возможность — точная проверка там, где права страницы слишком
 * грубые.
 *
 * `can(page, action)` отвечает «разрешено ли действие в принципе», а одна ячейка
 * покрывает маршруты с разными allow-list: у инспектора `operations.*:edit`
 * включён, но «Флаги» ему закрыты. Кнопку такого рода гейтим отсюда.
 *
 * Список не приехал — НЕ отказ, как и с правами страниц: показываем по-старому,
 * сервер всё равно проверит сам. Иначе первый же таймаут спрятал бы у всех
 * половину интерфейса.
 */
export function hasCapability(perms: PermissionSet | null, capability: string): boolean {
  if (!perms?.capabilities) return true;
  return perms.capabilities.has(capability);
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
