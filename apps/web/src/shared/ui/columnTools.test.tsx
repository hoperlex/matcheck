/**
 * Сортировка и фильтр по значениям для клиентских таблиц (columnTools).
 *
 * Держим главное правило: значения берутся из того, что видно в ячейке, а не
 * из служебного поля. Колонка, чей render рисует JSX без явного tools.text,
 * инструментов не получает — фильтр по коду `manager` вместо «Менеджер» хуже,
 * чем никакого.
 */
import type { SortOrder } from 'antd/es/table/interface';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_VALUE,
  buildColumnTools,
  cellTexts,
  columnFilterOptions,
  compareCells,
  valueOptions,
  type ToolColumn,
} from './columnTools';

type Row = {
  id: string;
  name: string | null;
  city: string | null;
  role: 'manager' | 'admin';
  qty: number | null;
  active: boolean;
  aliases: string[];
  createdAt: string | null;
};

const ROWS: Row[] = [
  {
    id: '1',
    name: 'Склад 10',
    city: 'Москва',
    role: 'manager',
    qty: 5,
    active: true,
    aliases: ['А', 'Б'],
    createdAt: '2026-10-01T10:00:00',
  },
  {
    id: '2',
    name: 'Склад 9',
    city: 'Москва',
    role: 'admin',
    qty: null,
    active: false,
    aliases: [],
    createdAt: '2026-09-15T08:00:00',
  },
  {
    id: '3',
    name: null,
    city: 'Казань',
    role: 'manager',
    qty: 12,
    active: true,
    aliases: ['Б'],
    createdAt: null,
  },
  {
    id: '4',
    name: 'альфа',
    city: null,
    role: 'manager',
    qty: 1,
    active: true,
    aliases: ['В'],
    createdAt: '2026-10-20T23:00:00',
  },
];

const ROLE_LABEL = { manager: 'Менеджер', admin: 'Администратор' } as const;

const COLUMNS: ToolColumn<Row>[] = [
  { title: '№', key: '__num__', render: (_v, _r, i) => i + 1 },
  { title: 'Название', dataIndex: 'name' },
  { title: 'Город', dataIndex: 'city', render: (v: string | null) => v ?? '—' },
  // JSX без tools.text — инструментов нет.
  { title: 'Роль', dataIndex: 'role', render: (v: Row['role']) => <b>{ROLE_LABEL[v]}</b> },
  { title: 'Кол-во', dataIndex: 'qty' },
  { title: 'Активен', dataIndex: 'active' },
  { title: 'Алиасы', key: 'aliases', render: () => <i />, tools: { text: (r) => r.aliases } },
  { title: 'Создан', dataIndex: 'createdAt' },
  { title: '', key: 'actions', render: () => <button type="button" /> },
];

type Col = ReturnType<typeof buildColumnTools<Row>>[number] & {
  sorter?: (a: Row, b: Row, o?: SortOrder) => number;
  onFilter?: (v: unknown, r: Row) => boolean;
  filterDropdown?: unknown;
};

function build(filters: Record<string, string[] | null> = {}): Col[] {
  return buildColumnTools(COLUMNS, ROWS, filters) as Col[];
}
const byTitle = (cols: Col[], title: string) => cols.find((c) => c.title === title)!;

/** Как antd применяет компаратор: при descend знак переворачивается. */
function sortRows(col: Col, order: 'ascend' | 'descend'): string[] {
  return ROWS.slice()
    .sort((a, b) => {
      const r = col.sorter!(a, b, order);
      return order === 'ascend' ? r : -r;
    })
    .map((r) => r.id);
}

describe('cellTexts: то, что видно в ячейке', () => {
  it('строка из render, «—» считается пустым, JSX без text — не выводится', () => {
    expect(cellTexts(COLUMNS[2]!, ROWS[0]!, 0)).toEqual(['Москва']);
    expect(cellTexts(COLUMNS[2]!, ROWS[3]!, 3)).toEqual([]);
    expect(cellTexts(COLUMNS[3]!, ROWS[0]!, 0)).toBeNull();
  });

  it('boolean — «Да / Нет», массив из tools.text — несколько значений', () => {
    expect(cellTexts(COLUMNS[5]!, ROWS[1]!, 1)).toEqual(['Нет']);
    expect(cellTexts(COLUMNS[6]!, ROWS[0]!, 0)).toEqual(['А', 'Б']);
  });
});

describe('buildColumnTools: какие колонки получают инструменты', () => {
  it('служебные и JSX-колонки без text — без стрелки и воронки', () => {
    const cols = build();
    for (const title of ['№', 'Роль', '']) {
      const c = byTitle(cols, title);
      expect(c.sorter, title).toBeUndefined();
      expect(c.filterDropdown, title).toBeUndefined();
    }
    for (const title of ['Название', 'Город', 'Кол-во', 'Активен', 'Алиасы', 'Создан']) {
      expect(byTitle(cols, title).sorter, title).toBeTypeOf('function');
      expect(byTitle(cols, title).filterDropdown, title).toBeTypeOf('function');
    }
  });

  it('поле tools не уходит в antd, свой sorter колонки не перетирается', () => {
    const own = (a: Row, b: Row) => a.id.localeCompare(b.id);
    const cols = buildColumnTools<Row>(
      [{ title: 'Название', dataIndex: 'name', sorter: own }],
      ROWS,
      {},
    );
    expect(cols[0]).not.toHaveProperty('tools');
    expect((cols[0] as Col).sorter).toBe(own);
  });

  it('tools: false — колонка как есть', () => {
    const cols = buildColumnTools<Row>(
      [{ title: 'Название', dataIndex: 'name', tools: false }],
      ROWS,
      {},
    );
    expect((cols[0] as Col).sorter).toBeUndefined();
    expect(cols[0]).not.toHaveProperty('tools');
  });
});

describe('сортировка', () => {
  it('строки — по алфавиту с числами внутри, пустые внизу в обе стороны', () => {
    const c = byTitle(build(), 'Название');
    expect(sortRows(c, 'ascend')).toEqual(['4', '2', '1', '3']);
    expect(sortRows(c, 'descend')).toEqual(['1', '2', '4', '3']);
  });

  it('числа — по значению, а не по тексту', () => {
    const c = byTitle(build(), 'Кол-во');
    expect(sortRows(c, 'ascend')).toEqual(['4', '1', '3', '2']);
    expect(sortRows(c, 'descend')).toEqual(['3', '1', '4', '2']);
  });

  it('числа строкой (так API отдаёт количества и деньги) — по значению', () => {
    type Item = { id: string; qty: string | null };
    const items: Item[] = [
      { id: 'a', qty: '12.25' },
      { id: 'b', qty: '12.5' },
      { id: 'c', qty: '3' },
      { id: 'd', qty: null },
    ];
    const [qty] = buildColumnTools<Item>(
      [
        {
          title: 'Кол-во',
          dataIndex: 'qty',
          render: (v: string | null) => (v ?? '—').replace('.', ','),
        },
      ],
      items,
      {},
    ) as unknown as Col[];
    const sorted = items
      .slice()
      .sort((a, b) =>
        (qty as unknown as { sorter: (x: Item, y: Item, o: SortOrder) => number }).sorter(
          a,
          b,
          'ascend',
        ),
      )
      .map((r) => r.id);
    expect(sorted).toEqual(['c', 'a', 'b', 'd']);
  });

  it('ISO-даты — по дате', () => {
    const c = byTitle(build(), 'Создан');
    expect(sortRows(c, 'ascend')).toEqual(['2', '1', '4', '3']);
  });

  it('compareCells: пустое внизу при любом направлении', () => {
    expect(compareCells(null, 'а', 'ascend')).toBeGreaterThan(0);
    expect(-compareCells(null, 'а', 'descend')).toBeGreaterThan(0);
  });
});

describe('фильтр по значениям', () => {
  it('варианты со счётчиками, «(пусто)» последним', () => {
    expect(valueOptions([['Москва'], ['Москва'], ['Казань'], []])).toEqual([
      { value: 'Казань', label: 'Казань', count: 1 },
      { value: 'Москва', label: 'Москва', count: 2 },
      { value: EMPTY_VALUE, label: '(пусто)', count: 1 },
    ]);
  });

  it('счётчики учитывают фильтры ОСТАЛЬНЫХ колонок, но не своей', () => {
    const filters = { city: ['Москва'] };
    // «Алиасы» по строкам 1 и 2 (Москва): А, Б и одна пустая.
    expect(columnFilterOptions(COLUMNS, ROWS, filters, 'aliases')).toEqual([
      { value: 'А', label: 'А', count: 1 },
      { value: 'Б', label: 'Б', count: 1 },
      { value: EMPTY_VALUE, label: '(пусто)', count: 1 },
    ]);
    // Своя колонка показывает все города — иначе выбранное нельзя расширить.
    expect(columnFilterOptions(COLUMNS, ROWS, filters, 'city').map((o) => o.value)).toEqual([
      'Казань',
      'Москва',
      EMPTY_VALUE,
    ]);
  });

  it('onFilter: значение, «(пусто)» и многозначная ячейка', () => {
    const cols = build();
    const city = byTitle(cols, 'Город');
    expect(ROWS.filter((r) => city.onFilter!('Москва', r)).map((r) => r.id)).toEqual(['1', '2']);
    expect(ROWS.filter((r) => city.onFilter!(EMPTY_VALUE, r)).map((r) => r.id)).toEqual(['4']);
    const aliases = byTitle(cols, 'Алиасы');
    expect(ROWS.filter((r) => aliases.onFilter!('Б', r)).map((r) => r.id)).toEqual(['1', '3']);
  });

  it('работает на клонах записей — antd клонирует их перед фильтрацией', () => {
    // getFilterData: `currentData.map(record => Object.assign({}, record))`.
    // Поиск строки по ссылке на объект на клонах промахивался, и фильтр
    // отсекал всё; сортировка при включённом фильтре ломалась так же.
    const cols = build();
    const clones = ROWS.map((r) => ({ ...r }));
    const city = byTitle(cols, 'Город');
    expect(clones.filter((r) => city.onFilter!('Москва', r)).map((r) => r.id)).toEqual(['1', '2']);
    const qty = byTitle(cols, 'Кол-во');
    const sorted = clones
      .slice()
      .sort((a, b) => qty.sorter!(a, b, 'ascend'))
      .map((r) => r.id);
    expect(sorted).toEqual(['4', '1', '3', '2']);
  });

  it('колонка ISO-дат фильтруется диапазоном «С / По» по местному дню', () => {
    const created = byTitle(build(), 'Создан');
    const hit = ROWS.filter((r) => created.onFilter!('2026-10-01|2026-10-20', r)).map((r) => r.id);
    expect(hit).toEqual(['1', '4']);
    expect(ROWS.filter((r) => created.onFilter!('|2026-09-30', r)).map((r) => r.id)).toEqual(['2']);
  });
});
