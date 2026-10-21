import type { ColumnType } from 'antd/es/table';
import { antdColumnFilter, dateRangeKey } from './ColumnFilterWindow';

/**
 * Фильтр колонки по диапазону дат для таблиц с СЕРВЕРНОЙ выборкой: сравнивать
 * строки на клиенте здесь нельзя — на экране лишь текущая страница. Значение
 * приходит из адреса, применение уходит в запрос через Table.onChange ключом
 * `from|to` (разбирает `parseDateRangeKey`).
 *
 * Окно — общее окно фильтра в стиле FOT (поля «С» / «По», «Сбросить» и
 * «Применить»), см. ColumnFilterWindow.
 */
export function serverDateRangeColumnFilter<T>(
  current: { from?: string | null; to?: string | null },
  title = 'Период',
): Pick<ColumnType<T>, 'filterDropdown' | 'filterIcon' | 'filterDropdownProps' | 'filteredValue'> {
  const key = dateRangeKey({ from: current.from ?? null, to: current.to ?? null });
  return {
    ...antdColumnFilter<T>({ kind: 'dates', title }),
    filteredValue: key ? [key] : null,
  };
}

/** Разбирает ключ фильтра `from|to` обратно в пару дат. */
export function parseDateRangeKey(value: React.Key | null | undefined): {
  from: string | null;
  to: string | null;
} {
  if (typeof value !== 'string' || !value) return { from: null, to: null };
  const [from, to] = value.split('|');
  return { from: from || null, to: to || null };
}
