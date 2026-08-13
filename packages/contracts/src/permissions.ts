import { z } from 'zod';
import { UserRoleSchema, type UserRole } from './auth.js';

/**
 * Матрица прав ролей: «роль × страница × действие».
 *
 * Матрица умеет и СУЖАТЬ, и РАСШИРЯТЬ. Дефолт (см. PAGE_CATALOG[].base) в
 * точности повторяет права, которые роль имеет сегодня в коде — пересечение
 * навигации веба (navItems.ts + гарды router.tsx) и allow-list'ов API
 * (app.authorize + inline-проверки). Он остаётся стартовым значением, но
 * потолком быть перестал: строка в БД задаёт итог как есть.
 *
 * Границы расширения — здесь же, в NEVER_GRANTABLE и EXPANDABLE_WRITE_ROLES,
 * и продублированы в рантайм-резолвере: БД правят и руками.
 *
 * Роли admin здесь нет вовсе — она обходит матрицу целиком (иначе админ
 * способен снять себе доступ к вкладке «Роли» и остаться без пути назад).
 */

export const PageActionSchema = z.enum(['view', 'create', 'edit', 'delete', 'review']);
export type PageAction = z.infer<typeof PageActionSchema>;

/**
 * Порядок колонок в UI и в любых перечислениях.
 *
 * `review` («Проверять») добавлен ПОСЛЕДНИМ намеренно: четыре привычные колонки
 * не должны съезжать. Само действие применимо только к Операциям — на прочих
 * страницах ячейка не рисуется (см. isActionApplicable).
 */
export const PAGE_ACTIONS = ['view', 'create', 'edit', 'delete', 'review'] as const;

export const PAGE_ACTION_LABELS: Record<PageAction, string> = {
  view: 'Просмотр',
  create: 'Создавать',
  edit: 'Редактировать',
  delete: 'Удалять',
  review: 'Проверять',
};

/**
 * Действия, без которых мобильный клиент КПП перестаёт работать. Из НИХ, а не
 * из всего PAGE_ACTIONS, строится LOCKED_CELLS.
 *
 * Разделение существенное: любое новое действие, добавленное в PAGE_ACTIONS,
 * иначе автоматически становилось бы у инспектора включённым и неснимаемым —
 * даже если планшет о нём не подозревает. Так и вышло бы с `review`: отметка
 * проверки качества мобильному приложению не нужна вовсе.
 */
export const MOBILE_REQUIRED_ACTIONS: PageAction[] = ['view', 'create', 'edit', 'delete'];

/**
 * Роли, участвующие в матрице. admin исключён намеренно (см. заголовок).
 * В БД это закреплено CHECK-констрейнтом role <> 'admin'.
 */
export type ManagedRole = Exclude<UserRole, 'admin'>;
export const MANAGED_ROLES: ManagedRole[] = [
  'manager',
  'inspector_kpp',
  'contractor',
  'monitor',
];

export const ManagedRoleSchema = UserRoleSchema.exclude(['admin']);

export const PAGE_IDS = [
  'operations.deliveries',
  'operations.shipments',
  'documents.list',
  'documents.mail',
  'documents.extra_only',
  'materials_journal',
  'stats',
  'references.sites',
  'references.customer_counterparties',
  'references.suppliers',
  'references.units',
  'references.mol',
  'references.counterparties_legacy',
  'references.responsible_persons',
  'references.materials',
  'references.assets',
  'admin.users',
  'admin.roles',
  'admin.llm_providers',
  'admin.prompts',
  'admin.edo_accounts',
  'admin.mail_accounts',
  'admin.settings',
] as const;

export const PageIdSchema = z.enum(PAGE_IDS);
export type PageId = (typeof PAGE_IDS)[number];

/**
 * UI-группа. Разделы НЕ хранятся отдельными строками в БД и не участвуют в
 * резолвере: заголовок раздела в интерфейсе — просто групповой контрол над
 * дочерними страницами, а видимость раздела = some(children.view). Иначе
 * появились бы два независимых источника «закрытости», которые расходятся.
 */
export const PAGE_GROUPS = [
  'operations',
  'documents',
  'materials',
  'stats',
  'references',
  'admin',
] as const;
export type PageGroup = (typeof PAGE_GROUPS)[number];

export const PAGE_GROUP_LABELS: Record<PageGroup, string> = {
  operations: 'Операции',
  documents: 'Документы',
  materials: 'История поступлений',
  stats: 'Статистика',
  references: 'Справочники',
  admin: 'Администрирование',
};

export type PagePermissions = Record<PageAction, boolean>;

export const PagePermissionsSchema = z.object({
  view: z.boolean(),
  create: z.boolean(),
  edit: z.boolean(),
  delete: z.boolean(),
  review: z.boolean(),
});

export type PageCatalogEntry = {
  id: PageId;
  group: PageGroup;
  label: string;
  /** Какие из 4 действий вообще осмысленны для страницы. */
  actions: PageAction[];
  /**
   * Базовые (сегодняшние) права: какие роли имеют это действие ПРЯМО СЕЙЧАС.
   * Это потолок — матрица может только снять галочку, но не поставить там,
   * где роли нет в списке. admin в списках не указывается: он вне матрицы.
   */
  base: Partial<Record<PageAction, ManagedRole[]>>;
  /** Роут существует, но вкладки в меню нет (доступ только по прямой ссылке). */
  hidden?: boolean;
};

const CRUD: PageAction[] = ['view', 'create', 'edit', 'delete'];

/** Операции — единственные страницы, где есть отметка проверки качества. */
const CRUD_WITH_REVIEW: PageAction[] = [...CRUD, 'review'];

/**
 * Справочники заказчика ведут себя одинаково: смотреть и править может
 * manager, удалять — только admin (canDelete = role === 'admin' на всех
 * страницах references/*).
 */
const referenceBase: PageCatalogEntry['base'] = {
  view: ['manager'],
  create: ['manager'],
  edit: ['manager'],
  delete: [],
};

/**
 * Операции: приёмки и отгрузки. Живут на одном роуте /operations и
 * различаются query-параметром ?type=, поэтому в матрице это две отдельные
 * страницы, а не одна.
 *
 * `review` — отметка проверки качества (PATCH /deliveries|shipments/:id/review),
 * единственная запись, которую оставляет monitor'у глобальный read-only-хук в
 * server.ts. Это ОТДЕЛЬНОЕ действие, а не часть edit, и вот почему.
 *
 * Одной ячейкой edit помечены четыре маршрута с разными allow-list: review
 * открыт admin/manager/monitor, а flags, supplier-from-directory, link-source и
 * share-link — только admin/manager. Пока отметка сидела внутри edit, право
 * монитора было БАЗОВЫМ, то есть никогда не считалось расширением и не обходило
 * authorize. Итог: галочка «Редактировать» у монитора включена, означает одну
 * лишь отметку, а выдать ему настоящую правку невозможно — включать нечего.
 * Разведя действия, мы возвращаем edit его прямой смысл: у монитора он снят по
 * умолчанию и выдаётся администратором как обычное расширение.
 */
const operationsBase: PageCatalogEntry['base'] = {
  view: ['manager', 'inspector_kpp', 'contractor', 'monitor'],
  create: ['manager', 'inspector_kpp'],
  edit: ['manager', 'inspector_kpp'],
  delete: ['manager', 'inspector_kpp'],
  review: ['manager', 'monitor'],
};

/** Вкладки «Администрирования» — целиком прерогатива admin. */
const adminOnly: PageCatalogEntry['base'] = {};

export const PAGE_CATALOG: PageCatalogEntry[] = [
  {
    id: 'operations.deliveries',
    group: 'operations',
    label: 'Приёмки',
    actions: CRUD_WITH_REVIEW,
    base: operationsBase,
  },
  {
    id: 'operations.shipments',
    group: 'operations',
    label: 'Отгрузки',
    actions: CRUD_WITH_REVIEW,
    base: operationsBase,
  },
  {
    id: 'documents.list',
    group: 'documents',
    label: 'Документы',
    actions: CRUD,
    // contractor видит /documents, но только свои строки (row-level scope в
    // lib/contractor-scope.ts). Писать не может — read-only роль.
    base: {
      view: ['manager', 'contractor'],
      create: ['manager'],
      edit: ['manager'],
      delete: ['manager'],
    },
  },
  {
    id: 'documents.mail',
    group: 'documents',
    label: 'Разбор почты',
    // Письма не создают вручную (их приносит воркер) и не удаляют из UI —
    // их «разбирают»: resolve / reject.
    actions: ['view', 'edit'],
    base: { view: ['manager'], edit: ['manager'] },
  },
  {
    id: 'documents.extra_only',
    group: 'documents',
    label: 'Комплекты без документов',
    actions: ['view'],
    base: { view: ['manager'] },
  },
  {
    id: 'materials_journal',
    group: 'materials',
    label: 'История поступлений',
    actions: ['view'],
    // API отдаёт журнал ещё и monitor'у, но пункта меню у него нет
    // (navItems.ts) — в дефолте берём пересечение, см. заголовок файла.
    base: { view: ['manager', 'inspector_kpp'] },
  },
  {
    id: 'stats',
    group: 'stats',
    label: 'Статистика',
    actions: ['view'],
    base: { view: ['manager'] },
  },
  {
    id: 'references.sites',
    group: 'references',
    label: 'Объекты',
    actions: CRUD,
    base: referenceBase,
  },
  {
    id: 'references.customer_counterparties',
    group: 'references',
    label: 'Контрагенты',
    actions: CRUD,
    base: referenceBase,
  },
  {
    id: 'references.suppliers',
    group: 'references',
    label: 'Поставщики',
    actions: CRUD,
    base: referenceBase,
  },
  {
    id: 'references.units',
    group: 'references',
    label: 'Единицы измерения',
    actions: CRUD,
    base: referenceBase,
  },
  {
    id: 'references.mol',
    group: 'references',
    label: 'МОЛ',
    // Внешняя read-only БД ФОТ — писать туда нечем.
    actions: ['view'],
    base: { view: ['manager'] },
  },
  {
    id: 'references.counterparties_legacy',
    group: 'references',
    label: 'Контрагенты (операционные)',
    actions: CRUD,
    base: referenceBase,
    hidden: true,
  },
  {
    id: 'references.responsible_persons',
    group: 'references',
    label: 'Ответственные лица',
    actions: CRUD,
    base: referenceBase,
    hidden: true,
  },
  {
    id: 'references.materials',
    group: 'references',
    label: 'Материалы',
    actions: CRUD,
    base: referenceBase,
    hidden: true,
  },
  {
    id: 'references.assets',
    group: 'references',
    label: 'Оборудование',
    actions: CRUD,
    base: referenceBase,
    hidden: true,
  },
  {
    id: 'admin.users',
    group: 'admin',
    label: 'Пользователи',
    // Пользователь заводится через самостоятельную регистрацию, админ его
    // только активирует и правит — «Создавать» на этой странице нечего.
    actions: ['view', 'edit', 'delete'],
    base: adminOnly,
  },
  {
    id: 'admin.roles',
    group: 'admin',
    label: 'Роли',
    // Список ролей фиксирован (pg enum) — правится только матрица доступа.
    actions: ['view', 'edit'],
    base: adminOnly,
  },
  {
    id: 'admin.llm_providers',
    group: 'admin',
    label: 'LLM провайдеры',
    actions: CRUD,
    base: adminOnly,
  },
  {
    id: 'admin.prompts',
    group: 'admin',
    label: 'Промпты',
    actions: CRUD,
    base: adminOnly,
  },
  {
    id: 'admin.edo_accounts',
    group: 'admin',
    label: 'ЭДО',
    // Учётка ЭДО не редактируется — её пересоздают (PATCH-роута нет).
    actions: ['view', 'create', 'delete'],
    base: adminOnly,
  },
  {
    id: 'admin.mail_accounts',
    group: 'admin',
    label: 'Почта',
    actions: CRUD,
    base: adminOnly,
  },
  {
    id: 'admin.settings',
    group: 'admin',
    label: 'Настройки',
    actions: ['view', 'edit'],
    base: adminOnly,
  },
];

export const PAGE_BY_ID: Record<PageId, PageCatalogEntry> = Object.fromEntries(
  PAGE_CATALOG.map((p) => [p.id, p]),
) as Record<PageId, PageCatalogEntry>;

export function isActionApplicable(page: PageId, action: PageAction): boolean {
  return PAGE_BY_ID[page]?.actions.includes(action) ?? false;
}

/** Полная матрица прав: роль → страница → 4 флага. */
export type PermissionMatrix = Record<ManagedRole, Record<PageId, PagePermissions>>;

function buildDefaultMatrix(): PermissionMatrix {
  const out = {} as PermissionMatrix;
  for (const role of MANAGED_ROLES) {
    const byPage = {} as Record<PageId, PagePermissions>;
    for (const page of PAGE_CATALOG) {
      // Цикл по PAGE_ACTIONS, а не перечисление полей: добавленное действие
      // иначе молча оставалось бы false у всех ролей, и дефолт разошёлся бы с
      // каталогом.
      const perms = {} as PagePermissions;
      for (const action of PAGE_ACTIONS) {
        perms[action] = page.base[action]?.includes(role) ?? false;
      }
      byPage[page.id] = perms;
    }
    out[role] = byPage;
  }
  return out;
}

/**
 * Дефолт = сегодняшнее поведение. Единственный источник правды: миграция
 * таблицу НЕ засеивает (строка в БД = override, её отсутствие = «как в
 * дефолте»), иначе дефолт застыл бы слепком на день выката.
 */
export const DEFAULT_MATRIX: PermissionMatrix = buildDefaultMatrix();

export function defaultFor(role: ManagedRole, page: PageId): PagePermissions {
  return DEFAULT_MATRIX[role][page];
}

/**
 * Ячейки, которые снять нельзя ни через UI, ни через API, и которые
 * рантайм-резолвер форсирует в true даже при ручной правке БД.
 *
 * Причина одна: мобильный клиент КПП не обрабатывает 403 ни на одном экране —
 * он залипает молча, без сообщения пользователю. Планшет на объекте, которому
 * закрыли любое из этих действий, просто перестанет работать, и инспектор не
 * поймёт почему.
 *
 * Заблокированы 4 действия обеих страниц Операций:
 *   view   — без него мертвы GET /sync и GET /events;
 *   create — не создать приёмку и не загрузить фото (presign/confirm);
 *   edit   — мобилка правит существующие записи тем же POST-upsert;
 *   delete — мобилка помечает на удаление (POST /:id/mark-deletion).
 *
 * Источник списка — MOBILE_REQUIRED_ACTIONS, а НЕ PAGE_ACTIONS: замок обязан
 * покрывать ровно то, чем пользуется планшет. Иначе каждое новое действие
 * (первым таким стал `review`) автоматически становилось бы у инспектора
 * включённым и неснимаемым без единой строки обоснования.
 *
 * TODO: снять замок, когда мобильный клиент научится показывать 403
 * пользователю (тогда строку «Инспектор КПП × Операции» можно будет
 * настраивать, как остальные).
 */
export const LOCKED_CELLS: ReadonlySet<string> = new Set(
  (['operations.deliveries', 'operations.shipments'] as const).flatMap((page) =>
    MOBILE_REQUIRED_ACTIONS.map((action) => `inspector_kpp:${page}:${action}`),
  ),
);

export function cellKey(role: ManagedRole, page: PageId, action: PageAction): string {
  return `${role}:${page}:${action}`;
}

export function isLockedCell(role: ManagedRole, page: PageId, action: PageAction): boolean {
  return LOCKED_CELLS.has(cellKey(role, page, action));
}

/**
 * Права, которые нельзя выдать НИКОГДА и НИКОМУ, даже прямым UPDATE в БД.
 *
 * `admin.roles` — сама эта матрица: получив её, роль управляет доступом всех
 * остальных, включая себя, и вернуть контроль было бы некому.
 *
 * `admin.users:edit|delete` — тот же результат окольным путём: PATCH
 * пользователя принимает любую роль, включая admin, и позволяет сменить пароль
 * существующему администратору. Открывать это можно будет только вместе с
 * ограничениями делегата (не назначать admin, не трогать админов и себя).
 */
export const NEVER_GRANTABLE: ReadonlySet<string> = new Set<string>([
  ...PAGE_ACTIONS.map((action) => `admin.roles:${action}`),
  'admin.users:edit',
  'admin.users:delete',
]);

export function isNeverGrantable(page: PageId, action: PageAction): boolean {
  return NEVER_GRANTABLE.has(`${page}:${action}`);
}

/**
 * Роли, которым запись не выдаётся НИГДЕ.
 *
 * Подрядчик видит только свои записи, но пути записи принадлежность подрядчику
 * не сверяют вовсе. Пока этой сверки нет, любое выданное ему create/edit/delete
 * означало бы право писать в чужое — отдельная задача про write-scope.
 */
export const WRITE_BLOCKED_ROLES: ManagedRole[] = ['contractor'];

/**
 * Роли с ограничением видимости по строкам: inspector_kpp — по siteId.
 * Для них запись безопасна лишь там, где скоуп реально проверяется.
 *
 * monitor в этот список НЕ входит: он, как и manager, видит все объекты, и
 * выданная запись не открывает ему ничего, чего он уже не видит. Раньше он
 * был заперт заодно с подрядчиком — это и была причина серых галочек.
 */
export const ROW_SCOPED_ROLES: ManagedRole[] = ['inspector_kpp'];

/** Страницы, где у записей есть владелец (объект или подрядчик). */
export const ROW_SCOPED_PAGES: PageId[] = [
  'operations.deliveries',
  'operations.shipments',
  'documents.list',
];

/**
 * Где скоуп на путях ЗАПИСИ действительно проверяется: upsert операций сверяет
 * siteId у inspector_kpp (routes/deliveries.ts, foreign-site). Маршруты
 * документов не сверяют объект вовсе, поэтому их здесь нет.
 */
export const WRITE_SCOPE_ENFORCED: ReadonlySet<string> = new Set([
  'inspector_kpp:operations.deliveries',
  'inspector_kpp:operations.shipments',
]);

/**
 * Можно ли ВЫДАТЬ роли право, которого нет в её дефолте.
 *
 * Вопрос не «кому мы доверяем», а «у кого выданная запись откроет ЧУЖИЕ
 * данные». Отсюда порядок проверок: сперва роли, которым запись закрыта
 * совсем, затем страницы без владельца у записей (справочники, админка,
 * почта — там «своей» строки не бывает), затем роли без ограничения видимости,
 * и лишь в остатке — требование реально работающего скоупа.
 *
 * `review` идёт вместе с записью, а не с просмотром: хендлер
 * PATCH /deliveries|shipments/:id/review выбирает запись по одному id, без
 * сверки siteId, — иначе роль с ограниченной видимостью проверяла бы чужую
 * операцию по известному UUID.
 *
 * Сужение этой функцией не ограничивается — снять можно почти всё (кроме
 * LOCKED_CELLS, они про работоспособность мобильного клиента).
 */
export function canExpand(role: ManagedRole, page: PageId, action: PageAction): boolean {
  if (!isActionApplicable(page, action)) return false;
  if (isNeverGrantable(page, action)) return false;
  if (action === 'view') return true;
  if (WRITE_BLOCKED_ROLES.includes(role)) return false;
  if (!ROW_SCOPED_PAGES.includes(page)) return true;
  if (!ROW_SCOPED_ROLES.includes(role)) return true;
  return WRITE_SCOPE_ENFORCED.has(`${role}:${page}`);
}

/**
 * Почему право нельзя выдать — для тултипа в матрице. null = можно.
 * Формулировки конкретные: «этой роли только просмотр» ничего не объясняет.
 */
export function expandBlockReason(
  role: ManagedRole,
  page: PageId,
  action: PageAction,
): string | null {
  if (canExpand(role, page, action)) return null;
  if (!isActionApplicable(page, action)) return null;
  if (isNeverGrantable(page, action)) {
    return 'Это право не выдаётся ни одной роли: через него можно получить полномочия администратора и отобрать доступ у остальных';
  }
  if (WRITE_BLOCKED_ROLES.includes(role)) {
    return 'Подрядчик видит только свои записи, но пути записи принадлежность не сверяют — выданное право позволило бы менять чужое';
  }
  return `На этой странице у роли нет ограничения по своим данным на путях записи — выданное право открыло бы чужие записи`;
}

// ──────────────────────────── API-контракты ────────────────────────────

const PageMapSchema = z.record(PageIdSchema, PagePermissionsSchema);

/**
 * GET /api/v1/me/permissions — эффективные права ТЕКУЩЕГО пользователя.
 *
 * Отдельная ручка, а не поле в UserDto: UserDto зарегистрирован в openapi и
 * из него генерируется Kotlin-клиент мобилки. Новое поле там — дифф
 * контракта, пересборка клиента и риск strict-парсера ради данных, которые
 * мобильному приложению не нужны.
 */
export const MePermissionsResponseSchema = z.object({
  // Чьи это права. Фронт сверяет с текущим пользователем перед записью в
  // стор: запрос мог стартовать до смены пользователя во вкладке и
  // завершиться после неё.
  userId: z.string().uuid(),
  role: UserRoleSchema,
  // false = PERMISSIONS_ENFORCE выключен. В этом режиме сервер отдаёт
  // ДЕФОЛТЫ (игнорируя сохранённые overrides) и ничего не запрещает —
  // иначе «выключить флаг» не было бы полным откатом: UI продолжал бы
  // прятать кнопки по overrides, которые сервер уже не применяет.
  enforced: z.boolean(),
  pages: PageMapSchema,
  /**
   * Что РЕАЛЬНО доступно, помимо «страница × действие».
   *
   * Ячейка матрицы шире одного маршрута: у `operations.*:edit` четыре маршрута
   * с разными allow-list. Интерфейс, спрашивающий только права страницы,
   * нарисует инспектору кнопку «Флаги» — и она ответит 403. Список считает
   * сервер (там сходятся матрица и allow-list); фронт эту логику не повторяет.
   *
   * Необязательное: старый веб поле игнорирует, а новый при его отсутствии
   * работает по дефолтам роли — инвариант «нет данных ≠ нет прав».
   */
  capabilities: z.array(z.string()).optional(),
});
export type MePermissionsResponse = z.infer<typeof MePermissionsResponseSchema>;

/** GET /api/v1/admin/role-permissions — вся матрица + каталог для отрисовки. */
export const RolePermissionsResponseSchema = z.object({
  enforced: z.boolean(),
  // Каталог отдаём с сервера, а не берём на фронте из этого же пакета:
  // при раздельном выкате веба и API строки матрицы иначе разъедутся.
  catalog: z.array(
    z.object({
      id: PageIdSchema,
      group: z.enum(PAGE_GROUPS),
      label: z.string(),
      actions: z.array(PageActionSchema),
      hidden: z.boolean(),
      base: z.record(PageActionSchema, z.array(ManagedRoleSchema)),
    }),
  ),
  matrix: z.record(ManagedRoleSchema, PageMapSchema),
  lockedCells: z.array(z.string()),
});
export type RolePermissionsResponse = z.infer<typeof RolePermissionsResponseSchema>;

/**
 * PATCH /api/v1/admin/role-permissions — дельта ячеек, а не вся матрица.
 *
 * Дельта решает конкурентность сама: два админа, правящие разные ячейки, не
 * конфликтуют. При «PUT всей матрицы» правка второго молча затирала бы
 * правку первого, и понадобился бы optimistic concurrency.
 */
export const RolePermissionsPatchSchema = z.object({
  changes: z
    .array(
      z.object({
        role: ManagedRoleSchema,
        page: PageIdSchema,
        action: PageActionSchema,
        allowed: z.boolean(),
      }),
    )
    .min(1)
    .max(200),
});
export type RolePermissionsPatch = z.infer<typeof RolePermissionsPatchSchema>;
