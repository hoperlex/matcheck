/**
 * Окна списка документов Диадока (GetDocuments V3).
 *
 * Фейковый список повторяет то, что обещает документация DocumentList:
 * - больше 1000 найденных → TotalCount = 1000 и HasMoreResults = true;
 * - обе границы по времени включительные;
 * - страница до 100 документов, продолжение по IndexKey последнего.
 *
 * Отдельный вариант списка не отдаёт ничего дальше 1000-го документа: читается
 * ли V3 за пределом тысячи, документация не говорит, и деление окна обязано
 * работать при любом ответе на этот вопрос.
 */
import { describe, expect, it } from 'vitest';
import type { DiadocDocumentList, DiadocListedDocument } from '../src/domain/edo/diadoc.types.js';
import {
  LIST_COUNT_CAP,
  ListCountMissing,
  ListNotAdvancing,
  MIN_SPLITTABLE_TICKS,
  WindowNotSplittable,
  countWindow,
  dateToTicks,
  halveWindow,
  moscowMonthWindow,
  readWindowPages,
  splitToExactWindows,
  ticksToDate,
  type ListFn,
  type ListQuery,
  type TickWindow,
} from '../src/domain/edo/list-windows.js';

type FakeDoc = { id: number; ticks: bigint };

const BASE = dateToTicks(new Date('2026-09-01T00:00:00Z'));
const SECOND = 10_000_000n;
const DAY = 86_400n * SECOND;

function doc(d: FakeDoc): DiadocListedDocument {
  return { MessageId: `m-${d.id}`, EntityId: `e-${d.id}`, IndexKey: `k-${d.id}` } as DiadocListedDocument;
}

/** Документы, равномерно разложенные по дням от BASE. */
function spread(n: number, days = 30): FakeDoc[] {
  const span = BigInt(days) * DAY;
  return Array.from({ length: n }, (_, i) => ({ id: i, ticks: BASE + (span * BigInt(i)) / BigInt(n) }));
}

function fakeList(docs: FakeDoc[], opts: { readableCap?: number; omitTotal?: boolean } = {}) {
  const sorted = [...docs].sort((a, b) => (a.ticks < b.ticks ? -1 : a.ticks > b.ticks ? 1 : a.id - b.id));
  const calls: ListQuery[] = [];
  const list: ListFn = async (q) => {
    calls.push(q);
    const found = sorted.filter((d) => d.ticks >= q.fromTicks && d.ticks <= q.toTicks);
    const readable = opts.readableCap === undefined ? found : found.slice(0, opts.readableCap);
    const start = q.afterIndexKey ? readable.findIndex((d) => `k-${d.id}` === q.afterIndexKey) + 1 : 0;
    const page = readable.slice(start, start + q.count);
    const result: DiadocDocumentList = {
      Documents: page.map(doc),
      HasMoreResults: found.length > LIST_COUNT_CAP,
      ...(opts.omitTotal ? {} : { TotalCount: Math.min(found.length, LIST_COUNT_CAP) }),
    };
    return result;
  };
  return { list, calls };
}

const MONTH: TickWindow = { from: BASE, to: BASE + 30n * DAY - 1n };

async function readAll(list: ListFn, w: TickWindow) {
  const parts = await splitToExactWindows(list, 'UniversalTransferDocument.Inbound', w);
  const ids: string[] = [];
  for (const part of parts) {
    const read = await readWindowPages(list, 'UniversalTransferDocument.Inbound', part.window);
    expect(read.documents).toHaveLength(part.total);
    ids.push(...read.documents.map((d) => d.MessageId));
  }
  return { parts, ids };
}

describe('деление окна до точного счёта', () => {
  it.each([101, 250])('окно на %i документов не делится и читается целиком', async (n) => {
    const { list } = fakeList(spread(n));
    const { parts, ids } = await readAll(list, MONTH);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.total).toBe(n);
    expect(new Set(ids).size).toBe(n);
  });

  it('ровно 1000 тоже делится: документация не говорит, точный ли это счёт', async () => {
    const { list } = fakeList(spread(1000));
    const { parts, ids } = await readAll(list, MONTH);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.total < LIST_COUNT_CAP)).toBe(true);
    expect(new Set(ids).size).toBe(1000);
  });

  it('больше 1000: части с точным счётом, все документы ровно по разу', async () => {
    const { list } = fakeList(spread(2600));
    const { parts, ids } = await readAll(list, MONTH);
    expect(parts.reduce((s, p) => s + p.total, 0)).toBe(2600);
    expect(ids).toHaveLength(2600);
    expect(new Set(ids).size).toBe(2600);
  });

  it('то же, если Диадок не отдаёт ничего дальше тысячного документа', async () => {
    const { list } = fakeList(spread(2600), { readableCap: LIST_COUNT_CAP });
    const { ids } = await readAll(list, MONTH);
    expect(new Set(ids).size).toBe(2600);
  });

  it('части идут по времени и стыкуются без зазоров и перекрытий', async () => {
    const { list } = fakeList(spread(2600));
    const parts = await splitToExactWindows(list, 'X.Inbound', MONTH);
    expect(parts[0]!.window.from).toBe(MONTH.from);
    expect(parts[parts.length - 1]!.window.to).toBe(MONTH.to);
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i]!.window.from).toBe(parts[i - 1]!.window.to + 1n);
    }
  });

  it('документ ровно на стыке половин попадает только в одну', async () => {
    const [left] = halveWindow(MONTH);
    const docs = [...spread(1200), { id: 5000, ticks: left.to }, { id: 5001, ticks: left.to + 1n }];
    const { list } = fakeList(docs);
    const { ids } = await readAll(list, MONTH);
    expect(ids.filter((id) => id === 'm-5000')).toHaveLength(1);
    expect(ids.filter((id) => id === 'm-5001')).toHaveLength(1);
    expect(ids).toHaveLength(1202);
  });

  it('окно короче секунды с тысячей документов — ошибка, а не «прочитано»', async () => {
    const same = Array.from({ length: 1200 }, (_, i) => ({ id: i, ticks: BASE + 5n }));
    const { list } = fakeList(same);
    await expect(splitToExactWindows(list, 'X.Inbound', MONTH)).rejects.toBeInstanceOf(WindowNotSplittable);
  });

  it('нет TotalCount — полноту проверить нечем', async () => {
    const { list } = fakeList(spread(10), { omitTotal: true });
    await expect(splitToExactWindows(list, 'X.Inbound', MONTH)).rejects.toBeInstanceOf(ListCountMissing);
  });

  it('счёт спрашивается одним документом, фильтры окна передаются как есть', async () => {
    const { list, calls } = fakeList(spread(5));
    const count = await countWindow(list, 'UniversalTransferDocument.Inbound', MONTH);
    expect(count).toEqual({ total: 5, hasMoreResults: false, exact: true });
    expect(calls[0]).toEqual({
      filterCategory: 'UniversalTransferDocument.Inbound',
      fromTicks: MONTH.from,
      toTicks: MONTH.to,
      afterIndexKey: null,
      count: 1,
    });
  });
});

describe('чтение страниц', () => {
  it('читает до пустой страницы, а не до неполной', async () => {
    const { list, calls } = fakeList(spread(200));
    const read = await readWindowPages(list, 'X.Inbound', MONTH);
    expect(read.stopped).toBe('empty_page');
    expect(read.pageSizes).toEqual([100, 100]);
    // Третий запрос — проверка, что дальше пусто.
    expect(calls).toHaveLength(3);
    expect(calls[1]!.afterIndexKey).toBe('k-99');
    expect(calls.every((c) => c.fromTicks === MONTH.from && c.toTicks === MONTH.to)).toBe(true);
  });

  it('предел вызывающего останавливает чтение с пометкой cap', async () => {
    const { list } = fakeList(spread(500));
    const read = await readWindowPages(list, 'X.Inbound', MONTH, { maxDocuments: 250 });
    expect(read.stopped).toBe('cap');
    expect(read.documents).toHaveLength(300);
  });

  it('список, вернувший ту же страницу, останавливается ошибкой', async () => {
    const page: DiadocDocumentList = { Documents: [doc({ id: 1, ticks: BASE })], TotalCount: 1 };
    const list: ListFn = async () => page;
    await expect(readWindowPages(list, 'X.Inbound', MONTH)).rejects.toBeInstanceOf(ListNotAdvancing);
  });

  it('документ, пришедший повторно на другой странице, — ошибка', async () => {
    let n = 0;
    const list: ListFn = async () => {
      n += 1;
      const docs = n === 1 ? [doc({ id: 1, ticks: BASE }), doc({ id: 2, ticks: BASE })] : [{ ...doc({ id: 1, ticks: BASE }), IndexKey: 'k-x' }];
      return { Documents: docs as DiadocListedDocument[], TotalCount: 2 };
    };
    await expect(readWindowPages(list, 'X.Inbound', MONTH)).rejects.toThrow(/повторно/);
  });

  it('страница без ключа у последнего документа — ошибка, продолжать не с чего', async () => {
    const list: ListFn = async () => ({
      Documents: [{ MessageId: 'm', EntityId: 'e' } as DiadocListedDocument],
      TotalCount: 1,
    });
    await expect(readWindowPages(list, 'X.Inbound', MONTH)).rejects.toThrow(/IndexKey/);
  });
});

describe('месяц по Москве', () => {
  it('сентябрь 2026: UTC+3', () => {
    const w = moscowMonthWindow(2026, 9);
    expect(ticksToDate(w.from).toISOString()).toBe('2026-08-31T21:00:00.000Z');
    expect(w.to + 1n).toBe(dateToTicks(new Date('2026-09-30T21:00:00.000Z')));
  });

  it('март 2011: начало по UTC+3, конец уже по UTC+4', () => {
    const w = moscowMonthWindow(2011, 3);
    expect(ticksToDate(w.from).toISOString()).toBe('2011-02-28T21:00:00.000Z');
    expect(w.to + 1n).toBe(dateToTicks(new Date('2011-03-31T20:00:00.000Z')));
  });

  it('октябрь 2014: начало по UTC+4, конец снова по UTC+3', () => {
    const w = moscowMonthWindow(2014, 10);
    expect(ticksToDate(w.from).toISOString()).toBe('2014-09-30T20:00:00.000Z');
    expect(w.to + 1n).toBe(dateToTicks(new Date('2014-10-31T21:00:00.000Z')));
  });

  it('декабрь переходит в январь следующего года', () => {
    const w = moscowMonthWindow(2025, 12);
    expect(w.to + 1n).toBe(dateToTicks(new Date('2025-12-31T21:00:00.000Z')));
  });
});

describe('половины окна', () => {
  it('покрывают окно без перекрытия', () => {
    const [a, b] = halveWindow(MONTH);
    expect(a.from).toBe(MONTH.from);
    expect(b.to).toBe(MONTH.to);
    expect(b.from).toBe(a.to + 1n);
  });

  it('предел деления — секунда', () => {
    expect(MIN_SPLITTABLE_TICKS).toBe(SECOND);
  });
});
