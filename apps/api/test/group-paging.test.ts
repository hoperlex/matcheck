/**
 * Упаковка страниц по поставкам.
 *
 * Главное свойство: поставка не разрывается между страницами. Всё остальное
 * (сколько именно строк на странице) вторично — пользователь смотрит на машину
 * целиком, а не считает строки.
 */
import { describe, expect, it } from 'vitest';
import {
  pageOfGroupedRows,
  type GroupPagingRow,
} from '../src/domain/sourceDocuments/group-paging.js';

/** n строк одной поставки. */
function group(id: string, n: number, kind: 'doc' | 'pending' = 'doc'): GroupPagingRow[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${id}-${i}`, groupId: id, kind }));
}

describe('страница не разрывает поставку', () => {
  it('поставка целиком уезжает на следующую страницу, а не режется', () => {
    // 8 строк, страница 10: сначала 9 одиночек, затем поставка из 3.
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => group(`s${i}`, 1)).flat(),
      ...group('g', 3),
    ];
    const first = pageOfGroupedRows(rows, 1, 10);
    const second = pageOfGroupedRows(rows, 2, 10);

    // Девять одиночек влезли, поставка из трёх — уже нет, и её не делят.
    expect(first.rows).toHaveLength(9);
    expect(first.rows.some((r) => r.groupId === 'g')).toBe(false);
    expect(second.rows.map((r) => r.groupId)).toEqual(['g', 'g', 'g']);
    expect(first.pageCount).toBe(2);
  });

  it('поставка крупнее страницы занимает свою страницу и не оставляет пустых', () => {
    const rows = [...group('big', 7), ...group('a', 1), ...group('b', 1)];
    const p1 = pageOfGroupedRows(rows, 1, 5);
    const p2 = pageOfGroupedRows(rows, 2, 5);

    expect(p1.rows).toHaveLength(7);
    expect(p1.rows.every((r) => r.groupId === 'big')).toBe(true);
    // Следующая страница непустая: дыр в пагинаторе быть не должно.
    expect(p2.rows.map((r) => r.groupId)).toEqual(['a', 'b']);
    expect(p1.pageCount).toBe(2);
  });

  it('порядок поставок задаёт первое появление, документы внутри идут подряд', () => {
    // Строки уже отсортированы сервером: g2 встретилась раньше g1.
    const rows: GroupPagingRow[] = [
      { id: 'd1', groupId: 'g2', kind: 'doc' },
      { id: 'd2', groupId: 'g1', kind: 'doc' },
      { id: 'd3', groupId: 'g2', kind: 'doc' },
    ];
    const { rows: page } = pageOfGroupedRows(rows, 1, 50);

    expect(page.map((r) => r.id)).toEqual(['d1', 'd3', 'd2']);
  });

  it('принятый файл идёт внутри своей поставки, а не отдельной строкой', () => {
    const rows: GroupPagingRow[] = [
      { id: 'doc-1', groupId: 'g', kind: 'doc' },
      { id: 'other', groupId: 'other', kind: 'doc' },
      { id: 'file-1', groupId: 'g', kind: 'pending' },
    ];
    const { rows: page } = pageOfGroupedRows(rows, 1, 50);

    expect(page.map((r) => r.id)).toEqual(['doc-1', 'file-1', 'other']);
  });

  it('ни одна строка не теряется и не задваивается между страницами', () => {
    const rows = [
      ...group('a', 3),
      ...group('b', 1),
      ...group('c', 4),
      ...group('d', 2),
      ...group('e', 5),
    ];
    const { pageCount } = pageOfGroupedRows(rows, 1, 5);
    const seen: string[] = [];
    for (let p = 1; p <= pageCount; p++)
      seen.push(...pageOfGroupedRows(rows, p, 5).rows.map((r) => r.id));

    expect(seen.sort()).toEqual(rows.map((r) => r.id).sort());
    expect(new Set(seen).size).toBe(rows.length);
  });

  it('страница за пределами набора пуста, а пустой список — это одна страница', () => {
    expect(pageOfGroupedRows(group('a', 2), 5, 50).rows).toEqual([]);
    expect(pageOfGroupedRows([], 1, 50)).toEqual({ rows: [], pageCount: 1 });
  });
});
