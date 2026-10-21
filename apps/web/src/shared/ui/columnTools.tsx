/**
 * Сортировка и фильтр по значениям у каждой колонки клиентской таблицы — как
 * в таблицах FOT («Управление кадрами»): стрелка в заголовке и воронка с
 * окном «поиск / галочки со счётчиками / Сбросить / Применить».
 *
 * Только для таблиц, где на клиенте ВЕСЬ список. Сортировать и фильтровать
 * срез (страницу сервера или первые N по limit) значит молча врать —
 * полноту утверждает страница (ResponsiveTable `autoColumnTools`).
 *
 * Значения берутся из того, что видно в ячейке: строка, которую отдаёт
 * `render`, или сырое значение колонки без `render`. Колонке, чей `render`
 * рисует JSX (тег, ссылку, «—» серым), нужен явный `tools.text` — иначе
 * инструментов у неё нет: фильтр по служебному коду (`manager` вместо
 * «Менеджер») был бы хуже, чем никакого.
 */
import { useCallback, useMemo, useState } from 'react';
import type { TableProps } from 'antd';
import type { FilterValue, SortOrder } from 'antd/es/table/interface';
import dayjs from 'dayjs';
import { antdColumnFilter, type FilterOption } from './ColumnFilterWindow';
import { emptyLast } from './tableSorters';

type Column<T> = NonNullable<TableProps<T>['columns']>[number];

export type ColumnTools<T> = {
  /** Что видно в ячейке. Массив — несколько значений (альтернативные названия); пусто — «(пусто)». */
  text?: (row: T) => string | readonly string[] | null | undefined;
  /** Значение для сортировки, если оно не совпадает с текстом (число, возраст в днях). */
  sortValue?: (row: T) => string | number | null | undefined;
  /** Дата строки (ISO) — колонка получает окно «С / По» вместо списка значений. */
  date?: (row: T) => string | null | undefined;
  /** false — без стрелки. */
  sort?: boolean;
  /** false — без воронки. */
  filter?: boolean;
  /** Заголовок окна фильтра, если title колонки — не строка. */
  label?: string;
};

/** Колонка antd с необязательным описанием инструментов; `false` — колонке их не давать. */
export type ToolColumn<T> = Column<T> & { tools?: ColumnTools<T> | false };

/** Значение фильтра «(пусто)»: ячейка без значения. */
export const EMPTY_VALUE = '__empty__';
const EMPTY_LABEL = '(пусто)';

/** Служебные колонки: номер строки и действия. */
const SERVICE_KEYS = new Set(['__num__', 'actions', 'a']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
/** Число строкой — так API отдаёт количества и деньги («12.000», «1234.56»). */
const NUMERIC_STRING = /^-?\d+(?:\.\d+)?$/;
/** То, что в ячейке рисуется как «нет значения». */
const EMPTY_TEXTS = new Set(['', '—', '-', '–']);

const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });

type Filters = Record<string, FilterValue | null>;

function dataIndexOf<T>(col: Column<T>): string | readonly (string | number)[] | undefined {
  const di = (col as { dataIndex?: unknown }).dataIndex;
  if (typeof di === 'string' || typeof di === 'number') return String(di);
  if (Array.isArray(di)) return di as (string | number)[];
  return undefined;
}

function rawValue<T>(col: Column<T>, row: T): unknown {
  const di = dataIndexOf(col);
  if (di === undefined) return undefined;
  const path = typeof di === 'string' ? [di] : di;
  let v: unknown = row;
  for (const p of path) {
    if (v == null || typeof v !== 'object') return undefined;
    v = (v as Record<string | number, unknown>)[p];
  }
  return v;
}

/** Ключ колонки так же, как его считает antd (getColumnKey): key, иначе dataIndex. */
function columnKeyOf<T>(col: Column<T>, index: number): string {
  if (col.key != null) return String(col.key);
  const di = dataIndexOf(col);
  if (di !== undefined) return typeof di === 'string' ? di : di.join('.');
  return `__col_${index}`;
}

function normalizeTexts(v: unknown): string[] | null {
  if (v == null) return [];
  if (typeof v === 'boolean') return [v ? 'Да' : 'Нет'];
  if (typeof v === 'string' || typeof v === 'number') {
    const s = String(v).trim();
    return EMPTY_TEXTS.has(s) ? [] : [s];
  }
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const x of v) {
      const t = normalizeTexts(x);
      if (t === null) return null;
      out.push(...t);
    }
    return [...new Set(out)];
  }
  return null;
}

/**
 * Тексты ячейки так, как их видит пользователь. null — вывести нельзя
 * (render рисует JSX, а `tools.text` не задан).
 */
export function cellTexts<T>(col: ToolColumn<T>, row: T, index: number): string[] | null {
  const tools = col.tools || undefined;
  if (tools?.text) return normalizeTexts(tools.text(row)) ?? [];
  const raw = rawValue(col, row);
  if (col.render) {
    const out = col.render(raw, row, index) as unknown;
    // false из render — это `условие && <…>`: ячейка пустая, а не «Нет».
    if (out == null || out === false) return [];
    if (typeof out === 'string' || typeof out === 'number') return normalizeTexts(out);
    return null;
  }
  return normalizeTexts(raw);
}

/**
 * Сравнение для сортировки: числа — как числа, строки — по русскому алфавиту
 * с числами внутри («Склад 9» < «Склад 10»); пустые — внизу при любом
 * направлении (antd при DESC переворачивает знак, см. tableSorters).
 */
export function compareCells(a: unknown, b: unknown, order?: SortOrder): number {
  const aEmpty = a == null || a === '';
  const bEmpty = b == null || b === '';
  const empties = emptyLast(aEmpty, bEmpty, order);
  if (empties !== null) return empties;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

/** Варианты фильтра со счётчиками по строкам; «(пусто)» — последним. */
export function valueOptions(texts: readonly (readonly string[])[]): FilterOption[] {
  const counts = new Map<string, number>();
  let empty = 0;
  for (const t of texts) {
    if (t.length === 0) empty += 1;
    for (const v of t) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const options: FilterOption[] = [...counts.entries()]
    .sort(([x], [y]) => collator.compare(x, y))
    .map(([value, count]) => ({ value, label: value, count }));
  if (empty > 0) options.push({ value: EMPTY_VALUE, label: EMPTY_LABEL, count: empty });
  return options;
}

function matchesValues(texts: readonly string[], selected: readonly unknown[]): boolean {
  return selected.some((v) =>
    String(v) === EMPTY_VALUE ? texts.length === 0 : texts.includes(String(v)),
  );
}

function localDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = dayjs(iso);
  return d.isValid() ? d.format('YYYY-MM-DD') : null;
}

function matchesDates(day: string | null, selected: readonly unknown[]): boolean {
  const [from, to] = String(selected[0] ?? '').split('|');
  if (!day) return false;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

type Prepared<T> = {
  key: string;
  col: ToolColumn<T>;
  /** Тексты по строкам items — для вариантов окна и счётчиков. */
  texts: string[][];
  /** Дни строк items (YYYY-MM-DD) для колонки дат, иначе null. */
  days: (string | null)[] | null;
  /**
   * Значения по самой записи. Не по индексу и не по ссылке: antd перед
   * фильтрацией клонирует записи (getFilterData: `Object.assign({}, record)`),
   * и поиск строки по ссылке на клонах промахивался — фильтр отсекал всё.
   */
  textsOf: (row: T) => string[];
  sortKeyOf: (row: T) => string | number | null;
  dayOf: (row: T) => string | null;
  sort: boolean;
  filter: 'values' | 'dates' | null;
};

/** Кэш значения по объекту записи: сортировка зовёт компаратор n·log n раз. */
function memoByRow<T extends object, V>(fn: (row: T) => V): (row: T) => V {
  const cache = new WeakMap<T, V>();
  return (row) => {
    if (cache.has(row)) return cache.get(row) as V;
    const v = fn(row);
    cache.set(row, v);
    return v;
  };
}

function prepare<T extends object>(
  col: ToolColumn<T>,
  index: number,
  items: readonly T[],
): Prepared<T> | null {
  const tools = col.tools;
  if (tools === false) return null;
  const key = columnKeyOf(col, index);
  if (SERVICE_KEYS.has(key)) return null;
  if ('children' in col && col.children) return null;
  const hasTitle = typeof col.title === 'string' ? col.title.trim() !== '' : col.title != null;
  if (!hasTitle && !tools?.label) return null;

  const texts: string[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const t = cellTexts(col, items[i]!, i);
    // Хоть одна ячейка рисует JSX без явного text — значения колонки не вывести.
    if (t === null) return null;
    texts.push(t);
  }

  const raws = items.map((row) => rawValue(col, row));
  const explicitDate = tools?.date;
  const isoColumn =
    !tools?.text &&
    raws.some((v) => typeof v === 'string' && v !== '') &&
    raws.every((v) => v == null || v === '' || (typeof v === 'string' && ISO_DATE.test(v)));
  const isDates = Boolean(explicitDate) || isoColumn;

  const textsOf = memoByRow<T, string[]>((row) => cellTexts(col, row, 0) ?? []);
  const dayOf = memoByRow<T, string | null>((row) =>
    explicitDate
      ? localDay(explicitDate(row))
      : isoColumn
        ? localDay(rawValue(col, row) as string | null)
        : null,
  );
  const sortKeyOf = memoByRow<T, string | number | null>((row) => {
    if (tools?.sortValue) return tools.sortValue(row) ?? null;
    const raw = rawValue(col, row);
    // Числа и ISO-даты сортируем по самому значению, а не по тексту
    // («04.09.2026» по алфавиту встал бы раньше «12.01.2025»).
    if (!tools?.text && typeof raw === 'number') return raw;
    // По отформатированному тексту «12,5» встало бы после «12,25».
    if (!tools?.text && typeof raw === 'string' && NUMERIC_STRING.test(raw)) return Number(raw);
    if (isDates) return dayOf(row);
    const t = textsOf(row);
    return t.length ? t.join(', ') : null;
  });
  const days = isDates ? items.map(dayOf) : null;

  const hasValues = texts.some((t) => t.length > 0);
  const ownFilter = Boolean(col.filters || col.filterDropdown || col.onFilter);
  const filter =
    tools?.filter === false || ownFilter || !hasValues ? null : isDates ? 'dates' : 'values';
  const sort = tools?.sort !== false && !col.sorter;
  return { key, col, texts, days, textsOf, sortKeyOf, dayOf, sort, filter };
}

function stripTools<T>(col: ToolColumn<T>): Column<T> {
  const { tools, ...rest } = col as ToolColumn<T> & { tools?: unknown };
  void tools;
  return rest as Column<T>;
}

function passesFilter<T>(p: Prepared<T>, i: number, filters: Filters): boolean {
  const selected = filters[p.key];
  if (!selected || selected.length === 0 || !p.filter) return true;
  return p.filter === 'dates'
    ? matchesDates(p.days?.[i] ?? null, selected)
    : matchesValues(p.texts[i]!, selected);
}

/** Варианты окна колонки: по строкам, прошедшим фильтры ОСТАЛЬНЫХ колонок (как в FOT). */
function optionsOf<T>(prepared: readonly (Prepared<T> | null)[], p: Prepared<T>, filters: Filters) {
  return valueOptions(
    p.texts.filter((_, i) => prepared.every((o) => !o || o === p || passesFilter(o, i, filters))),
  );
}

/** То же для тестов и отладки: варианты фильтра колонки `key` при текущих фильтрах. */
export function columnFilterOptions<T extends object>(
  columns: readonly ToolColumn<T>[],
  items: readonly T[],
  filters: Filters,
  key: string,
): FilterOption[] {
  const prepared = columns.map((col, i) => prepare(col, i, items));
  const p = prepared.find((o) => o?.key === key);
  return p ? optionsOf(prepared, p, filters) : [];
}

/**
 * Колонки с сортировкой и фильтром. Чистая функция: `filters` — текущее
 * состояние фильтров таблицы (из onChange), по нему считаются счётчики окна —
 * как в FOT, по строкам, прошедшим фильтры ОСТАЛЬНЫХ колонок.
 */
export function buildColumnTools<T extends object>(
  columns: readonly ToolColumn<T>[],
  items: readonly T[],
  filters: Filters,
): Column<T>[] {
  const prepared = columns.map((col, i) => prepare(col, i, items));

  return columns.map((col, ci) => {
    const p = prepared[ci];
    const base = stripTools(col);
    if (!p || (!p.sort && !p.filter)) return base;
    const next: Column<T> = { ...base, key: p.key };

    if (p.sort) {
      next.sorter = (a: T, b: T, order?: SortOrder) =>
        compareCells(p.sortKeyOf(a), p.sortKeyOf(b), order);
    }
    const title =
      (col.tools || undefined)?.label ?? (typeof col.title === 'string' ? col.title : p.key);
    if (p.filter === 'dates') {
      Object.assign(next, antdColumnFilter<T>({ kind: 'dates', title }));
      next.onFilter = (value, row) => matchesDates(p.dayOf(row), [value]);
    } else if (p.filter === 'values') {
      Object.assign(
        next,
        antdColumnFilter<T>({
          kind: 'values',
          title,
          showCounts: true,
          // Считается при открытии окна: строки, прошедшие фильтры остальных колонок.
          options: () => optionsOf(prepared, p, filters),
        }),
      );
      next.onFilter = (value, row) => matchesValues(p.textsOf(row), [value]);
    }
    return next;
  });
}

/**
 * Хук для таблицы: колонки с инструментами + обработчик onChange, который
 * запоминает фильтры для счётчиков окна. При enabled=false колонки
 * возвращаются как есть (без поля tools).
 */
export function useColumnTools<T extends object>({
  columns,
  items,
  enabled,
}: {
  columns: readonly ToolColumn<T>[];
  items: readonly T[];
  enabled: boolean;
}): { columns: Column<T>[]; onChange: NonNullable<TableProps<T>['onChange']> } {
  const [filters, setFilters] = useState<Filters>({});
  const built = useMemo(
    () => (enabled ? buildColumnTools(columns, items, filters) : columns.map(stripTools)),
    [enabled, columns, items, filters],
  );
  const onChange = useCallback<NonNullable<TableProps<T>['onChange']>>((_p, f) => {
    setFilters(f as Filters);
  }, []);
  return { columns: built, onChange };
}
