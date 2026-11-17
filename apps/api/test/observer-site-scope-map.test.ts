/**
 * Полнота карты SITE_SCOPE_MAP (lib/permissions/site-scope-map.ts).
 *
 * Наблюдатель видит только свои объекты. Маршрут, который ему можно открыть
 * галочкой, обязан либо сверять объект (enforced), либо не иметь данных объекта
 * (global). Неразмеченный маршрут хук закрывает (403) — то есть ошибка разметки
 * не утечка, а сломанная страница. Этот тест ловит её раньше выката: новый
 * маршрут, открываемый просмотром разрешённой наблюдателю страницы, без строки
 * в карте роняет сборку.
 */
import { describe, expect, it } from 'vitest';
import { OBSERVER_PAGES, type PageAction, type PageId } from '@matcheck/contracts';
import { ROUTE_PERMISSIONS } from '../src/lib/permissions/route-map.js';
import { SITE_SCOPE_MAP } from '../src/lib/permissions/site-scope-map.js';

type Cell = { page: PageId; action: PageAction };

/** Ячейки, которыми маршрут можно открыть наблюдателю (без записи — её ему не выдают). */
function observerCells(key: string): Cell[] {
  const rule = ROUTE_PERMISSIONS.get(key)!;
  const policy = rule.matrixOnly;
  let cells: Cell[] = [];
  if (policy?.mode === 'cells') cells = policy.openedBy;
  else if (policy) cells = [];
  else if (rule.kind === 'static') cells = [{ page: rule.page, action: rule.action }];
  else if (rule.kind === 'in-handler') cells = rule.cells ?? [];
  return cells.filter((c) => c.action === 'view' && OBSERVER_PAGES.has(c.page));
}

describe('карта объектов наблюдателя', () => {
  it('каждый маршрут, открываемый наблюдателю просмотром, размечен', () => {
    const missing: string[] = [];
    for (const key of ROUTE_PERMISSIONS.keys()) {
      if (ROUTE_PERMISSIONS.get(key)!.matrixOnly?.mode === 'allow') continue;
      if (observerCells(key).length === 0) continue;
      if (!SITE_SCOPE_MAP.has(key)) missing.push(key);
    }
    expect(
      missing,
      'Маршрут открывается наблюдателю галочкой просмотра, но не размечен в ' +
        'SITE_SCOPE_MAP. Научите обработчик сверять объект (lib/site-scope.ts) ' +
        'и добавьте его как enforced, либо как global, если объекта у данных нет.',
    ).toEqual([]);
  });

  it('в карте нет строк для несуществующих маршрутов', () => {
    const stale = [...SITE_SCOPE_MAP.keys()].filter((k) => !ROUTE_PERMISSIONS.has(k));
    expect(stale).toEqual([]);
  });

  it('в карте нет маршрутов, которые наблюдателю не открыть', () => {
    // Лишняя строка — не дыра, но ложное утверждение «сверяет объект» о
    // маршруте, который никто не проверял под наблюдателем.
    const unreachable = [...SITE_SCOPE_MAP.keys()].filter((k) => observerCells(k).length === 0);
    expect(unreachable).toEqual([]);
  });

  it('global — только справочники без объекта', () => {
    const globals = [...SITE_SCOPE_MAP].filter(([, mark]) => mark === 'global').map(([k]) => k);
    for (const key of globals) {
      const pages = observerCells(key).map((c) => c.page);
      expect(
        pages.some((p) => p.startsWith('references.') && p !== 'references.sites'),
        key,
      ).toBe(true);
      expect(key.startsWith('GET '), key).toBe(true);
    }
  });

  it('размечены только чтения: запись наблюдателю не выдаётся', () => {
    const writes = [...SITE_SCOPE_MAP.keys()].filter((k) => !k.startsWith('GET '));
    expect(writes).toEqual([]);
  });
});
