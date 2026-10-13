/**
 * Окна списка документов Диадока (GetDocuments V3): деление до точного счёта и
 * чтение страниц.
 *
 * Зачем делить. У V3 `HasMoreResults` означает «найдено больше 1000», а не
 * «есть следующая страница», и тогда `TotalCount` равен 1000, а не настоящему
 * числу. Проверить, что окно прочитано целиком, можно только там, где счёт
 * точный. Поэтому окно делится пополам, пока Диадок не ответит
 * `HasMoreResults = false` и `TotalCount < 1000`. Ровно 1000 тоже делится:
 * документация не говорит, точный это счёт или уже потолок.
 *
 * Обе границы `timestampFromTicks`/`timestampToTicks` включительные, поэтому
 * половины — `[a; m]` и `[m + 1 тик; b]`: документ ровно на стыке попадает
 * только в одну из них.
 *
 * Страницы читаются по `afterIndexKey` до пустой страницы. Признак «больше
 * нет» по неполной странице не используется: документация его не обещает.
 */
import { dateToDiadocTicks, diadocTimestampToDate, type DiadocDocumentList, type DiadocListedDocument } from './diadoc.types.js';

/** Предел, после которого счёт Диадока перестаёт быть точным. */
export const LIST_COUNT_CAP = 1000;
/** Наибольшая страница V3. */
export const LIST_PAGE_SIZE = 100;
/** Окно короче секунды дальше не делится: в нём не может быть тысячи документов честно. */
export const MIN_SPLITTABLE_TICKS = 10_000_000n;

/** Отрезок времени в тиках .NET, обе границы включительные. */
export type TickWindow = { from: bigint; to: bigint };

export type ListQuery = {
  filterCategory: string;
  fromTicks: bigint;
  toTicks: bigint;
  afterIndexKey: string | null;
  count: number;
};

/** Один запрос к списку; продление лиза и сигнал — забота вызывающего. */
export type ListFn = (query: ListQuery) => Promise<DiadocDocumentList>;

/** В окне тысяча и больше документов, а делить его уже некуда. */
export class WindowNotSplittable extends Error {
  constructor(readonly window: TickWindow, readonly total: number | null) {
    super(
      `окно ${describeWindow(window)} нельзя разделить: в нём ${total ?? '?'} документов, ` +
        `а Диадок отдаёт точный счёт только до ${LIST_COUNT_CAP}`,
    );
    this.name = 'WindowNotSplittable';
  }
}

/** Список не сдвигается или повторяет документы — читать дальше бессмысленно. */
export class ListNotAdvancing extends Error {
  constructor(detail: string) {
    super(`список Диадока не сдвигается: ${detail}`);
    this.name = 'ListNotAdvancing';
  }
}

/** Диадок не вернул TotalCount — полноту окна проверить нечем. */
export class ListCountMissing extends Error {
  constructor(window: TickWindow) {
    super(`Диадок не вернул TotalCount для окна ${describeWindow(window)}`);
    this.name = 'ListCountMissing';
  }
}

export function dateToTicks(date: Date): bigint {
  return BigInt(dateToDiadocTicks(date));
}

export function ticksToDate(ticks: bigint): Date {
  const date = diadocTimestampToDate(ticks.toString());
  if (!date) throw new Error(`тики ${ticks} не переводятся в дату`);
  return date;
}

export function describeWindow(w: TickWindow): string {
  return `${ticksToDate(w.from).toISOString()} – ${ticksToDate(w.to).toISOString()}`;
}

const moscowParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Moscow',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Смещение московского времени от UTC в момент `at`, мс (UTC+4 в 2011–2014). */
export function moscowOffsetMs(at: Date): number {
  const p = Object.fromEntries(moscowParts.formatToParts(at).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * Полночь по Москве как момент UTC. Переходы времени в Москве никогда не
 * приходились на полночь, поэтому смещение берётся у самой полуночи.
 */
export function moscowMidnight(year: number, month: number, day = 1): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day);
  const guess = new Date(wallAsUtc - 3 * 3600_000);
  const first = wallAsUtc - moscowOffsetMs(guess);
  return new Date(wallAsUtc - moscowOffsetMs(new Date(first)));
}

/** Календарный месяц по Москве: [полночь 1-го; полночь следующего 1-го − 1 тик]. */
export function moscowMonthWindow(year: number, month: number): TickWindow {
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  return {
    from: dateToTicks(moscowMidnight(year, month)),
    to: dateToTicks(moscowMidnight(next.y, next.m)) - 1n,
  };
}

/** Половины без перекрытия: границы у Диадока включительные. */
export function halveWindow(w: TickWindow): [TickWindow, TickWindow] {
  const mid = w.from + (w.to - w.from) / 2n;
  return [
    { from: w.from, to: mid },
    { from: mid + 1n, to: w.to },
  ];
}

export type WindowCount = {
  total: number | null;
  hasMoreResults: boolean;
  /** Счёт можно считать настоящим числом документов окна. */
  exact: boolean;
};

export function isExactCount(list: Pick<DiadocDocumentList, 'TotalCount' | 'HasMoreResults'>): boolean {
  return (
    list.HasMoreResults !== true &&
    typeof list.TotalCount === 'number' &&
    list.TotalCount < LIST_COUNT_CAP
  );
}

/** Счёт окна одним запросом на один документ. */
export async function countWindow(list: ListFn, filterCategory: string, w: TickWindow): Promise<WindowCount> {
  const head = await list({ filterCategory, fromTicks: w.from, toTicks: w.to, afterIndexKey: null, count: 1 });
  return {
    total: typeof head.TotalCount === 'number' ? head.TotalCount : null,
    hasMoreResults: head.HasMoreResults === true,
    exact: isExactCount(head),
  };
}

export type CountedWindow = { window: TickWindow; total: number };

/**
 * Делит окно на части с точным счётом, по порядку времени.
 *
 * `onSplit` сообщает о каждом делении — проба и журнал окон видят, почему
 * месяц превратился в несколько частей.
 */
export async function splitToExactWindows(
  list: ListFn,
  filterCategory: string,
  w: TickWindow,
  opts: { onSplit?: (window: TickWindow, count: WindowCount) => void } = {},
): Promise<CountedWindow[]> {
  const out: CountedWindow[] = [];
  const stack: TickWindow[] = [w];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const count = await countWindow(list, filterCategory, current);
    if (count.total === null) throw new ListCountMissing(current);
    if (count.exact) {
      out.push({ window: current, total: count.total });
      continue;
    }
    if (current.to - current.from < MIN_SPLITTABLE_TICKS) {
      throw new WindowNotSplittable(current, count.total);
    }
    opts.onSplit?.(current, count);
    const [left, right] = halveWindow(current);
    // Правую кладём первой: стек отдаёт левую раньше, и части идут по времени.
    stack.push(right, left);
  }
  return out;
}

export type WindowRead = {
  documents: DiadocListedDocument[];
  pageSizes: number[];
  /** `empty_page` — дочитано до конца; `cap` — остановлено пределом вызывающего. */
  stopped: 'empty_page' | 'cap';
};

const docKey = (d: Pick<DiadocListedDocument, 'MessageId' | 'EntityId'>) => `${d.MessageId}\u0000${d.EntityId}`;

/**
 * Читает все страницы окна по `afterIndexKey` до пустой страницы.
 *
 * Защита от хождения по кругу: ключ последнего документа совпал с переданным,
 * ключ страницы уже встречался или документ повторился — это стоп, а не
 * «прочитано».
 */
export async function readWindowPages(
  list: ListFn,
  filterCategory: string,
  w: TickWindow,
  opts: { maxDocuments?: number; onPage?: (size: number, read: number) => void } = {},
): Promise<WindowRead> {
  const documents: DiadocListedDocument[] = [];
  const pageSizes: number[] = [];
  const seenDocs = new Set<string>();
  const seenIndexKeys = new Set<string>();
  let after: string | null = null;

  for (;;) {
    const page = await list({
      filterCategory,
      fromTicks: w.from,
      toTicks: w.to,
      afterIndexKey: after,
      count: LIST_PAGE_SIZE,
    });
    const docs = page.Documents;
    if (docs.length === 0) return { documents, pageSizes, stopped: 'empty_page' };

    for (const doc of docs) {
      const key = docKey(doc);
      if (seenDocs.has(key)) {
        throw new ListNotAdvancing(`документ ${doc.MessageId}/${doc.EntityId} пришёл повторно`);
      }
      seenDocs.add(key);
      documents.push(doc);
    }
    pageSizes.push(docs.length);
    opts.onPage?.(docs.length, documents.length);

    const last = docs[docs.length - 1]!.IndexKey;
    if (!last) throw new ListNotAdvancing('у последнего документа страницы нет IndexKey');
    if (last === after || seenIndexKeys.has(last)) {
      throw new ListNotAdvancing(`ключ страницы ${last} уже был`);
    }
    seenIndexKeys.add(last);
    after = last;

    if (opts.maxDocuments !== undefined && documents.length >= opts.maxDocuments) {
      return { documents, pageSizes, stopped: 'cap' };
    }
  }
}
