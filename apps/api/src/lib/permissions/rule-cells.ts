import { isActionApplicable, type ManagedRole, type PageAction, type PageId } from '@matcheck/contracts';
import { isAllowed, isExpanded, type OverrideMap } from './matrix.js';
import type { RouteRule } from './route-map.js';

/**
 * Ячейки маршрута и решение матрицы по ним — одно место для рантайма и для
 * /me/permissions.
 *
 * Зачем общая функция. Правило класса `static` держит ровно одну ячейку, а
 * `dynamic` и `in-handler` — несколько (upsert: create или edit; фото: приёмка
 * или отгрузка), и какая сработает, выясняется только в рантайме. Пока эта
 * логика жила в двух местах — в хуке плагина и в вычислении возможностей —
 * они разошлись: хук учитывал `cells`, а возможности смотрели только на
 * `static`/`legacy`. Из-за этого выданное монитору право не добавляло ему
 * capability маршрутов фото: роль не в allow-list, а расширение не
 * рассматривалось вовсе.
 */

/** Все ячейки, которыми маршрут может обернуться. Пустой массив = вне матрицы. */
export function cellsOfRule(rule: RouteRule): { page: PageId; action: PageAction }[] {
  if (rule.kind === 'static' || rule.kind === 'legacy') {
    return [{ page: rule.page, action: rule.action }];
  }
  return rule.cells ?? [];
}

/**
 * Ячейки, которые матрица РЕАЛЬНО проверяет: неприменимые действия отсеяны.
 *
 * Разница не теоретическая. `admin.edo_accounts` не имеет действия `edit`
 * (учётку ЭДО пересоздают, PATCH-роута нет), а legacy-правило маршрута sync
 * ссылается именно на него. Резолвер такие пары не режет — «действия нет в
 * каталоге» значит «матрица к маршруту не применяется», и держит его
 * allow-list. Но для read-only-гарда это обязано читаться как «под матрицей
 * ячеек нет», иначе он пропустил бы мутацию web-only роли туда, где матрица не
 * защищает ничего.
 */
export function matrixCellsOf(rule: RouteRule): { page: PageId; action: PageAction }[] {
  return cellsOfRule(rule).filter((c) => isActionApplicable(c.page, c.action));
}

export type CellVerdict = {
  /** Матрица разрешает хотя бы одну ячейку маршрута (или ячеек нет вовсе). */
  allowed: boolean;
  /**
   * Право на маршрут ВЫДАНО сверх дефолта, и политика маршрута пускает эту
   * роль. Только в этом случае снимается allow-list.
   */
  expanded: boolean;
};

/**
 * Что матрица говорит про маршрут для конкретной роли.
 *
 * «Хотя бы одна» — сознательно: до SELECT неизвестно, какая ветка сработает, а
 * требовать разрешения всех значило бы, что выданное «Создавать» не действует,
 * пока не выдано ещё и «Редактировать». Точную пару проверяет assertPermission
 * внутри обработчика.
 */
export function judgeRuleCells(
  rule: RouteRule,
  overrides: OverrideMap,
  role: ManagedRole,
): CellVerdict {
  const cells = matrixCellsOf(rule);
  // Ячеек нет — маршрут вне матрицы, и запрещать ей нечего. Для ГАРДА эта же
  // ситуация читается наоборот, поэтому он спрашивает matrixCellsOf сам.
  if (cells.length === 0) return { allowed: true, expanded: false };

  const allowed = cells.some((c) => isAllowed(overrides, role, c.page, c.action));
  const expanded =
    (rule.expandableBy?.includes(role) ?? true) &&
    cells.some((c) => isExpanded(overrides, role, c.page, c.action));

  return { allowed, expanded };
}
