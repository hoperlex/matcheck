import { PAGE_ACTIONS, PAGE_CATALOG, isActionApplicable } from '@matcheck/contracts';
import { ROUTE_PERMISSIONS } from './route-map.js';
import { cellsOfRule } from './rule-cells.js';

/**
 * Насколько честно ячейка матрицы управляет доступом.
 *
 *   full        — все маршруты ячейки проверяются матрицей;
 *   partial     — часть маршрутов вне матрицы (`always`): страница скроется, но
 *                 те же данные останутся доступны по API;
 *   portal-only — маршрутов под матрицей нет вовсе: галочка управляет только
 *                 вкладкой в портале.
 *
 * Зачем это показывать. У чтения справочников и документов одни и те же ручки
 * кормят и вкладку, и комбобоксы формы приёмки, и мобильный `/sync`, поэтому
 * они помечены `always`. Снятый «Просмотр» убирает раздел из меню, но не
 * закрывает данные — и администратор вправе знать это до того, как понадеется
 * на галочку. Признак «нет ни одного не-always маршрута» для этого не годится:
 * у `documents.list:view` есть ещё и static-маршрут import-result, и ячейка
 * выглядела бы полностью закрытой.
 */
export type CellCoverage = 'full' | 'partial' | 'portal-only';

export function computeCellCoverage(): Record<string, CellCoverage> {
  // Считаем маршруты по каждой паре: сколько всего и сколько вне матрицы.
  const total = new Map<string, number>();
  const outside = new Map<string, number>();

  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

  for (const rule of ROUTE_PERMISSIONS.values()) {
    if (rule.kind === 'always') {
      // Ячейки, которых этот маршрут касается, объявляются полем affects:
      // без него связь «always-маршрут ↔ ячейка» вывести неоткуда.
      for (const c of rule.affects ?? []) {
        const key = `${c.page}:${c.action}`;
        bump(total, key);
        bump(outside, key);
      }
      continue;
    }
    for (const c of cellsOfRule(rule)) bump(total, `${c.page}:${c.action}`);
  }

  const out: Record<string, CellCoverage> = {};
  for (const page of PAGE_CATALOG) {
    for (const action of PAGE_ACTIONS) {
      if (!isActionApplicable(page.id, action)) continue;
      const key = `${page.id}:${action}`;
      const all = total.get(key) ?? 0;
      const free = outside.get(key) ?? 0;
      if (all === 0 || free === all) out[key] = 'portal-only';
      else if (free > 0) out[key] = 'partial';
      else out[key] = 'full';
    }
  }
  return out;
}
