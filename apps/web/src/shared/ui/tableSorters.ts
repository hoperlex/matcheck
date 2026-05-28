// Хелперы для antd Table.columns[].sorter. Все возвращают компаратор,
// который ставит null/undefined в КОНЕЦ независимо от направления — это
// удобнее UX, чем «пустые в начале при ASC, в конце при DESC».
//
// Использование: `sorter: stringSorter<Row>((r) => r.supplierName)`.

type Getter<T, V> = (row: T) => V | null | undefined;

function nullLast<T>(
  a: T,
  b: T,
  aNull: boolean,
  bNull: boolean,
  cmp: (a: T, b: T) => number,
): number {
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  return cmp(a, b);
}

/**
 * Сортировка по строке. Регистронезависимая, с учётом локали (ru).
 */
export function stringSorter<T>(get: Getter<T, string>) {
  const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });
  return (a: T, b: T): number => {
    const av = get(a);
    const bv = get(b);
    return nullLast(
      av,
      bv,
      av == null || av === '',
      bv == null || bv === '',
      (x, y) => collator.compare(String(x), String(y)),
    );
  };
}

/**
 * Сортировка по числу. Принимает Getter, возвращающий number, string или null.
 * Строки парсятся через Number; нечисловое (NaN) трактуется как null.
 */
export function numberSorter<T>(get: Getter<T, number | string>) {
  return (a: T, b: T): number => {
    const ra = get(a);
    const rb = get(b);
    const an = ra == null || ra === '' ? NaN : Number(ra);
    const bn = rb == null || rb === '' ? NaN : Number(rb);
    return nullLast(
      an,
      bn,
      !Number.isFinite(an),
      !Number.isFinite(bn),
      (x, y) => x - y,
    );
  };
}

/**
 * Сортировка по ISO-дате (или Date). null/невалидное — в конец.
 */
export function dateSorter<T>(get: Getter<T, string | Date>) {
  return (a: T, b: T): number => {
    const ra = get(a);
    const rb = get(b);
    const at = ra ? new Date(ra).getTime() : NaN;
    const bt = rb ? new Date(rb).getTime() : NaN;
    return nullLast(
      at,
      bt,
      !Number.isFinite(at),
      !Number.isFinite(bt),
      (x, y) => x - y,
    );
  };
}
