import type { ManagedRole, PageAction, PageId } from '@matcheck/contracts';

/**
 * Audited baseline: то, как права устроены СЕГОДНЯ, до появления матрицы.
 *
 * Ревьюится глазами один раз, дальше стережётся permissions-defaults.test.ts.
 * Существует потому, что автоматически вывести текущие права нельзя:
 * app.authorize(...) снимается из инвентаря маршрутов, но 33 маршрута
 * проверяют роль внутри хендлера, а ещё поверх всего лежит глобальный
 * read-only-хук для contractor/monitor.
 */

/**
 * Навигация веба: каким ролям страница доступна в интерфейсе.
 * Источники — apps/web/src/app/layout/navItems.ts (пункты меню) и
 * ProtectedRoute roles={...} в apps/web/src/app/router.tsx.
 * admin опущен везде: он вне матрицы.
 */
export const NAV_ACCESS: Record<PageId, ManagedRole[]> = {
  // navItems.ts: «Операции» открыты всем пяти ролям.
  'operations.deliveries': ['manager', 'inspector_kpp', 'contractor', 'monitor'],
  'operations.shipments': ['manager', 'inspector_kpp', 'contractor', 'monitor'],
  // router.tsx: /documents — admin, manager, contractor.
  'documents.list': ['manager', 'contractor'],
  // router.tsx: /documents/mail и /documents/extra-only — admin, manager.
  'documents.mail': ['manager'],
  'documents.extra_only': ['manager'],
  // router.tsx: /materials — admin, manager, inspector_kpp.
  materials_journal: ['manager', 'inspector_kpp'],
  // router.tsx: /stats — admin, manager.
  stats: ['manager'],
  // router.tsx: /references/* — admin, manager (весь раздел одним гардом).
  'references.sites': ['manager'],
  'references.customer_counterparties': ['manager'],
  'references.suppliers': ['manager'],
  'references.units': ['manager'],
  'references.mol': ['manager'],
  'references.counterparties_legacy': ['manager'],
  'references.responsible_persons': ['manager'],
  'references.materials': ['manager'],
  'references.assets': ['manager'],
  // router.tsx: /admin/* — только admin, то есть ни одной managed-роли.
  'admin.users': [],
  'admin.roles': [],
  'admin.llm_providers': [],
  'admin.prompts': [],
  'admin.edo_accounts': [],
  'admin.mail_accounts': [],
  'admin.settings': [],
};

/**
 * Маршруты, объявленные БЕЗ app.authorize(...): роль проверяется внутри
 * хендлера. Здесь зафиксировано, какие managed-роли фактически проходят.
 *
 * Ключ — `${METHOD} ${шаблон}`. Значение — роли, у которых доступ есть
 * (с учётом их скоупа: инспектор видит свой объект, подрядчик — свои
 * записи; сам скоуп матрицей не выражается и остаётся в хендлере).
 */
export const INLINE_ROLE_ACCESS: Record<string, ManagedRole[]> = {
  // deliveries.ts:493,718,1481 — список/карточка/выгрузка со скоупом по роли.
  'GET /api/v1/deliveries': ['manager', 'inspector_kpp', 'contractor', 'monitor'],
  'GET /api/v1/deliveries/:id': ['manager', 'inspector_kpp', 'contractor', 'monitor'],
  'GET /api/v1/deliveries/export.xlsx': ['manager', 'inspector_kpp', 'contractor', 'monitor'],
  // deliveries.ts:943 — hard-delete: admin всегда; manager/inspector только для
  // draft/not_filled (инспектор — в пределах своего объекта). contractor и
  // monitor отсечены глобальным read-only-хуком (server.ts) как мутация.
  'DELETE /api/v1/deliveries/:id': ['manager', 'inspector_kpp'],
  // deliveries.ts:1068,1135 — пометка на удаление и её снятие (снять может
  // автор пометки либо admin).
  'POST /api/v1/deliveries/:id/mark-deletion': ['manager', 'inspector_kpp'],
  'POST /api/v1/deliveries/:id/unmark-deletion': ['manager', 'inspector_kpp'],
  // shipments.ts — зеркально приёмкам.
  'GET /api/v1/shipments': ['manager', 'inspector_kpp', 'contractor', 'monitor'],
  'GET /api/v1/shipments/:id': ['manager', 'inspector_kpp', 'contractor', 'monitor'],
  'DELETE /api/v1/shipments/:id': ['manager', 'inspector_kpp'],
  'POST /api/v1/shipments/:id/mark-deletion': ['manager', 'inspector_kpp'],
  'POST /api/v1/shipments/:id/unmark-deletion': ['manager', 'inspector_kpp'],
  // photos.ts:429,482,809 — чтение фото со скоупом (чужой объект → 404).
  'GET /api/v1/photos/:id/url': ['manager', 'inspector_kpp', 'contractor', 'monitor'],
  'GET /api/v1/photos/:id/content': ['manager', 'inspector_kpp', 'contractor', 'monitor'],
  'GET /api/v1/photos/:id/recognition': ['manager', 'inspector_kpp', 'contractor', 'monitor'],
  // source-documents.ts:627,870,1093,… — чтение УПД со скоупом подрядчика.
  'GET /api/v1/source-documents': ['manager', 'inspector_kpp', 'contractor', 'monitor'],
  'GET /api/v1/source-documents/:id': ['manager', 'inspector_kpp', 'contractor', 'monitor'],
  'GET /api/v1/source-documents/:id/file': ['manager', 'inspector_kpp', 'contractor', 'monitor'],
  'GET /api/v1/source-documents/:id/file/raw': [
    'manager',
    'inspector_kpp',
    'contractor',
    'monitor',
  ],
  'GET /api/v1/source-documents/:id/extra/:itemId/url': [
    'manager',
    'inspector_kpp',
    'contractor',
    'monitor',
  ],
  'GET /api/v1/source-documents/:id/extra/:itemId/raw': [
    'manager',
    'inspector_kpp',
    'contractor',
    'monitor',
  ],
  'GET /api/v1/source-documents/export.xlsx': [
    'manager',
    'inspector_kpp',
    'contractor',
    'monitor',
  ],
  // Lookup-справочники и служебное, открытые всем авторизованным.
  'GET /api/v1/statuses': ['manager', 'inspector_kpp', 'contractor', 'monitor'],
  'GET /api/v1/units': ['manager', 'inspector_kpp', 'contractor', 'monitor'],
  'GET /api/v1/reports/operations-counters': [
    'manager',
    'inspector_kpp',
    'contractor',
    'monitor',
  ],
  // Самообслуживание — доступно всем ролям.
  'GET /api/v1/auth/me': ['manager', 'inspector_kpp', 'contractor', 'monitor'],
  'PATCH /api/v1/auth/me': ['manager', 'inspector_kpp', 'contractor', 'monitor'],
  'POST /api/v1/auth/logout': ['manager', 'inspector_kpp', 'contractor', 'monitor'],
  'POST /api/v1/auth/change-password': ['manager', 'inspector_kpp', 'contractor', 'monitor'],
  // share/:token — доступ по знанию токена, req.user не заполняется вовсе.
  'GET /api/v1/share/:token': [],
  'GET /api/v1/share/:token/messages': [],
  'POST /api/v1/share/:token/messages': [],
  'GET /api/v1/share/:token/photos/:photoId': [],
  'GET /api/v1/share/:token/photos/:photoId/thumb': [],
};

/**
 * Что проверяют маршруты классов dynamic и in-handler. Пара (страница,
 * действие) у них выясняется в рантайме — из тела запроса или после SELECT,
 * — поэтому перечислить ВСЕ возможные исходы можно только здесь.
 *
 * Без этой фикстуры дырой оказалось бы самое важное: POST /api/v1/deliveries
 * (upsert) — единственный маршрут, дающий operations.*:create, и, будь он
 * пропущен, тест «матрица не сужает» не заметил бы снятия права «Создавать»
 * у Операций.
 */
export const RUNTIME_RULE_COVERAGE: Record<string, { page: PageId; action: PageAction }[]> = {
  // Upsert: ветка выбирается наличием строки в БД.
  'POST /api/v1/deliveries': [
    { page: 'operations.deliveries', action: 'create' },
    { page: 'operations.deliveries', action: 'edit' },
  ],
  'POST /api/v1/shipments': [
    { page: 'operations.shipments', action: 'create' },
    { page: 'operations.shipments', action: 'edit' },
  ],
  // Фото: вид операции берётся из тела (presign) либо из found.kind.
  'POST /api/v1/photos/presign': [
    { page: 'operations.deliveries', action: 'create' },
    { page: 'operations.shipments', action: 'create' },
  ],
  'POST /api/v1/photos/:id/confirm': [
    { page: 'operations.deliveries', action: 'create' },
    { page: 'operations.shipments', action: 'create' },
  ],
  // Загрузка файла через API-прокси (путь веб-портала) — то же право, что у
  // presign/confirm: это часть создания фото, а не отдельное действие.
  'POST /api/v1/photos/:id/content': [
    { page: 'operations.deliveries', action: 'create' },
    { page: 'operations.shipments', action: 'create' },
  ],
  'PATCH /api/v1/photos/:id': [
    { page: 'operations.deliveries', action: 'edit' },
    { page: 'operations.shipments', action: 'edit' },
  ],
  'POST /api/v1/photos/:id/recognize': [
    { page: 'operations.deliveries', action: 'edit' },
    { page: 'operations.shipments', action: 'edit' },
  ],
  'DELETE /api/v1/photos/:id': [
    { page: 'operations.deliveries', action: 'delete' },
    { page: 'operations.shipments', action: 'delete' },
  ],
  'GET /api/v1/photos/:id/url': [
    { page: 'operations.deliveries', action: 'view' },
    { page: 'operations.shipments', action: 'view' },
  ],
  'GET /api/v1/photos/:id/content': [
    { page: 'operations.deliveries', action: 'view' },
    { page: 'operations.shipments', action: 'view' },
  ],
  'GET /api/v1/photos/:id/recognition': [
    { page: 'operations.deliveries', action: 'view' },
    { page: 'operations.shipments', action: 'view' },
  ],
};

/**
 * Ячейки, право в которых обеспечивается ТОЛЬКО интерфейсом: серверных
 * маршрутов, закрытых этой парой (страница, действие), не существует.
 *
 * Так вышло у чтения: одни и те же GET кормят и вкладку, и комбобоксы формы
 * операции, и мобильный /sync, поэтому в реестре они помечены always (иначе,
 * закрыв «Справочники → Просмотр», мы сломали бы форму приёмки, а не вкладку).
 * Это осознанная граница периметра, а не пробел: действия create/edit/delete
 * enforced на сервере всегда.
 */
export const UI_ONLY_CELLS: ReadonlySet<string> = new Set([
  // Подрядчик читает «Документы» через GET /source-documents (always: та же
  // ручка отдаёт документы в карточке операции).
  'contractor:documents.list:view',
  // Справочники: список отдаёт lookup-GET, помеченный always.
  'manager:references.sites:view',
  'manager:references.customer_counterparties:view',
  'manager:references.suppliers:view',
  'manager:references.units:view',
  'manager:references.mol:view',
  'manager:references.counterparties_legacy:view',
  'manager:references.responsible_persons:view',
  'manager:references.materials:view',
  'manager:references.assets:view',
]);

/**
 * Разрывы «API щедрее UI»: роль имеет доступ по API, но страницы в вебе у
 * неё нет. Формула дефолта (nav ∩ api) их бы отобрала, поэтому на первом
 * релизе все они помечены в реестре как always — выкат матрицы не должен
 * молча сузить действующий доступ.
 *
 * Закрытие каждого — отдельное согласованное изменение (этап 7 плана).
 * Тест требует, чтобы КАЖДЫЙ найденный разрыв был перечислен здесь: новый
 * не проскочит молча.
 */
export const KNOWN_API_UI_GAPS: Record<string, string> = {
  'GET /api/v1/materials/journal':
    'monitor имеет журнал по API, но пункта «История поступлений» в меню у него нет.',
  'GET /api/v1/source-documents/export.xlsx':
    'inspector_kpp и monitor могут выгрузить реестр документов, хотя страницы «Документы» у них нет.',
  'GET /api/v1/admin/settings':
    'manager читает настройки распознавания по API, хотя весь /admin открыт только admin.',
  'POST /api/v1/admin/edo-accounts/:id/sync':
    'manager может запустить синхронизацию ЭДО, хотя вкладка ему не видна.',
  'POST /api/v1/admin/mail-accounts/:id/sync':
    'manager может запустить синхронизацию почты, хотя вкладка ему не видна.',
};
