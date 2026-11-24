import { describe, expect, it, vi } from 'vitest';
import {
  GROUP_CELL_CLASS,
  groupHeadId,
  withGroupRowCells,
  withGroupRows,
  type KeyedGroupHead,
} from './groupRows';

/**
 * Два режима строки группы: растянутая ячейка («Принятые») и раскладка по
 * колонкам («Документы»). Общее у них одно — колонка никогда не получает
 * строку группы в свой render/onCell: rc-table зовёт render до проверки
 * colSpan, и колонка, читающая поле документа, упала бы.
 */
type Doc = { id: string; siteName: string | null; total: string };
type Head = KeyedGroupHead<{ label: string }>;

const head: Head = {
  kind: 'group',
  id: groupHeadId('g1'),
  key: 'g1',
  group: { label: 'поставка' },
  visibleIds: ['d1', 'd2'],
  collapsed: false,
};
const doc: Doc = { id: 'd1', siteName: 'ЖК ДОМ 56', total: '10.00' };

type Col = {
  key?: string;
  dataIndex?: string;
  render?: (value: unknown, record: unknown, i: number) => unknown;
  onCell?: (record: unknown, i?: number) => Record<string, unknown>;
};

function columns() {
  const siteRender = vi.fn((v: unknown) => `объект: ${String(v)}`);
  const siteOnCell = vi.fn(() => ({ title: 'site' }));
  const cols = [
    { key: 'siteName', dataIndex: 'siteName', render: siteRender, onCell: siteOnCell },
    { key: 'total', dataIndex: 'total' },
  ];
  return { cols, siteRender, siteOnCell };
}

describe('строка группы по колонкам (withGroupRowCells)', () => {
  it('каждая колонка рисует свою ячейку, ничего не растягивается', () => {
    const { cols, siteRender, siteOnCell } = columns();
    const headCell = vi.fn((_h: Head, ctx: { key: string }) => `шапка:${ctx.key}`);
    const out = withGroupRowCells<Doc, Head>(cols, headCell) as unknown as Col[];

    expect(out.map((c) => c.render!(undefined, head, 0))).toEqual([
      'шапка:siteName',
      'шапка:total',
    ]);
    for (const c of out) {
      expect(c.onCell!(head, 0)).toEqual({ className: GROUP_CELL_CLASS });
    }
    // Свои render/onCell колонки строку группы не видят.
    expect(siteRender).not.toHaveBeenCalled();
    expect(siteOnCell).not.toHaveBeenCalled();
  });

  it('renderAs рисует ячейку так же, как у документа', () => {
    const { cols } = columns();
    const out = withGroupRowCells<Doc, Head>(cols, (_h, ctx) =>
      ctx.renderAs(doc),
    ) as unknown as Col[];

    expect(out[0]!.render!(undefined, head, 0)).toBe('объект: ЖК ДОМ 56');
    // Колонка без своего render — значение поля как есть.
    expect(out[1]!.render!(undefined, head, 0)).toBe('10.00');
  });

  it('строки документов идут через собственные render и onCell колонки', () => {
    const { cols, siteOnCell } = columns();
    const out = withGroupRowCells<Doc, Head>(cols, () => 'шапка') as unknown as Col[];

    expect(out[0]!.render!('ЖК ДОМ 56', doc, 0)).toBe('объект: ЖК ДОМ 56');
    expect(out[1]!.render!('10.00', doc, 0)).toBe('10.00');
    expect(out[0]!.onCell!(doc, 0)).toEqual({ title: 'site' });
    expect(siteOnCell).toHaveBeenCalledWith(doc, 0);
  });
});

describe('растянутая строка группы (withGroupRows) — как раньше', () => {
  it('первая колонка на всю ширину, остальные скрыты', () => {
    const { cols } = columns();
    const out = withGroupRows<Doc, Head>(cols, (h) => h.group.label, {
      selectionCell: true,
    }) as unknown as Col[];

    expect(out[0]!.render!(undefined, head, 0)).toBe('поставка');
    expect(out[0]!.onCell!(head, 0)).toEqual({ colSpan: 3 });
    expect(out[1]!.onCell!(head, 0)).toEqual({ colSpan: 0 });
  });
});
