/**
 * Главный инвариант фичи: ДЕФОЛТНАЯ МАТРИЦА == СЕГОДНЯШНИЕ ПРАВА.
 *
 * Обещание пользователю — «в день выката не меняется ничего». Это тест,
 * который его стережёт, и он проверяет обе стороны:
 *   • матрица не РАСШИРЯЕТ права (нельзя выдать то, чего нет в коде);
 *   • матрица не СУЖАЕТ права (нельзя молча отобрать действующий доступ).
 *
 * Права берутся не из grep по authorize(...), а из фактической инвентаризации
 * маршрутов (test/helpers/route-inventory.ts) плюс audited-фикстуры для 33
 * маршрутов с inline-проверками (test/fixtures/permissions-baseline.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATRIX,
  MANAGED_ROLES,
  PAGE_ACTIONS,
  PAGE_CATALOG,
  PAGE_IDS,
  type ManagedRole,
  type PageAction,
  type PageId,
} from '@matcheck/contracts';
import { ROUTE_PERMISSIONS, routeKey } from '../src/lib/permissions/route-map.js';
import { collectRoutes, isSyntheticMethod, type RouteRow } from './helpers/route-inventory.js';
import {
  INLINE_ROLE_ACCESS,
  KNOWN_API_UI_GAPS,
  NAV_ACCESS,
  RUNTIME_RULE_COVERAGE,
  UI_ONLY_CELLS,
} from './fixtures/permissions-baseline.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** server.ts: единственные мутации, оставленные роли monitor. */
const MONITOR_WRITE_ROUTES = new Set([
  '/api/v1/deliveries/:id/review',
  '/api/v1/shipments/:id/review',
]);

let cache: RouteRow[] | undefined;
async function routes(): Promise<RouteRow[]> {
  cache ??= await collectRoutes();
  return cache.filter((r) => !isSyntheticMethod(r.method));
}

/** Имеет ли роль доступ к маршруту СЕГОДНЯ — как если бы матрицы не было. */
function apiAllows(role: ManagedRole, r: RouteRow): boolean {
  const key = routeKey(r.method, r.url);

  // Глобальный read-only-хук (server.ts) — поверх любых allow-list'ов.
  if (role === 'contractor' || role === 'monitor') {
    if (MUTATING.has(r.method.toUpperCase()) && !r.url.startsWith('/api/v1/auth/')) {
      if (!(role === 'monitor' && MONITOR_WRITE_ROUTES.has(r.url))) return false;
    }
  }

  if (r.roles.length > 0) return (r.roles as string[]).includes(role);

  const inline = INLINE_ROLE_ACCESS[key];
  if (inline) return inline.includes(role);

  throw new Error(
    `Маршрут «${key}» объявлен без app.authorize(...) и отсутствует в INLINE_ROLE_ACCESS. ` +
      'Добавьте его в test/fixtures/permissions-baseline.ts с указанием фактических ролей — ' +
      'иначе baseline перестаёт быть полным.',
  );
}

function cell(role: ManagedRole, page: PageId, action: PageAction): string {
  return `${role}:${page}:${action}`;
}

/**
 * Пары (страница, действие), которые маршрут способен потребовать. Для
 * static это одна пара; для dynamic и in-handler — все возможные исходы из
 * фикстуры, иначе самое важное право (operations:create через upsert)
 * осталось бы вне проверки.
 */
function coveredCells(r: RouteRow): { page: PageId; action: PageAction }[] {
  const key = routeKey(r.method, r.url);
  const rule = ROUTE_PERMISSIONS.get(key);
  if (!rule) return [];
  if (rule.kind === 'static') return [{ page: rule.page, action: rule.action }];
  if (rule.kind === 'always') return [];

  const runtime = RUNTIME_RULE_COVERAGE[key];
  if (!runtime) {
    throw new Error(
      `Маршрут «${key}» помечен ${rule.kind}, но его исходы не описаны в ` +
        'RUNTIME_RULE_COVERAGE. Без этого право, которое он охраняет, не проверяется.',
    );
  }
  return runtime;
}

describe('дефолтная матрица == сегодняшние права', () => {
  it('матрица НЕ СУЖАЕТ: доступ к каждому enforced-маршруту сохранён в дефолте', async () => {
    const lost: string[] = [];

    for (const r of await routes()) {
      // always даёт пустой список — такие маршруты выведены из-под матрицы.
      // static/dynamic/in-handler дают все пары, которые они могут потребовать.
      const cells = coveredCells(r);
      if (cells.length === 0) continue;

      for (const role of MANAGED_ROLES) {
        if (!apiAllows(role, r)) continue;
        for (const { page, action } of cells) {
          if (!DEFAULT_MATRIX[role][page][action]) {
            lost.push(`${role} теряет ${page}:${action} (${routeKey(r.method, r.url)})`);
          }
        }
      }
    }

    expect(
      [...new Set(lost)].sort(),
      'Дефолт отбирает доступ, который роль имеет сейчас. Либо расширьте base в ' +
        'PAGE_CATALOG, либо пометьте маршрут always и внесите его в KNOWN_API_UI_GAPS.',
    ).toEqual([]);
  });

  it('матрица НЕ РАСШИРЯЕТ: каждая разрешённая ячейка подтверждена реальным доступом', async () => {
    const all = await routes();
    const granted: string[] = [];

    for (const role of MANAGED_ROLES) {
      for (const page of PAGE_IDS) {
        for (const action of PAGE_ACTIONS) {
          if (!DEFAULT_MATRIX[role][page][action]) continue;
          if (UI_ONLY_CELLS.has(cell(role, page, action))) continue;

          const confirmed = all.some(
            (r) =>
              coveredCells(r).some((c) => c.page === page && c.action === action) &&
              apiAllows(role, r),
          );

          if (!confirmed) granted.push(cell(role, page, action));
        }
      }
    }

    expect(
      granted.sort(),
      'Дефолт разрешает то, чего у роли нет сегодня. Матрица обязана только сужать: ' +
        'уберите право из base либо внесите ячейку в UI_ONLY_CELLS с обоснованием.',
    ).toEqual([]);
  });

  it('base каталога не шире навигации веба', () => {
    const wider: string[] = [];
    for (const page of PAGE_CATALOG) {
      const nav = NAV_ACCESS[page.id];
      for (const action of PAGE_ACTIONS) {
        for (const role of page.base[action] ?? []) {
          if (!nav.includes(role)) wider.push(`${page.id}:${action} → ${role} нет в навигации`);
        }
      }
    }
    expect(wider.sort()).toEqual([]);
  });

  it('все разрывы «API щедрее UI» классифицированы явно', async () => {
    const unclassified: string[] = [];

    for (const r of await routes()) {
      const key = routeKey(r.method, r.url);
      const rule = ROUTE_PERMISSIONS.get(key);
      if (!rule || rule.kind !== 'static') continue;

      const nav = NAV_ACCESS[rule.page];
      const gap = MANAGED_ROLES.filter((role) => apiAllows(role, r) && !nav.includes(role));
      if (gap.length > 0 && !(key in KNOWN_API_UI_GAPS)) {
        unclassified.push(`${key} — доступен ${gap.join(', ')}, страницы «${rule.page}» у них нет`);
      }
    }

    expect(
      unclassified.sort(),
      'Найден маршрут, который матрица отберёт у роли, не имеющей соответствующей страницы. ' +
        'Пометьте его always и опишите в KNOWN_API_UI_GAPS (сужение — отдельное согласование).',
    ).toEqual([]);
  });

  it('каждый известный разрыв действительно помечен always', () => {
    const wrong = Object.keys(KNOWN_API_UI_GAPS).filter(
      (key) => ROUTE_PERMISSIONS.get(key)?.kind !== 'always',
    );
    expect(wrong, 'Разрыв описан, но маршрут не выведен из-под матрицы').toEqual([]);
  });

  it('каталог согласован: base не содержит неприменимых действий', () => {
    const bad: string[] = [];
    for (const page of PAGE_CATALOG) {
      for (const action of PAGE_ACTIONS) {
        const roles = page.base[action] ?? [];
        if (roles.length > 0 && !page.actions.includes(action)) {
          bad.push(`${page.id}: действие ${action} неприменимо, но в base есть роли`);
        }
      }
    }
    expect(bad).toEqual([]);
    expect(PAGE_CATALOG).toHaveLength(23);
    expect(new Set(PAGE_CATALOG.map((p) => p.id)).size).toBe(23);
  });
});
