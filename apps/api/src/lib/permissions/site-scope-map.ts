import { routeKey } from './route-map.js';

/**
 * Какие маршруты умеют работать с наблюдателем, ограниченным своими объектами
 * (роль observer, user_sites).
 *
 *   enforced — обработчик сверяет объект записи со списком наблюдателя
 *              (lib/site-scope.ts): списки фильтруются, чужая запись по id — 404;
 *   global   — у данных нет объекта (справочники без привязки к объекту).
 *
 * Маршрута нет в этой карте — наблюдателю он отвечает 403 (хук в
 * plugins/permissions.ts), даже если галочка матрицы его открывает. Забытый
 * маршрут закрывается, а не отдаёт данные всех объектов.
 *
 * Политика `matrixOnly: allow` (вход, профиль, свои права, публичные страницы)
 * хуком не проверяется: такие маршруты открыты роли без прав вовсе, данных
 * объектов на них нет.
 *
 * Отдельная карта, а не поле правила в route-map: правила там переиспользуются
 * константами на нескольких маршрутах, и разметка константы молча разметила бы
 * маршрут, где сверки объекта нет. Здесь каждый маршрут назван явно.
 * Полноту стережёт test/observer-site-scope-map.test.ts.
 */
export type SiteScopeMark = 'enforced' | 'global';

const ENFORCED = [
  // Приёмки
  'GET /api/v1/deliveries',
  'GET /api/v1/deliveries/export.xlsx',
  'GET /api/v1/deliveries/:id',
  'GET /api/v1/deliveries/:id/supplier-orders',
  'GET /api/v1/deliveries/:id/supplier-orders/:orderId/items',
  'GET /api/v1/deliveries/:id/contract',
  // Отгрузки
  'GET /api/v1/shipments',
  'GET /api/v1/shipments/export.xlsx',
  'GET /api/v1/shipments/:id',
  // Счётчики Операций
  'GET /api/v1/reports/operations-counters',
  // Фото
  'GET /api/v1/photos/:id/url',
  'GET /api/v1/photos/:id/content',
  'GET /api/v1/photos/:id/recognition',
  // Документы и комплекты
  'GET /api/v1/source-documents',
  'GET /api/v1/source-documents/export.xlsx',
  'GET /api/v1/source-documents/:id',
  'GET /api/v1/source-documents/:id/file',
  'GET /api/v1/source-documents/:id/file/raw',
  'GET /api/v1/source-documents/:id/pages',
  'GET /api/v1/source-documents/:id/extra/:itemId/url',
  'GET /api/v1/source-documents/:id/extra/:itemId/raw',
  'GET /api/v1/source-documents/import-result/:bundleId',
  'GET /api/v1/source-bundles/extra-only',
  'GET /api/v1/source-bundles/:bundleId/extra/:itemId/url',
  // Журнал материалов и отчёты по нему
  'GET /api/v1/materials/journal',
  'GET /api/v1/reports/stock',
  'GET /api/v1/reports/intake',
  'GET /api/v1/reports/movements',
  'GET /api/v1/reports/shipment',
  // Справочник объектов: только свои
  'GET /api/v1/sites',
  'GET /api/v1/sites/:id',
] as const;

const GLOBAL = [
  'GET /api/v1/units',
  'GET /api/v1/counterparties',
  'GET /api/v1/customer-counterparties',
  'GET /api/v1/suppliers',
  'GET /api/v1/suppliers/filter-options',
  'GET /api/v1/materials',
  'GET /api/v1/responsible-persons',
  'GET /api/v1/assets',
  'GET /api/v1/mol',
] as const;

export const SITE_SCOPE_MAP: ReadonlyMap<string, SiteScopeMark> = new Map<string, SiteScopeMark>([
  ...ENFORCED.map((k) => [k, 'enforced'] as const),
  ...GLOBAL.map((k) => [k, 'global'] as const),
]);

export function siteScopeMarkOf(method: string, urlPattern: string): SiteScopeMark | undefined {
  return SITE_SCOPE_MAP.get(routeKey(method, urlPattern));
}
