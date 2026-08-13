/**
 * Мобильный периметр: планшеты КПП на объектах не должны заметить матрицу
 * прав ВООБЩЕ — ни при дефолтных настройках, ни после того, как админ
 * что-нибудь запретит.
 *
 * Почему так жёстко. Мобильный клиент не обрабатывает 403 ни на одном
 * экране: он залипает молча, без сообщения. Инспектор на объекте увидит не
 * «нет доступа», а неработающее приложение — и не поймёт причины. Пока
 * клиент этого не умеет, ячейки «Инспектор КПП × Операции» заблокированы, а
 * резолвер форсирует их в true даже вопреки содержимому БД.
 *
 * Список ниже — контракт из docs/MOBILE_API.md. Если маршрут отсюда
 * перестанет проходить, планшеты на объектах встанут.
 */
import { describe, expect, it } from 'vitest';
import {
  LOCKED_CELLS,
  MOBILE_REQUIRED_ACTIONS,
  PAGE_ACTIONS,
  type PageAction,
  type PageId,
} from '@matcheck/contracts';
import { ROUTE_PERMISSIONS, routeKey } from '../src/lib/permissions/route-map.js';
import { isAllowed, overrideKey, type OverrideMap } from '../src/lib/permissions/matrix.js';

/** Маршруты, которыми пользуется мобильное приложение (docs/MOBILE_API.md). */
const MOBILE_ROUTES: [string, string][] = [
  ['POST', '/api/v1/auth/login'],
  ['POST', '/api/v1/auth/refresh'],
  ['POST', '/api/v1/auth/logout'],
  ['GET', '/api/v1/auth/me'],
  ['PATCH', '/api/v1/auth/me'],
  ['POST', '/api/v1/auth/change-password'],
  // Синхронизация и события.
  ['GET', '/api/v1/sync'],
  ['POST', '/api/v1/sync/reconcile'],
  ['GET', '/api/v1/events'],
  // Операции: список, карточка, upsert, пометка на удаление.
  ['GET', '/api/v1/deliveries'],
  ['GET', '/api/v1/deliveries/:id'],
  ['POST', '/api/v1/deliveries'],
  ['POST', '/api/v1/deliveries/:id/mark-deletion'],
  ['POST', '/api/v1/deliveries/:id/unmark-deletion'],
  ['DELETE', '/api/v1/deliveries/:id'],
  ['GET', '/api/v1/shipments'],
  ['GET', '/api/v1/shipments/:id'],
  ['POST', '/api/v1/shipments'],
  ['POST', '/api/v1/shipments/:id/mark-deletion'],
  ['POST', '/api/v1/shipments/:id/unmark-deletion'],
  ['DELETE', '/api/v1/shipments/:id'],
  // Фото.
  ['POST', '/api/v1/photos/presign'],
  ['POST', '/api/v1/photos/:id/confirm'],
  ['GET', '/api/v1/photos/:id/url'],
  ['GET', '/api/v1/photos/:id/content'],
  // Справочники, которые тянет клиент.
  ['GET', '/api/v1/statuses'],
  ['GET', '/api/v1/units'],
  ['GET', '/api/v1/sites'],
  ['GET', '/api/v1/counterparties'],
  ['GET', '/api/v1/materials'],
  ['GET', '/api/v1/responsible-persons'],
  ['GET', '/api/v1/assets'],
  ['GET', '/api/v1/mol'],
  // Документы, приходящие в дельте sync и в карточке операции.
  ['GET', '/api/v1/source-documents'],
  ['GET', '/api/v1/source-documents/:id'],
  ['GET', '/api/v1/source-documents/:id/file'],
];

const EMPTY: OverrideMap = new Map();

/** «Админ запретил инспектору всё, что технически можно запретить». */
const HOSTILE: OverrideMap = new Map(
  (
    [
      'operations.deliveries',
      'operations.shipments',
      'documents.list',
      'materials_journal',
      'references.sites',
    ] as PageId[]
  ).map((page) => [
    overrideKey('inspector_kpp', page),
    { view: false, create: false, edit: false, delete: false },
  ]),
);

function cellsOf(method: string, url: string): { page: PageId; action: PageAction }[] {
  const key = routeKey(method, url);
  const rule = ROUTE_PERMISSIONS.get(key);
  if (!rule) throw new Error(`Мобильный маршрут «${key}» отсутствует в реестре прав`);
  if (rule.kind === 'always') return [];
  if (rule.kind === 'static') return [{ page: rule.page, action: rule.action }];
  const runtime = rule.cells;
  if (!runtime?.length) throw new Error(`Нет описания исходов (cells) для «${key}»`);
  return runtime;
}

describe('мобильный периметр не зависит от матрицы прав', () => {
  it.each(MOBILE_ROUTES)('%s %s открыт инспектору при дефолтных настройках', (method, url) => {
    for (const { page, action } of cellsOf(method, url)) {
      expect(
        isAllowed(EMPTY, 'inspector_kpp', page, action),
        `${method} ${url} → ${page}:${action}`,
      ).toBe(true);
    }
  });

  it.each(MOBILE_ROUTES)(
    '%s %s открыт инспектору даже когда админ запретил всё, что мог',
    (method, url) => {
      for (const { page, action } of cellsOf(method, url)) {
        expect(
          isAllowed(HOSTILE, 'inspector_kpp', page, action),
          `${method} ${url} → ${page}:${action} — планшет встанет молча`,
        ).toBe(true);
      }
    },
  );

  it('заблокировано ровно 8 ячеек: обе страницы Операций × 4 мобильных действия', () => {
    expect(LOCKED_CELLS.size).toBe(8);
    for (const page of ['operations.deliveries', 'operations.shipments'] as PageId[]) {
      for (const action of MOBILE_REQUIRED_ACTIONS) {
        expect(LOCKED_CELLS.has(`inspector_kpp:${page}:${action}`)).toBe(true);
      }
    }
  });

  it('замок покрывает ровно то, чем пользуется планшет, и ни действием больше', () => {
    // Инвариант против тихого разрастания: LOCKED_CELLS строится из
    // MOBILE_REQUIRED_ACTIONS, а не из всего PAGE_ACTIONS. Иначе каждое новое
    // действие автоматически становилось бы у инспектора включённым и
    // неснимаемым — первым таким был бы `review`, которого в мобильном клиенте
    // нет вовсе.
    const notMobile = PAGE_ACTIONS.filter((a) => !MOBILE_REQUIRED_ACTIONS.includes(a));
    expect(notMobile).not.toHaveLength(0);
    for (const page of ['operations.deliveries', 'operations.shipments'] as PageId[]) {
      for (const action of notMobile) {
        expect(
          LOCKED_CELLS.has(`inspector_kpp:${page}:${action}`),
          `${action} залочен у инспектора, хотя планшет им не пользуется`,
        ).toBe(false);
      }
    }
  });

  it('замок распространяется только на inspector_kpp', () => {
    // Мониторингу и менеджеру Операции сузить можно — их клиент (веб) 403
    // показывает и объясняет.
    expect(isAllowed(HOSTILE, 'inspector_kpp', 'operations.deliveries', 'view')).toBe(true);

    const monitorDenied: OverrideMap = new Map([
      [
        overrideKey('monitor', 'operations.deliveries'),
        { view: false, create: false, edit: false, delete: false },
      ],
    ]);
    expect(isAllowed(monitorDenied, 'monitor', 'operations.deliveries', 'view')).toBe(false);
  });

  it('вне Операций замка нет: инспектору можно закрыть «Историю поступлений»', () => {
    // Это web-страница, мобилка её не открывает — сужать безопасно.
    expect(isAllowed(HOSTILE, 'inspector_kpp', 'materials_journal', 'view')).toBe(false);
  });
});
