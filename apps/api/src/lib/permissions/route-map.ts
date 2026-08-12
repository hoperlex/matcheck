import type { FastifyRequest } from 'fastify';
import type { ManagedRole, PageAction, PageId } from '@matcheck/contracts';

/**
 * Реестр «маршрут → право». Единственное место, где HTTP-мир связан с
 * матрицей прав; 187 маршрутов перечислены явно.
 *
 * Почему реестр, а не preHandler на каждом роуте. Точечная расстановка
 * потребовала бы правок в самых нагруженных файлах (deliveries, shipments,
 * source-documents), а забытый preHandler на новом роуте давал бы тихую
 * дыру, которую нельзя поймать тестом (нельзя проверить отсутствие того,
 * чего нет). Реестр же проверяется тестом permissions-registry: каждый
 * зарегистрированный в Fastify маршрут обязан быть здесь ключом — забыл, и
 * CI красный.
 *
 * Ключ — `${METHOD} ${routeOptions.url}`, то есть ШАБЛОН роута (с :params),
 * а не сырой req.url. Тот же принцип, что у MONITOR_WRITE_ROUTES в
 * server.ts и публичного префикса в plugins/auth.ts: сырой url подделывается
 * (`/api/v1/public/../sites`), шаблон выдаёт роутер уже после матчинга.
 */

/**
 * Метаданные, общие для всех классов правил.
 *
 * `capability` — стабильное имя возможности, которое сервер отдаёт интерфейсу в
 * /me/permissions. Нужно там, где ячейка матрицы шире одного маршрута: у
 * `operations.*:edit` четыре маршрута с разными allow-list, и кнопка «Флаги»
 * обязана исчезать не по ячейке, а по фактическому доступу — иначе она
 * останется на экране и вернёт 403.
 *
 * `expandableBy` — КОМУ позволено обойти allow-list маршрута по праву, выданному
 * матрицей сверх дефолта. Решение пер-ролевое, и общий флаг «нельзя расширять»
 * здесь не работает: `flags` закрыт для inspector_kpp (у которого базовый edit
 * есть), но открывать его монитору мы как раз хотим — ради этого затевалось
 * разделение прав. Отсутствие поля = прежнее поведение, расширение допускается
 * всем, кто прошёл проверки матрицы.
 */
export type RuleMeta = {
  capability?: string;
  expandableBy?: ManagedRole[];
};

export type RouteRule = RuleMeta &
  (
  /** Право известно до чтения тела — проверяется глобальным onRequest-хуком. */
  | { kind: 'static'; page: PageId; action: PageAction }
  /** Страница зависит от тела запроса — проверяется глобальным preHandler. */
  | { kind: 'dynamic'; resolve: (req: FastifyRequest) => { page: PageId; action: PageAction } }
  /**
   * Страница или действие неизвестны до обращения к БД — хендлер сам зовёт
   * assertPermission(). Хуки такой маршрут пропускают; строка нужна, чтобы
   * тест реестра видел, что маршрут не забыт, а сознательно проверяется
   * внутри.
   */
  | { kind: 'in-handler'; note: string }
  /** Сознательно вне матрицы. */
  | { kind: 'always'; note: string }
  /**
   * Разрыв «API щедрее UI»: маршрут доступен ролям из `roles` исторически, хотя
   * страницы в вебе у них нет.
   *
   * Эти роли идут МИМО матрицы — сегодняшний доступ сохраняется, и снятая
   * галочка его не отбирает (маршрут для них попросту вне матрицы; сузить его
   * — отдельное согласование, этап 7). Всем остальным ролям маршрут открывает
   * только явное расширение указанной пары page:action.
   *
   * Почему не «добавить роль в base»: base питает и веб-навигацию, поэтому
   * monitor немедленно увидел бы пункт «История поступлений», а manager —
   * раздел «Администрирование». Интерфейс изменился бы в день выката.
   */
  | { kind: 'legacy'; page: PageId; action: PageAction; roles: ManagedRole[]; note: string });

const st = (page: PageId, action: PageAction, meta?: RuleMeta): RouteRule => ({
  kind: 'static',
  page,
  action,
  ...meta,
});
const always = (note: string, meta?: RuleMeta): RouteRule => ({ kind: 'always', note, ...meta });
const inHandler = (note: string): RouteRule => ({ kind: 'in-handler', note });
const legacy = (
  page: PageId,
  action: PageAction,
  roles: ManagedRole[],
  note: string,
): RouteRule => ({ kind: 'legacy', page, action, roles, note });

/**
 * Обоснования для always-групп, чтобы не повторять текст в каждой строке.
 */
const LOOKUP =
  'Общий lookup-справочник: кормит комбобоксы формы операции и мобильный /sync, ' +
  'а не только свою вкладку. Закрыв его по references.*:view, сломаем форму приёмки. ' +
  'View страницы обеспечивается роутером и UI; скоуп по роли остаётся в хендлере.';
const SELF_SERVICE =
  'Самообслуживание: заперев /auth/*, админ отрежет людям выход и смену пароля.';
const SHARE_TOKEN =
  'Доступ по знанию токена, req.user не заполняется — матрице нечего проверять.';
const SD_READ =
  'Чтение УПД: входит в дельту /sync и в карточку операции, а не только в раздел «Документы».';
const MOBILE_CHANNEL =
  'Мобильный транспортный канал: отдаёт и приёмки, и отгрузки одним ответом, ' +
  'привязка к одной странице некорректна. Скоуп по роли и siteId остаётся в хендлере.';
const SHARE_LINKS =
  'Ссылка-шаринг общая для приёмок и отгрузок — правило «одна страница» неприменимо.';
/** Переписка по share-ссылке: третья возможность share, открыта admin/manager. */
const MSG: RuleMeta = { capability: 'operations.share.messages' };
const GAP =
  'РАЗРЫВ «API щедрее UI»: роль имеет доступ по API, но страницы в вебе у неё нет. ' +
  'Перечисленные роли идут мимо матрицы — сужение отложено до отдельного согласования ' +
  '(этап 7 плана), иначе выкат молча отобрал бы действующий доступ. Остальным ролям ' +
  'маршрут открывает явное расширение указанной пары.';

export const ROUTE_PERMISSIONS = new Map<string, RouteRule>([
  // ─────────────────────────── Служебное / auth ───────────────────────────
  ['GET /health', always('Health-check, вне авторизации вовсе.')],
  ['POST /api/v1/auth/login', always(SELF_SERVICE)],
  ['POST /api/v1/auth/register', always(SELF_SERVICE)],
  ['POST /api/v1/auth/refresh', always(SELF_SERVICE)],
  ['POST /api/v1/auth/logout', always(SELF_SERVICE)],
  ['GET /api/v1/auth/me', always(SELF_SERVICE)],
  ['PATCH /api/v1/auth/me', always(SELF_SERVICE)],
  ['POST /api/v1/auth/change-password', always(SELF_SERVICE)],
  ['GET /api/v1/me/permissions', always('Свои же права: закрыв, лишим UI возможности их узнать.')],

  // ─────────────────────────── Публичный периметр ─────────────────────────
  ['GET /api/v1/public/sites', always('Публичная загрузка документов поставщиком.')],
  ['POST /api/v1/public/upload-documents', always('Публичная загрузка документов поставщиком.')],
  [
    'GET /api/v1/public/upload-documents/:ticket',
    always('Публичная загрузка документов поставщиком.'),
  ],
  ['POST /api/v1/public/password-reset/request', always('Публичный сброс пароля.')],
  ['POST /api/v1/public/password-reset/inspect', always('Публичный сброс пароля.')],
  ['POST /api/v1/public/password-reset/consume', always('Публичный сброс пароля.')],
  ['GET /api/v1/share/:token', always(SHARE_TOKEN)],
  ['GET /api/v1/share/:token/messages', always(SHARE_TOKEN)],
  ['POST /api/v1/share/:token/messages', always(SHARE_TOKEN)],
  ['GET /api/v1/share/:token/photos/:photoId', always(SHARE_TOKEN)],
  ['GET /api/v1/share/:token/photos/:photoId/thumb', always(SHARE_TOKEN)],

  // ─────────────────────────── Операции: приёмки ──────────────────────────
  ['GET /api/v1/deliveries', st('operations.deliveries', 'view')],
  ['GET /api/v1/deliveries/:id', st('operations.deliveries', 'view')],
  ['GET /api/v1/deliveries/export.xlsx', st('operations.deliveries', 'view')],
  [
    'POST /api/v1/deliveries',
    inHandler(
      'Upsert: create или edit решается наличием строки в БД, а не наличием input.id — ' +
        'офлайн-запись с планшета приходит с уже сгенерированным UUID.',
    ),
  ],
  // Отметка проверки качества — своё действие, не edit: у ячейки edit другой
  // allow-list (admin/manager), и совмещение делало право монитора базовым,
  // то есть неспособным быть расширенным до настоящей правки.
  ['PATCH /api/v1/deliveries/:id/review', st('operations.deliveries', 'review')],
  // Три маршрута ниже открыты только admin/manager, хотя базовый edit есть и у
  // inspector_kpp: для него это остаётся закрытым (его записи ограничены
  // объектом, а сверки siteId на этих путях нет). Монитору же выданный edit
  // обязан здесь работать — ровно ради этого разделяли права.
  [
    'PATCH /api/v1/deliveries/:id/flags',
    st('operations.deliveries', 'edit', {
      capability: 'operations.edit.flags',
      expandableBy: ['monitor'],
    }),
  ],
  [
    'PATCH /api/v1/deliveries/:id/supplier-from-directory',
    st('operations.deliveries', 'edit', {
      capability: 'operations.edit.supplier_directory',
      expandableBy: ['monitor'],
    }),
  ],
  [
    'POST /api/v1/deliveries/:id/link-source',
    st('operations.deliveries', 'edit', {
      capability: 'operations.edit.link_source',
      expandableBy: ['monitor'],
    }),
  ],
  // Ссылки-шаринги — не часть обычного редактирования: у создания, списка,
  // отзыва и переписки РАЗНЫЕ allow-list (инспектор создаёт и видит, но не
  // отзывает). Выдача edit их не открывает, интерфейс скрывает по capability.
  [
    'POST /api/v1/deliveries/:id/share-link',
    st('operations.deliveries', 'edit', {
      capability: 'operations.share.manage',
      expandableBy: [],
    }),
  ],
  ['DELETE /api/v1/deliveries/:id', st('operations.deliveries', 'delete')],
  ['POST /api/v1/deliveries/:id/mark-deletion', st('operations.deliveries', 'delete')],
  ['POST /api/v1/deliveries/:id/unmark-deletion', st('operations.deliveries', 'delete')],
  // Массовая пометка — кнопка в истории приёмок, открыта admin/manager.
  // Инспектору закрыта намеренно (с планшета он помечает записи по одной), а
  // монитору с выданным «Удалять» открывается: у него нет ограничения по своим
  // данным, он и так видит все объекты.
  [
    'POST /api/v1/deliveries/bulk-mark-deletion',
    st('operations.deliveries', 'delete', {
      capability: 'operations.delete.bulk_mark',
      expandableBy: ['monitor'],
    }),
  ],
  [
    'POST /api/v1/deliveries/bulk-unmark-deletion',
    st('operations.deliveries', 'delete', {
      capability: 'operations.delete.bulk_mark',
      expandableBy: ['monitor'],
    }),
  ],
  // Удаление НАВСЕГДА — admin-only по существу операции. Ячейкой delete
  // помечены и обычные пути (manager/inspector), поэтому выданное монитору
  // «Удалять» не должно открывать ещё и это: иначе расширение дало бы ему
  // больше, чем есть у менеджера.
  [
    'POST /api/v1/deliveries/bulk-hard-delete',
    st('operations.deliveries', 'delete', {
      capability: 'operations.delete.bulk_hard',
      expandableBy: [],
    }),
  ],

  // ─────────────────────────── Операции: отгрузки ─────────────────────────
  ['GET /api/v1/shipments', st('operations.shipments', 'view')],
  ['GET /api/v1/shipments/:id', st('operations.shipments', 'view')],
  // Своего export.xlsx у отгрузок нет: страница Операций выгружает их через
  // /api/v1/source-documents/export.xlsx (см. OperationsPage.tsx).
  ['POST /api/v1/shipments', inHandler('Upsert — см. POST /api/v1/deliveries.')],
  ['PATCH /api/v1/shipments/:id/review', st('operations.shipments', 'review')],
  // Зеркально приёмкам — см. комментарии там.
  [
    'PATCH /api/v1/shipments/:id/flags',
    st('operations.shipments', 'edit', {
      capability: 'operations.edit.flags',
      expandableBy: ['monitor'],
    }),
  ],
  [
    'PATCH /api/v1/shipments/:id/supplier-from-directory',
    st('operations.shipments', 'edit', {
      capability: 'operations.edit.supplier_directory',
      expandableBy: ['monitor'],
    }),
  ],
  [
    'POST /api/v1/shipments/:id/link-source',
    st('operations.shipments', 'edit', {
      capability: 'operations.edit.link_source',
      expandableBy: ['monitor'],
    }),
  ],
  [
    'POST /api/v1/shipments/:id/share-link',
    st('operations.shipments', 'edit', {
      capability: 'operations.share.manage',
      expandableBy: [],
    }),
  ],
  ['DELETE /api/v1/shipments/:id', st('operations.shipments', 'delete')],
  ['POST /api/v1/shipments/:id/mark-deletion', st('operations.shipments', 'delete')],
  ['POST /api/v1/shipments/:id/unmark-deletion', st('operations.shipments', 'delete')],
  [
    'POST /api/v1/shipments/bulk-mark-deletion',
    st('operations.shipments', 'delete', {
      capability: 'operations.delete.bulk_mark',
      expandableBy: ['monitor'],
    }),
  ],
  [
    'POST /api/v1/shipments/bulk-unmark-deletion',
    st('operations.shipments', 'delete', {
      capability: 'operations.delete.bulk_mark',
      expandableBy: ['monitor'],
    }),
  ],
  [
    'POST /api/v1/shipments/bulk-hard-delete',
    st('operations.shipments', 'delete', {
      capability: 'operations.delete.bulk_hard',
      expandableBy: [],
    }),
  ],

  // Счётчики и ссылки-шаринги — общие для обеих страниц Операций.
  [
    'GET /api/v1/reports/operations-counters',
    always('Счётчики для меню: один ответ по приёмкам и отгрузкам сразу.'),
  ],
  // Список и отзыв — разные возможности, а не одна «работа со ссылками»:
  // список открыт ещё и инспектору, отзыв — нет. Одна capability на оба
  // оставила бы инспектору кнопку «Отозвать», которая отвечает 403.
  ['GET /api/v1/share-links', always(SHARE_LINKS, { capability: 'operations.share.manage' })],
  [
    'POST /api/v1/share-links/:id/revoke',
    always(SHARE_LINKS, { capability: 'operations.share.revoke' }),
  ],

  // Мобильный транспорт.
  ['GET /api/v1/sync', always(MOBILE_CHANNEL)],
  ['POST /api/v1/sync/reconcile', always(MOBILE_CHANNEL)],
  ['GET /api/v1/events', always(MOBILE_CHANNEL)],

  // ─────────────────────────── Фото операций ──────────────────────────────
  // Единственный маршрут, знающий вид операции из тела запроса.
  [
    'POST /api/v1/photos/presign',
    {
      kind: 'dynamic',
      resolve: (req) => {
        const body = (req.body ?? {}) as { operationKind?: string; deliveryId?: string };
        // Фолбэк повторяет хендлер (photos.ts): operationKind ?? 'delivery',
        // legacy-клиенты шлют deliveryId без operationKind.
        const kind = body.operationKind === 'shipment' ? 'shipment' : 'delivery';
        return {
          page: kind === 'shipment' ? 'operations.shipments' : 'operations.deliveries',
          action: 'create',
        };
      },
    },
  ],
  // Остальные узнают вид операции только после findPhoto().
  ['POST /api/v1/photos/:id/confirm', inHandler('found.kind + create, после findPhoto.')],
  // Право то же, что у presign/confirm: загрузка файла — часть создания фото.
  ['POST /api/v1/photos/:id/content', inHandler('found.kind + create, после findPhoto.')],
  ['PATCH /api/v1/photos/:id', inHandler('found.kind + edit, после findPhoto.')],
  ['POST /api/v1/photos/:id/recognize', inHandler('found.kind + edit, после findPhoto.')],
  ['DELETE /api/v1/photos/:id', inHandler('found.kind + delete, после findPhoto.')],
  ['GET /api/v1/photos/:id/url', inHandler('found.kind + view, после findPhoto.')],
  ['GET /api/v1/photos/:id/content', inHandler('found.kind + view, после findPhoto.')],
  ['GET /api/v1/photos/:id/recognition', inHandler('found.kind + view, после findPhoto.')],

  // ─────────────────────────── Документы (УПД) ────────────────────────────
  ['GET /api/v1/source-documents', always(SD_READ)],
  ['GET /api/v1/source-documents/:id', always(SD_READ)],
  ['GET /api/v1/source-documents/:id/file', always(SD_READ)],
  ['GET /api/v1/source-documents/:id/file/raw', always(SD_READ)],
  ['GET /api/v1/source-documents/:id/extra/:itemId/url', always(SD_READ)],
  ['GET /api/v1/source-documents/:id/extra/:itemId/raw', always(SD_READ)],
  [
    'GET /api/v1/source-documents/export.xlsx',
    legacy('documents.list', 'view', ['manager', 'inspector_kpp', 'contractor', 'monitor'], GAP),
  ],
  // Результат импорта УПД: admin/manager. Подрядчику закрыт намеренно — его
  // видимость документов ограничена своими записями, а этот маршрут скоуп не
  // сверяет. Монитору выданный просмотр документов его открывает: у монитора
  // ограничения по своим данным нет вовсе.
  [
    'GET /api/v1/source-documents/import-result/:bundleId',
    st('documents.list', 'view', { expandableBy: ['monitor'] }),
  ],
  ['POST /api/v1/source-documents/upload-upd', st('documents.list', 'create')],
  ['POST /api/v1/source-documents/upload-upd-pdf', st('documents.list', 'create')],
  ['POST /api/v1/source-documents/upload-waybill', st('documents.list', 'create')],
  ['POST /api/v1/source-documents/upload-documents', st('documents.list', 'create')],
  ['PATCH /api/v1/source-documents/:id', st('documents.list', 'edit')],
  ['PATCH /api/v1/source-documents/:id/direction', st('documents.list', 'edit')],
  ['POST /api/v1/source-documents/:id/acknowledge-mismatch', st('documents.list', 'edit')],
  ['POST /api/v1/source-documents/:id/resolve-duplicate', st('documents.list', 'edit')],
  ['DELETE /api/v1/source-documents/:id', st('documents.list', 'delete')],
  ['POST /api/v1/source-documents/bulk-delete', st('documents.list', 'delete')],
  [
    'GET /api/v1/source-documents/:id/llm-calls',
    always('Логи распознавания — диагностический инструмент админа, не CRUD страницы.'),
  ],

  // Комплекты без распознанных документов.
  ['GET /api/v1/source-bundles/extra-only', st('documents.extra_only', 'view')],
  ['GET /api/v1/source-bundles/:bundleId/extra/:itemId/url', st('documents.extra_only', 'view')],

  // ─────────────────────────── Разбор почты ───────────────────────────────
  ['GET /api/v1/mail/messages', st('documents.mail', 'view')],
  ['GET /api/v1/mail/messages/:id', st('documents.mail', 'view')],
  ['GET /api/v1/mail/messages/:id/body', st('documents.mail', 'view')],
  ['GET /api/v1/mail/messages/:id/attachments/:attachmentId/raw', st('documents.mail', 'view')],
  ['GET /api/v1/mail/receipts', st('documents.mail', 'view')],
  ['GET /api/v1/mail/review/summary', st('documents.mail', 'view')],
  ['POST /api/v1/mail/messages/:id/resolve', st('documents.mail', 'edit')],
  ['POST /api/v1/mail/messages/:id/reject', st('documents.mail', 'edit')],
  [
    'POST /api/v1/mail/messages/:id/attachments/:attachmentId/restore',
    st('documents.mail', 'edit'),
  ],
  ['POST /api/v1/mail/receipts/:id/replay', st('documents.mail', 'edit')],

  // Переписка по share-ссылке (колокольчик в шапке) — виджет без страницы.
  // Переписка по ссылке — третья возможность share: открыта admin/manager,
  // инспектору нет (хотя ссылку он создать может).
  [
    'GET /api/v1/share-messages/threads',
    always('Виджет уведомлений в шапке layout, у него нет страницы в матрице.', MSG),
  ],
  [
    'GET /api/v1/share-messages/threads/:tokenId',
    always('Виджет уведомлений в шапке layout.', MSG),
  ],
  ['GET /api/v1/share-messages/unread-count', always('Виджет уведомлений в шапке layout.', MSG)],
  [
    'POST /api/v1/share-messages/threads/:tokenId',
    always('Виджет уведомлений в шапке layout.', MSG),
  ],
  [
    'POST /api/v1/share-messages/threads/:tokenId/mark-read',
    always('Виджет уведомлений в шапке layout.', MSG),
  ],

  // ─────────────────────── История поступлений и отчёты ───────────────────
  [
    'GET /api/v1/materials/journal',
    legacy('materials_journal', 'view', ['manager', 'inspector_kpp', 'monitor'], GAP),
  ],
  ['GET /api/v1/reports/intake', st('materials_journal', 'view')],
  ['GET /api/v1/reports/shipment', st('materials_journal', 'view')],
  ['GET /api/v1/reports/stock', st('materials_journal', 'view')],
  ['GET /api/v1/reports/inspector-stats', st('stats', 'view')],
  ['GET /api/v1/reports/stats-summary', st('stats', 'view')],

  // ─────────────────────────── Справочники ────────────────────────────────
  ['GET /api/v1/statuses', always(LOOKUP)],
  ['GET /api/v1/sites', always(LOOKUP)],
  ['GET /api/v1/sites/:id', always(LOOKUP)],
  ['GET /api/v1/units', always(LOOKUP)],
  ['GET /api/v1/counterparties', always(LOOKUP)],
  ['GET /api/v1/customer-counterparties', always(LOOKUP)],
  ['GET /api/v1/suppliers', always(LOOKUP)],
  ['GET /api/v1/materials', always(LOOKUP)],
  ['GET /api/v1/responsible-persons', always(LOOKUP)],
  ['GET /api/v1/assets', always(LOOKUP)],
  ['GET /api/v1/mol', always(LOOKUP)],

  ['POST /api/v1/sites', st('references.sites', 'create')],
  ['PATCH /api/v1/sites/:id', st('references.sites', 'edit')],
  ['DELETE /api/v1/sites/:id', st('references.sites', 'delete')],
  ['POST /api/v1/sites/bulk-delete', st('references.sites', 'delete')],

  ['POST /api/v1/customer-counterparties', st('references.customer_counterparties', 'create')],
  ['PATCH /api/v1/customer-counterparties/:id', st('references.customer_counterparties', 'edit')],
  [
    'DELETE /api/v1/customer-counterparties/:id',
    st('references.customer_counterparties', 'delete'),
  ],
  [
    'POST /api/v1/customer-counterparties/bulk-delete',
    st('references.customer_counterparties', 'delete'),
  ],

  ['POST /api/v1/suppliers', st('references.suppliers', 'create')],
  ['PATCH /api/v1/suppliers/:id', st('references.suppliers', 'edit')],
  ['DELETE /api/v1/suppliers/:id', st('references.suppliers', 'delete')],
  ['POST /api/v1/suppliers/bulk-delete', st('references.suppliers', 'delete')],

  ['POST /api/v1/units', st('references.units', 'create')],
  ['PATCH /api/v1/units/:id', st('references.units', 'edit')],
  ['DELETE /api/v1/units/:id', st('references.units', 'delete')],
  ['POST /api/v1/units/bulk-delete', st('references.units', 'delete')],

  // Операционный справочник контрагентов (вкладка скрыта, роут живёт).
  ['POST /api/v1/counterparties', st('references.counterparties_legacy', 'create')],
  ['POST /api/v1/counterparties/from-directory', st('references.counterparties_legacy', 'create')],
  ['PATCH /api/v1/counterparties/:id', st('references.counterparties_legacy', 'edit')],
  ['DELETE /api/v1/counterparties/:id', st('references.counterparties_legacy', 'delete')],
  ['POST /api/v1/counterparties/bulk-delete', st('references.counterparties_legacy', 'delete')],

  ['POST /api/v1/responsible-persons', st('references.responsible_persons', 'create')],
  ['POST /api/v1/responsible-persons/import', st('references.responsible_persons', 'create')],
  ['PATCH /api/v1/responsible-persons/:id', st('references.responsible_persons', 'edit')],
  ['DELETE /api/v1/responsible-persons/:id', st('references.responsible_persons', 'delete')],
  [
    'POST /api/v1/responsible-persons/bulk-delete',
    st('references.responsible_persons', 'delete'),
  ],

  ['POST /api/v1/materials', st('references.materials', 'create')],
  ['PATCH /api/v1/materials/:id', st('references.materials', 'edit')],
  ['DELETE /api/v1/materials/:id', st('references.materials', 'delete')],

  ['POST /api/v1/assets', st('references.assets', 'create')],
  ['PATCH /api/v1/assets/:id', st('references.assets', 'edit')],
  ['DELETE /api/v1/assets/:id', st('references.assets', 'delete')],

  // ─────────────────────────── Администрирование ──────────────────────────
  ['GET /api/v1/admin/users', st('admin.users', 'view')],
  ['PATCH /api/v1/admin/users/:id', st('admin.users', 'edit')],
  ['DELETE /api/v1/admin/users/:id', st('admin.users', 'delete')],
  ['POST /api/v1/admin/users/:id/password', st('admin.users', 'edit')],
  ['POST /api/v1/admin/users/:id/password-reset-link', st('admin.users', 'edit')],
  ['GET /api/v1/admin/password-resets', st('admin.users', 'view')],
  ['POST /api/v1/admin/password-resets/:id/rotate', st('admin.users', 'edit')],
  ['POST /api/v1/admin/password-resets/:id/reveal', st('admin.users', 'edit')],
  ['POST /api/v1/admin/password-resets/:id/revoke', st('admin.users', 'edit')],
  ['POST /api/v1/admin/password-resets/requests/:id/close', st('admin.users', 'edit')],

  ['GET /api/v1/admin/role-permissions', st('admin.roles', 'view')],
  ['PATCH /api/v1/admin/role-permissions', st('admin.roles', 'edit')],
  ['DELETE /api/v1/admin/role-permissions/:role', st('admin.roles', 'edit')],

  ['GET /api/v1/admin/llm-providers', st('admin.llm_providers', 'view')],
  ['POST /api/v1/admin/llm-providers', st('admin.llm_providers', 'create')],
  ['PATCH /api/v1/admin/llm-providers/:id', st('admin.llm_providers', 'edit')],
  ['DELETE /api/v1/admin/llm-providers/:id', st('admin.llm_providers', 'delete')],
  ['POST /api/v1/admin/llm-providers/:id/test', st('admin.llm_providers', 'edit')],
  ['GET /api/v1/admin/llm-provider-credentials', st('admin.llm_providers', 'view')],
  ['PUT /api/v1/admin/llm-provider-credentials/:kind', st('admin.llm_providers', 'edit')],
  ['DELETE /api/v1/admin/llm-provider-credentials/:kind', st('admin.llm_providers', 'delete')],
  ['POST /api/v1/admin/llm-provider-credentials/:kind/test', st('admin.llm_providers', 'edit')],

  ['GET /api/v1/admin/prompts', st('admin.prompts', 'view')],
  ['POST /api/v1/admin/prompts', st('admin.prompts', 'create')],
  ['PATCH /api/v1/admin/prompts/:id', st('admin.prompts', 'edit')],
  ['DELETE /api/v1/admin/prompts/:id', st('admin.prompts', 'delete')],
  ['POST /api/v1/admin/prompts/:id/activate', st('admin.prompts', 'edit')],

  ['GET /api/v1/admin/edo-accounts', st('admin.edo_accounts', 'view')],
  ['POST /api/v1/admin/edo-accounts', st('admin.edo_accounts', 'create')],
  ['DELETE /api/v1/admin/edo-accounts/:id', st('admin.edo_accounts', 'delete')],
  ['POST /api/v1/admin/edo-accounts/:id/sync', legacy('admin.edo_accounts', 'edit', ['manager'], GAP)],

  ['GET /api/v1/admin/mail-accounts', st('admin.mail_accounts', 'view')],
  ['POST /api/v1/admin/mail-accounts', st('admin.mail_accounts', 'create')],
  ['PATCH /api/v1/admin/mail-accounts/:id', st('admin.mail_accounts', 'edit')],
  ['DELETE /api/v1/admin/mail-accounts/:id', st('admin.mail_accounts', 'delete')],
  ['POST /api/v1/admin/mail-accounts/:id/sync', legacy('admin.mail_accounts', 'edit', ['manager'], GAP)],
  ['POST /api/v1/admin/mail-accounts/:id/poll', st('admin.mail_accounts', 'edit')],

  ['GET /api/v1/admin/settings', legacy('admin.settings', 'view', ['manager'], GAP)],
  ['PUT /api/v1/admin/settings', st('admin.settings', 'edit')],
]);

/**
 * Ключ реестра. HEAD нормализуем в GET: Fastify заводит HEAD автоматически
 * для каждого GET, и дублировать ~90 строк ради этого бессмысленно.
 */
export function routeKey(method: string, urlPattern: string): string {
  const m = method.toUpperCase();
  return `${m === 'HEAD' ? 'GET' : m} ${urlPattern}`;
}

export function lookupRule(method: string, urlPattern: string): RouteRule | undefined {
  return ROUTE_PERMISSIONS.get(routeKey(method, urlPattern));
}
