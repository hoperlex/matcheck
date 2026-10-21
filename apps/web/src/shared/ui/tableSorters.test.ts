/**
 * Пустые значения — внизу при ЛЮБОМ направлении сортировки.
 *
 * antd при DESC переворачивает знак результата компаратора (getSortData), и
 * компаратор без учёта направления поднимал пустые наверх — вопреки
 * обещанию в шапке tableSorters.ts.
 */
import type { SortOrder } from 'antd/es/table/interface';
import { describe, expect, it } from 'vitest';
import { dateSorter, numberSorter, prioritySorter, stringSorter } from './tableSorters';

/** Как antd применяет компаратор: при descend знак переворачивается. */
function sortLikeAntd<T>(
  rows: readonly T[],
  cmp: (a: T, b: T, order?: SortOrder) => number,
  order: 'ascend' | 'descend',
): T[] {
  return rows.slice().sort((a, b) => {
    const r = cmp(a, b, order);
    return order === 'ascend' ? r : -r;
  });
}

type Row = { v: string | number | null };
const rows = (...vs: Row['v'][]): Row[] => vs.map((v) => ({ v }));
const vals = (rs: Row[]) => rs.map((r) => r.v);

describe('tableSorters: пустые внизу в обе стороны', () => {
  it('stringSorter — ru-алфавит, числа внутри строк по значению', () => {
    const cmp = stringSorter<Row>((r) => (r.v == null ? null : String(r.v)));
    const data = rows('Бета', null, 'альфа', '', 'Склад 10', 'Склад 9');
    expect(vals(sortLikeAntd(data, cmp, 'ascend'))).toEqual([
      'альфа',
      'Бета',
      'Склад 9',
      'Склад 10',
      null,
      '',
    ]);
    expect(vals(sortLikeAntd(data, cmp, 'descend')).slice(0, 4)).toEqual([
      'Склад 10',
      'Склад 9',
      'Бета',
      'альфа',
    ]);
    expect(vals(sortLikeAntd(data, cmp, 'descend')).slice(4)).toEqual([null, '']);
  });

  it('numberSorter — нечисловое считается пустым', () => {
    const cmp = numberSorter<Row>((r) => r.v);
    const data = rows(10, null, 2, 'abc', 33);
    expect(vals(sortLikeAntd(data, cmp, 'ascend'))).toEqual([2, 10, 33, null, 'abc']);
    expect(vals(sortLikeAntd(data, cmp, 'descend')).slice(0, 3)).toEqual([33, 10, 2]);
  });

  it('dateSorter — невалидная дата в конце', () => {
    const cmp = dateSorter<Row>((r) => (r.v == null ? null : String(r.v)));
    const data = rows('2026-10-02', null, '2026-09-30', 'не дата');
    expect(vals(sortLikeAntd(data, cmp, 'descend')).slice(0, 2)).toEqual([
      '2026-10-02',
      '2026-09-30',
    ]);
    expect(vals(sortLikeAntd(data, cmp, 'ascend')).slice(0, 2)).toEqual([
      '2026-09-30',
      '2026-10-02',
    ]);
  });

  it('prioritySorter — значения вне списка и пустые в конце', () => {
    const cmp = prioritySorter<Row, string>(
      (r) => (r.v == null ? null : String(r.v)),
      ['upd', 'request'],
    );
    const data = rows('request', null, 'other', 'upd');
    expect(vals(sortLikeAntd(data, cmp, 'ascend')).slice(0, 2)).toEqual(['upd', 'request']);
    expect(vals(sortLikeAntd(data, cmp, 'descend')).slice(0, 2)).toEqual(['request', 'upd']);
  });
});
