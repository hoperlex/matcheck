// Хелперы для antd Table.columns[].sorter. Все возвращают компаратор,
// который ставит null/undefined в КОНЕЦ независимо от направления — это
// удобнее UX, чем «пустые в начале при ASC, в конце при DESC».
//
// antd при DESC сам инвертирует результат компаратора, поэтому «в конец в
// обе стороны» держится только через третий аргумент — направление, которое
// antd передаёт в компаратор: для пустых знак заранее переворачиваем.
//
// Использование: `sorter: stringSorter<Row>((r) => r.supplierName)`.

import type { SortOrder } from 'antd/es/table/interface';

type Getter<T, V> = (row: T) => V | null | undefined;

/** Пустое значение уходит вниз при любом направлении сортировки. */
export function emptyLast(aEmpty: boolean, bEmpty: boolean, order?: SortOrder): number | null {
  if (aEmpty && bEmpty) return 0;
  if (!aEmpty && !bEmpty) return null;
  // antd при DESC перевернёт знак — переворачиваем заранее.
  const down = order === 'descend' ? -1 : 1;
  return aEmpty ? down : -down;
}

function nullLast<T>(
  a: T,
  b: T,
  aNull: boolean,
  bNull: boolean,
  cmp: (a: T, b: T) => number,
  order?: SortOrder,
): number {
  return emptyLast(aNull, bNull, order) ?? cmp(a, b);
}

/**
 * Сортировка по строке. Регистронезависимая, с учётом локали (ru).
 */
export function stringSorter<T>(get: Getter<T, string>) {
  const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });
  return (a: T, b: T, order?: SortOrder): number => {
    const av = get(a);
    const bv = get(b);
    return nullLast(
      av,
      bv,
      av == null || av === '',
      bv == null || bv === '',
      (x, y) => collator.compare(String(x), String(y)),
      order,
    );
  };
}

/**
 * Сортировка по числу. Принимает Getter, возвращающий number, string или null.
 * Строки парсятся через Number; нечисловое (NaN) трактуется как null.
 */
export function numberSorter<T>(get: Getter<T, number | string>) {
  return (a: T, b: T, order?: SortOrder): number => {
    const ra = get(a);
    const rb = get(b);
    const an = ra == null || ra === '' ? NaN : Number(ra);
    const bn = rb == null || rb === '' ? NaN : Number(rb);
    return nullLast(an, bn, !Number.isFinite(an), !Number.isFinite(bn), (x, y) => x - y, order);
  };
}

/**
 * Сортировка по фиксированному порядку категорий — для колонок типа
 * «Тип» (УПД/Заявка/Накладная) или «Статус», где алфавит на сыром
 * значении даёт мусор. Значения вне списка `order` и пустые уходят в конец
 * при любом направлении.
 *
 * Пример:
 *   sorter: prioritySorter<Row>((r) => r.kind, ['upd', 'request', 'transport_waybill', 'os2_transfer'])
 */
export function prioritySorter<T, V extends string>(get: Getter<T, V>, order: readonly V[]) {
  const index = new Map<V, number>();
  order.forEach((v, i) => index.set(v, i));
  return (a: T, b: T, sortOrder?: SortOrder): number => {
    const av = get(a);
    const bv = get(b);
    const ai = av == null ? undefined : index.get(av as V);
    const bi = bv == null ? undefined : index.get(bv as V);
    return emptyLast(ai === undefined, bi === undefined, sortOrder) ?? ai! - bi!;
  };
}

/**
 * Сортировка по ISO-дате (или Date). null/невалидное — в конец.
 */
export function dateSorter<T>(get: Getter<T, string | Date>) {
  return (a: T, b: T, order?: SortOrder): number => {
    const ra = get(a);
    const rb = get(b);
    const at = ra ? new Date(ra).getTime() : NaN;
    const bt = rb ? new Date(rb).getTime() : NaN;
    return nullLast(at, bt, !Number.isFinite(at), !Number.isFinite(bt), (x, y) => x - y, order);
  };
}
