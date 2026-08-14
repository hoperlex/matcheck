/**
 * Сквозной no-op: при пустой таблице overrides система ведёт себя ровно так,
 * как вела бы БЕЗ матрицы прав. Каждый маршрут × каждая роль.
 *
 * Под этим тестом стоит всё обещание, под которым фича выкатывается: «в день
 * деплоя не меняется ничего». Остальные наборы проверяют слои по отдельности —
 * матрицу, гард, возможности; здесь они собраны в одну цепочку, в том порядке,
 * в котором работают на бою:
 *
 *   read-only-гард → матрица (хук) → allow-list (authorize) → inline в хендлере
 *
 * Отдельно важен гард: он переехал из server.ts в плагин и стал зависеть от
 * матрицы, то есть это самый свежий слой — и до появления этого теста ни одна
 * сквозная проверка его не касалась.
 */
import { describe, expect, it } from 'vitest';
import { MANAGED_ROLES, type ManagedRole } from '@matcheck/contracts';
import { ROUTE_PERMISSIONS, routeKey } from '../src/lib/permissions/route-map.js';
import { judgeRuleCells, matrixCellsOf } from '../src/lib/permissions/rule-cells.js';
import type { OverrideMap } from '../src/lib/permissions/matrix.js';
import { collectRoutes, isSyntheticMethod, type RouteRow } from './helpers/route-inventory.js';
import {
  apiAllows,
  guardBlocks,
  hasBaseline,
  MUTATING,
  routeAllows,
  WEB_ONLY_ROLES,
} from './helpers/access-model.js';
import { LEGACY_ROLES } from './fixtures/permissions-baseline.js';

/** Пустая таблица — то состояние, в котором система уходит в прод. */
const EMPTY: OverrideMap = new Map();

let cache: RouteRow[] | undefined;
async function routes(): Promise<RouteRow[]> {
  cache ??= await collectRoutes();
  return cache.filter((r) => !isSyntheticMethod(r.method));
}

/**
 * Модель боевого пути с ВКЛЮЧЁННОЙ матрицей и пустыми overrides.
 *
 * Повторяет plugins/permissions.ts по шагам: сперва гард (для web-only ролей),
 * затем матрица по ячейкам маршрута, затем allow-list — который снимается
 * только явным расширением, а его при пустой таблице быть не может.
 */
function modelAllows(role: ManagedRole, r: RouteRow): boolean {
  const key = routeKey(r.method, r.url);
  const rule = ROUTE_PERMISSIONS.get(key);

  // 1. Read-only-гард. При включённой матрице решает она, но на пустой таблице
  //    результат обязан совпасть с прежним хардкодом — это и проверяем.
  if (WEB_ONLY_ROLES.includes(role) && MUTATING.has(r.method.toUpperCase())) {
    if (!r.url.startsWith('/api/v1/auth/')) {
      const cells = rule ? matrixCellsOf(rule) : [];
      const allowed = cells.length > 0 && judgeRuleCells(rule!, EMPTY, role).allowed;
      if (!allowed) return false;
    }
  }

  // 2. Матрица. Маршрут вне реестра — fail-open, поведение прежнее.
  if (rule) {
    if (rule.kind === 'legacy' && rule.roles.includes(role)) return true;
    if (rule.kind !== 'always' && !judgeRuleCells(rule, EMPTY, role).allowed) return false;
  }

  // 3. allow-list и inline-проверки. Именно routeAllows, а НЕ apiAllows:
  //    последний внутри применил бы старый гард ещё раз, и излишне
  //    разрешающий новый гард (шаг 1) оказался бы скрыт — запрос прошёл бы
  //    модель нового гарда и молча упёрся в старый внутри baseline.
  //    Расширений на пустой таблице нет, значит authorize действует в полную
  //    силу, как и до матрицы.
  return routeAllows(role, r);
}

describe('пустая таблица overrides ≡ система без матрицы прав', () => {
  it('каждый маршрут × каждая роль: доступ совпадает с baseline', async () => {
    const diffs: string[] = [];

    for (const r of await routes()) {
      // Публичный периметр (login, refresh, share по токену) baseline не имеет:
      // req.user там не заполняется, и сравнивать нечего.
      if (!hasBaseline(r)) continue;
      for (const role of LEGACY_ROLES) {
        const before = apiAllows(role, r);
        const after = modelAllows(role, r);
        if (before !== after) {
          diffs.push(
            `${routeKey(r.method, r.url)} × ${role}: было ${before ? 'разрешено' : 'запрещено'}, ` +
              `стало ${after ? 'разрешено' : 'запрещено'}`,
          );
        }
      }
    }

    expect(
      diffs.sort(),
      'Матрица на дефолтах обязана быть тождественна прежнему поведению.',
    ).toEqual([]);
  });

  it('проверка охватывает весь реестр, а не пару маршрутов', async () => {
    // Страховка от «зелёного пустого прогона»: если инвентарь однажды вернёт
    // пусто, предыдущий тест пройдёт, ничего не проверив.
    const all = await routes();
    expect(all.length).toBeGreaterThan(150);
    expect(all.filter(hasBaseline).length).toBeGreaterThan(140);
    expect(LEGACY_ROLES.length).toBe(4);
    // Роли, появившиеся после матрицы, в сравнении не участвуют — у них нет
    // «поведения до». Список ниже обязан оставаться исчерпывающим: добавили
    // роль, не внеся её ни сюда, ни в LEGACY_ROLES — тест заставит решить, к
    // какому классу она относится.
    expect(MANAGED_ROLES.filter((r) => !LEGACY_ROLES.includes(r))).toEqual(['observer']);
  });

  it('вне сравнения остаётся только публичный периметр', async () => {
    // Фильтром hasBaseline легко было бы незаметно вывести из-под проверки
    // что-то важное. Поэтому проверяем явно: пропущенные маршруты — те, что не
    // требуют аутентификации, и их единицы.
    const skipped = (await routes()).filter((r) => !hasBaseline(r));
    const authenticated = skipped.filter((r) => r.authenticated);
    expect(authenticated.map((r) => routeKey(r.method, r.url)).sort()).toEqual([]);
    expect(skipped.length).toBeLessThan(20);
  });

  it('гард на пустой таблице повторяет прежний хардкод', async () => {
    // Отдельно и явно: это тот слой, который переехал последним.
    const mismatched: string[] = [];
    for (const r of await routes()) {
      if (!hasBaseline(r)) continue;
      for (const role of WEB_ONLY_ROLES) {
        const legacyGuard = guardBlocks(role, r);
        const rule = ROUTE_PERMISSIONS.get(routeKey(r.method, r.url));
        const cells = rule ? matrixCellsOf(rule) : [];
        const matrixGuard =
          WEB_ONLY_ROLES.includes(role) &&
          MUTATING.has(r.method.toUpperCase()) &&
          !r.url.startsWith('/api/v1/auth/') &&
          !(cells.length > 0 && judgeRuleCells(rule!, EMPTY, role).allowed);

        if (legacyGuard !== matrixGuard) {
          mismatched.push(`${routeKey(r.method, r.url)} × ${role}`);
        }
      }
    }
    expect(mismatched.sort()).toEqual([]);
  });
});
