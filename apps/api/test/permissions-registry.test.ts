/**
 * Инвариант реестра прав: КАЖДЫЙ зарегистрированный маршрут перечислен в
 * ROUTE_PERMISSIONS.
 *
 * Зачем. В рантайме маршрут, которого нет в реестре, намеренно проходит без
 * проверки (fail-open) — иначе первый же забытый роут положил бы прод, а
 * обещание «в день выката ничего не меняется» перестало бы выполняться.
 * Расплата за fail-open — риск, что новый эндпоинт молча окажется вне
 * матрицы. Этот тест и есть плата по счёту: забыл строку в реестре — CI
 * красный, а не тихая дыра на бою.
 *
 * Обратная проверка тоже нужна: строка в реестре для несуществующего
 * маршрута означает опечатку в шаблоне (например `/:photoId/thumb` вместо
 * реального пути), а такая строка не сработает никогда.
 */
import { describe, expect, it } from 'vitest';
import { ROUTE_PERMISSIONS, routeKey } from '../src/lib/permissions/route-map.js';
import { collectRoutes, isSyntheticMethod, type RouteRow } from './helpers/route-inventory.js';

let cache: RouteRow[] | undefined;
async function routes(): Promise<RouteRow[]> {
  cache ??= await collectRoutes();
  return cache.filter((r) => !isSyntheticMethod(r.method));
}

describe('реестр прав покрывает все маршруты', () => {
  it('каждый маршрут есть в ROUTE_PERMISSIONS', async () => {
    const missing = (await routes())
      .filter((r) => !ROUTE_PERMISSIONS.has(routeKey(r.method, r.url)))
      .map((r) => routeKey(r.method, r.url));

    expect(
      missing,
      'Маршруты без правила в route-map.ts. Добавьте строку: static (право известно ' +
        'заранее), dynamic (страница из тела), in-handler (нужен SELECT) или always ' +
        '(сознательно вне матрицы — с обоснованием).',
    ).toEqual([]);
  });

  it('в реестре нет строк для несуществующих маршрутов', async () => {
    const real = new Set((await routes()).map((r) => routeKey(r.method, r.url)));
    const stale = [...ROUTE_PERMISSIONS.keys()].filter((k) => !real.has(k));

    expect(stale, 'Строки реестра без соответствующего маршрута — опечатка в шаблоне').toEqual([]);
  });

  it('HEAD не требует отдельных строк — routeKey нормализует его в GET', () => {
    expect(routeKey('HEAD', '/api/v1/sites')).toBe('GET /api/v1/sites');
    expect(routeKey('head', '/api/v1/sites')).toBe('GET /api/v1/sites');
    expect(routeKey('post', '/api/v1/sites')).toBe('POST /api/v1/sites');
  });

  it('у каждого always-правила есть непустое обоснование', () => {
    const naked = [...ROUTE_PERMISSIONS.entries()]
      .filter(([, rule]) => rule.kind === 'always' && rule.note.trim().length < 20)
      .map(([k]) => k);
    expect(naked, 'always без внятного обоснования читается как «забыли»').toEqual([]);
  });
});
