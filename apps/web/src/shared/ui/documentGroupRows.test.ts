import { describe, expect, it } from 'vitest';
import {
  clusterRowsByGroup,
  GROUP_COLOR_COUNT,
  groupColorIndex,
  groupRowClass,
} from './documentGroupRows';

/**
 * Группировка строк машины в списке документов.
 *
 * Два свойства здесь важнее остальных. Первое — входной массив не мутируется:
 * он приходит из кэша React Query, и сортировка по месту рассинхронизировала бы
 * кэш с сервером. Второе — цвет привязан к groupId, а не к позиции: иначе он
 * прыгал бы при каждой пагинации и фильтре.
 */
describe('группировка строк документов', () => {
  const row = (id: string, groupId?: string | null) => ({ id, groupId });

  it('строки одной машины собираются подряд', () => {
    const rows = [row('a', 'g1'), row('b', null), row('c', 'g1')];

    expect(clusterRowsByGroup(rows).map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });

  it('кластер встаёт на место ПЕРВОГО своего документа — порядок списка сохраняется', () => {
    // Список отсортирован по дате; сборка машины не должна поднимать её наверх.
    const rows = [row('one', null), row('two', 'g1'), row('three', null), row('four', 'g1')];

    expect(clusterRowsByGroup(rows).map((r) => r.id)).toEqual(['one', 'two', 'four', 'three']);
  });

  it('входной массив не меняется', () => {
    const rows = [row('a', 'g1'), row('b', null), row('c', 'g1')];
    const before = [...rows];

    clusterRowsByGroup(rows);

    expect(rows).toEqual(before);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('без групп список остаётся ровно таким же', () => {
    const rows = [row('a'), row('b', null), row('c')];

    expect(clusterRowsByGroup(rows).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('ни одна строка не теряется и не двоится', () => {
    const rows = [row('a', 'g1'), row('b', 'g2'), row('c', 'g1'), row('d', null), row('e', 'g2')];

    const clustered = clusterRowsByGroup(rows);

    expect(clustered).toHaveLength(rows.length);
    expect(new Set(clustered.map((r) => r.id))).toEqual(new Set(['a', 'b', 'c', 'd', 'e']));
  });

  it('строки одной машины получают одинаковый класс, одиночные — никакого', () => {
    expect(groupRowClass('g1')).toBe(groupRowClass('g1'));
    expect(groupRowClass(null)).toBe('');
    expect(groupRowClass(undefined)).toBe('');
  });

  it('цвет зависит от groupId, а не от позиции, и не выходит за палитру', () => {
    const ids = ['8a22c3d-1', '08a22c3d-c10e-4d9d', 'zzz', ''];
    for (const id of ids) {
      const idx = groupColorIndex(id);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(GROUP_COLOR_COUNT);
      // Повторный вызов даёт то же значение — иначе цвет прыгал бы на каждой
      // перерисовке таблицы.
      expect(groupColorIndex(id)).toBe(idx);
    }
  });
});
