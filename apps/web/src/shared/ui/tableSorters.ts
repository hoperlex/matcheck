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
 * Сортировка по фиксированному порядку категорий — для колонок типа
 * «Тип» (УПД/Заявка/Накладная) или «Статус», где алфавит на сыром
 * значении даёт мусор. Значения вне списка `order` уходят в конец.
 *
 * Пример:
 *   sorter: prioritySorter<Row>((r) => r.kind, ['upd', 'request', 'transport_waybill', 'os2_transfer'])
 */
export function prioritySorter<T, V extends string>(
  get: Getter<T, V>,
  order: readonly V[],
) {
  const index = new Map<V, number>();
  order.forEach((v, i) => index.set(v, i));
  const unknownRank = order.length;
  return (a: T, b: T): number => {
    const av = get(a);
    const bv = get(b);
    const ai = av == null ? unknownRank + 1 : index.get(av as V) ?? unknownRank;
    const bi = bv == null ? unknownRank + 1 : index.get(bv as V) ?? unknownRank;
    return ai - bi;
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
