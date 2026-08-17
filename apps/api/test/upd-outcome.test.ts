/**
 * Правило «документ готов к приёмке».
 *
 * Здесь проверяется ровно та граница, ошибка на которой дороже всего: между
 * «инспектор принимает поставку» и «менеджер добивает документ руками».
 * Слишком строгое правило держит на портале работу, которую можно делать;
 * слишком мягкое — отправляет инспектору документ с половиной материалов, и
 * недостача вскрывается уже на площадке.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveUpdParseOutcome,
  rowTotalWithVat,
  synthesizeTotalSum,
} from '../src/domain/edo/upd-outcome.js';
import { validateUpdTotals } from '../src/domain/edo/upd-validation.js';

type Item = {
  qty?: number | null;
  price?: number | null;
  sum?: number | null;
  vatRate?: number | null;
  vatSum?: number | null;
};

/** Сверка считается по тем же данным, что и исход, — как в бою. */
function outcomeOf(parsed: {
  items: Item[];
  docNumber?: string | null;
  totalSum?: number | null;
  itemsCount?: number | null;
}) {
  const validation = validateUpdTotals({
    totalSum: parsed.totalSum ?? null,
    vatSum: null,
    itemsCount: parsed.itemsCount ?? null,
    items: parsed.items,
  });
  return deriveUpdParseOutcome({ ...parsed, confidence: 0.9 }, validation);
}

const row = (sum: number): Item => ({ qty: 1, price: sum, sum, vatRate: 0 });

describe('готовность УПД к приёмке', () => {
  it('номер и позиции — документ уезжает инспектору', () => {
    const out = outcomeOf({ items: [row(100), row(200)], docNumber: 'УТ-1', totalSum: 300 });

    expect(out.status).toBe('parsed');
    expect(out.parseErrorCode).toBeNull();
  });

  it('без номера документ остаётся у менеджера', () => {
    const out = outcomeOf({ items: [row(100)], docNumber: null, totalSum: 100 });

    expect(out.status).toBe('needs_resolution');
    expect(out.parseErrorCode).toBe('partial_parse');
    expect((out.parseErrorDetails as { missing: string[] }).missing).toContain('docNumber');
  });

  it('без позиций документ остаётся у менеджера', () => {
    const out = outcomeOf({ items: [], docNumber: 'УТ-2', totalSum: 500 });

    expect(out.status).toBe('needs_resolution');
    expect((out.parseErrorDetails as { missing: string[] }).missing).toContain('items');
  });

  it('распознали 3 строки из 12 — это неполный список, а не расхождение', () => {
    // Главный случай ради которого правило и разделено: сумма, номер и дата на
    // месте, документ выглядит готовым — но девяти материалов в нём нет.
    const out = outcomeOf({
      items: [row(100), row(100), row(100)],
      docNumber: 'УТ-3',
      totalSum: 300,
      itemsCount: 12,
    });

    expect(out.status).toBe('needs_resolution');
    expect(out.parseErrorCode).toBe('partial_parse');
    const details = out.parseErrorDetails as {
      missing: string[];
      itemsExpected: number;
      itemsParsed: number;
    };
    expect(details.missing).toContain('itemsIncomplete');
    expect(details.itemsExpected).toBe(12);
    expect(details.itemsParsed).toBe(3);
  });

  it('счётчика наименований нет — список считаем полным', () => {
    // У фотографий и сканов «Всего наименований» почти никогда не читается.
    // Требовать его значило бы не пустить инспектору почти ничего.
    const out = outcomeOf({ items: [row(100)], docNumber: 'УТ-4', totalSum: 100 });

    expect(out.status).toBe('parsed');
  });

  it('счётчик совпал — документ готов', () => {
    const out = outcomeOf({
      items: [row(100), row(50)],
      docNumber: 'УТ-5',
      totalSum: 150,
      itemsCount: 2,
    });

    expect(out.status).toBe('parsed');
  });

  it('денежное расхождение не держит документ, но остаётся пометкой', () => {
    // Итог в шапке не сходится с суммой строк: инспектор принимает, менеджер
    // видит предупреждение и сверяет.
    const out = outcomeOf({ items: [row(100), row(100)], docNumber: 'УТ-6', totalSum: 999 });

    expect(out.status).toBe('parsed');
    expect(out.parseErrorCode).toBe('validation_mismatch');
    expect((out.parseErrorDetails as { failedChecks: unknown[] }).failedChecks.length)
      .toBeGreaterThan(0);
  });

  it('нет суммы — считаем по строкам и пускаем', () => {
    const out = outcomeOf({ items: [row(100), row(250)], docNumber: 'УТ-7', totalSum: null });

    expect(out.status).toBe('parsed');
    expect(out.totalSum).toBe(350);
    expect(out.totalSumSynthesized).toBe(true);
  });
});

describe('итог по строкам', () => {
  it('строка с суммой берётся как есть — она уже с налогом', () => {
    expect(rowTotalWithVat({ qty: 3, price: 100, sum: 360, vatRate: 20 })).toBe(360);
  });

  it('без суммы считается с НДС, а не голое qty × price', () => {
    // price — цена БЕЗ налога (графа 4), sum — с налогом (графа 9). Простое
    // умножение занизило бы строку на 20 %: 300 вместо 360.
    expect(rowTotalWithVat({ qty: 3, price: 100, sum: null, vatRate: 20 })).toBe(360);
  });

  it('ставка неизвестна — строку считать нечем', () => {
    // Признать ставку нулевой значит занизить итог и выдать это за прочитанное
    // из документа.
    expect(rowTotalWithVat({ qty: 3, price: 100, sum: null, vatRate: null })).toBeNull();
  });

  it('ставка ноль — считается без налога', () => {
    expect(rowTotalWithVat({ qty: 2, price: 50, sum: null, vatRate: 0 })).toBe(100);
  });

  it('одна невычислимая строка — итога нет вовсе', () => {
    // Частичная сумма опаснее пустой: она выглядит достоверной и молча
    // занижает поставку.
    const total = synthesizeTotalSum([
      { qty: 1, price: 100, sum: 120, vatRate: 20 },
      { qty: 2, price: null, sum: null, vatRate: null },
    ]);

    expect(total).toBeNull();
  });

  it('копейки округляются построчно и в итоге', () => {
    const total = synthesizeTotalSum([
      { qty: 3, price: 65.4918, sum: null, vatRate: 20 },
      { qty: 1, price: 10.005, sum: null, vatRate: 0 },
    ]);

    // 3 × 65.4918 = 196.4754 → 196.48 → ×1.2 = 235.776 → 235.78; плюс 10.01.
    expect(total).toBe(245.79);
  });

  it('пустой список не даёт итога', () => {
    expect(synthesizeTotalSum([])).toBeNull();
  });
});
