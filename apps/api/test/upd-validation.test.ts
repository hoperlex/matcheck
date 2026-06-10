import { describe, it, expect } from 'vitest';
import { validateUpdTotals } from '../src/domain/edo/upd-validation.js';

describe('validateUpdTotals — сверка арифметики УПД', () => {
  it('row_qty_price: vatRate в строке null → берётся эффективная ставка из шапки', () => {
    // Типичный случай УПД ТД-42193: LLM не извлекла vatRate для
    // одной строки, но шапочные totalSum/vatSum позволяют вычислить
    // эффективную ставку (тут ≈ 22%). База без НДС считается через
    // неё. price = 70111.07 (графа 4), sum = 1300139.60 (графа 9):
    //   base = 1300139.60 × 100 / (100 + 22) ≈ 1065688.20;
    //   qty × price = 15.2 × 70111.07 = 1065688.26;
    //   diff ≈ 0.06 → внутри tolerance max(1, 0.1% от base).
    const r = validateUpdTotals({
      totalSum: 1300139.6,
      vatSum: 234451.4,
      items: [
        { qty: 15.2, price: 70111.07, sum: 1300139.6, vatRate: null, vatSum: null },
      ],
    });
    const row = r.checks.find((c) => c.name === 'row_qty_price');
    expect(row?.ok).toBe(true);
    expect(row?.expected).toBeCloseTo(1065688.2, 1);
    expect(row?.actual).toBeCloseTo(1065688.26, 1);
    expect(r.hasMismatch).toBe(false);
  });

  it('всё сходится: price из графы 4 (БЕЗ НДС), sum из графы 9 (С НДС) — промпт v7', () => {
    // После промпта v7 price = графа 4 (без НДС), sum = графа 9 (с НДС).
    // qty × price = 5.5 × 160 = 880 (база без НДС).
    // sum / (1 + 0.2) = 1056 / 1.2 = 880 — совпадает.
    // vatSum = sum × rate / (100 + rate) = 1056 × 20 / 120 = 176.
    const r = validateUpdTotals({
      totalSum: 1056,
      vatSum: 176,
      itemsCount: 1,
      items: [{ qty: 5.5, price: 160, sum: 1056, vatRate: 20, vatSum: 176 }],
    });
    expect(r.hasMismatch).toBe(false);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it('Σ items.sum vs totalSum: расхождение 0,02 ₽ при 2 строках укладывается в tolerance', () => {
    const r = validateUpdTotals({
      totalSum: 1000.04, // expected
      vatSum: null,
      items: [
        { qty: 1, price: 500, sum: 500.01, vatRate: null, vatSum: null },
        { qty: 1, price: 500, sum: 500.01, vatRate: null, vatSum: null },
      ],
    });
    const sumCheck = r.checks.find((c) => c.name === 'sum_total');
    expect(sumCheck?.ok).toBe(true);
    expect(sumCheck?.diff).toBeCloseTo(0.02, 2);
    expect(sumCheck?.tolerance).toBeCloseTo(0.02, 2);
  });

  it('Σ items.vatSum vs vatSum: расхождение 0,10 ₽ при 2 строках — за пределами tolerance', () => {
    const r = validateUpdTotals({
      totalSum: null,
      vatSum: 200.1, // expected
      items: [
        { qty: 1, price: 500, sum: 500, vatRate: 20, vatSum: 100 },
        { qty: 1, price: 500, sum: 500, vatRate: 20, vatSum: 100 },
      ],
    });
    const vatCheck = r.checks.find((c) => c.name === 'vat_total');
    expect(vatCheck?.ok).toBe(false);
    expect(vatCheck?.diff).toBeCloseTo(0.1, 2);
    expect(r.hasMismatch).toBe(true);
  });

  it('Без НДС в шапке: vat_total skip с skipReason=no_expected', () => {
    const r = validateUpdTotals({
      totalSum: 1000,
      vatSum: null,
      items: [{ qty: 1, price: 1000, sum: 1000, vatRate: null, vatSum: null }],
    });
    const vatCheck = r.checks.find((c) => c.name === 'vat_total');
    expect(vatCheck?.ok).toBe(true);
    expect(vatCheck?.skipReason).toBe('no_expected');
    expect(r.hasMismatch).toBe(false);
  });

  it('Построчно: qty=5,5 × price=200 = 1100; sum=1099,99 — diff 0,01 в пределах tolerance', () => {
    const r = validateUpdTotals({
      totalSum: null,
      vatSum: null,
      items: [{ qty: 5.5, price: 200, sum: 1099.99, vatRate: null, vatSum: null }],
    });
    const row = r.checks.find((c) => c.name === 'row_qty_price');
    expect(row?.ok).toBe(true);
    expect(row?.diff).toBeCloseTo(0.01, 2);
  });

  it('Построчно НДС: sum=1200 С НДС, ставка 20 → ожидает vatSum=200; 205 → mismatch', () => {
    // sum уже С НДС (промпт v6), поэтому ожидаемый НДС =
    // 1200 × 20 / 120 = 200. Парсер положил 205 → diff = 5 → mismatch.
    const r = validateUpdTotals({
      totalSum: null,
      vatSum: null,
      items: [{ qty: 1, price: 1200, sum: 1200, vatRate: 20, vatSum: 205 }],
    });
    const row = r.checks.find((c) => c.name === 'row_vat_rate');
    expect(row?.ok).toBe(false);
    expect(row?.diff).toBeCloseTo(5, 1);
    expect(r.hasMismatch).toBe(true);
  });

  it('itemsCount=12 vs items.length=11 → mismatch', () => {
    const items = Array.from({ length: 11 }, () => ({
      qty: 1,
      price: 100,
      sum: 100,
      vatRate: 20,
      vatSum: 20,
    }));
    const r = validateUpdTotals({ totalSum: null, vatSum: null, itemsCount: 12, items });
    const cnt = r.checks.find((c) => c.name === 'items_count');
    expect(cnt?.ok).toBe(false);
    expect(cnt?.expected).toBe(12);
    expect(cnt?.actual).toBe(11);
    expect(r.hasMismatch).toBe(true);
  });

  it('itemsCount=null (парсер не извлёк) → items_count skip, hasMismatch=false', () => {
    const r = validateUpdTotals({
      totalSum: 100,
      vatSum: null,
      itemsCount: null,
      items: [{ qty: 1, price: 100, sum: 100, vatRate: null, vatSum: null }],
    });
    const cnt = r.checks.find((c) => c.name === 'items_count');
    expect(cnt?.ok).toBe(true);
    expect(cnt?.skipReason).toBe('no_expected');
    expect(r.hasMismatch).toBe(false);
  });

  it('Частично заполненная строка (price=null) → построчные проверки skip, не мешают hasMismatch', () => {
    const r = validateUpdTotals({
      totalSum: 1000,
      vatSum: null,
      items: [{ qty: 5, price: null, sum: 1000, vatRate: null, vatSum: null }],
    });
    const rowQp = r.checks.find((c) => c.name === 'row_qty_price');
    const rowVat = r.checks.find((c) => c.name === 'row_vat_rate');
    expect(rowQp?.ok).toBe(true);
    expect(rowQp?.skipReason).toBe('no_actual');
    expect(rowVat?.ok).toBe(true);
    expect(r.hasMismatch).toBe(false);
  });

  // ──────────── Реальные кейсы из прод-лога llm_calls ────────────

  it('УПД 201/21125720: price из графы 4 (без НДС), sum из графы 9 (с НДС), vatRate в строке null → ok', () => {
    // Реальный документ из лога llm_calls. Под промпт v7:
    //   price = графа 4 «Цена без налога» (65.49 и т.д.);
    //   sum   = графа 9 «Стоимость с налогом — всего».
    // LLM не извлекла vatRate по позициям; эффективная ставка берётся
    // из шапки: 29332.28 / (162660.8 − 29332.28) × 100 ≈ 22%.
    // Σ items.sum = 47940 + 28364.5 + 10946.3 + 45980 + 29430 = 162660.80.
    // Каждая строка: base = sum / 1.22 ≈ qty × price с копеечной
    // погрешностью из-за округления цены поставщиком.
    const r = validateUpdTotals({
      totalSum: 162660.8,
      vatSum: 29332.28,
      items: [
        { qty: 600, price: 65.49, sum: 47940, vatRate: null, vatSum: null },
        { qty: 355, price: 65.49, sum: 28364.5, vatRate: null, vatSum: null },
        { qty: 137, price: 65.49, sum: 10946.3, vatRate: null, vatSum: null },
        { qty: 440, price: 85.66, sum: 45980, vatRate: null, vatSum: null },
        { qty: 180, price: 134.02, sum: 29430, vatRate: null, vatSum: null },
      ],
    });
    expect(r.hasMismatch).toBe(false);
    const sumCheck = r.checks.find((c) => c.name === 'sum_total');
    expect(sumCheck?.ok).toBe(true);
    expect(sumCheck?.expected).toBeCloseTo(162660.8, 2);
    expect(sumCheck?.actual).toBeCloseTo(162660.8, 2);
    const vatCheck = r.checks.find((c) => c.name === 'vat_total');
    expect(vatCheck?.ok).toBe(true);
    expect(vatCheck?.skipReason).toBe('no_actual');
  });

  it('vat_total skip when items.vatSum все пусты (PDF-флоу не извлекает vat по позициям)', () => {
    const r = validateUpdTotals({
      totalSum: 120,
      vatSum: 20,
      items: [
        { qty: 1, price: 100, sum: 100, vatRate: null, vatSum: null },
        { qty: 1, price: 100, sum: 100, vatRate: null, vatSum: null },
      ],
    });
    const vatCheck = r.checks.find((c) => c.name === 'vat_total');
    expect(vatCheck?.ok).toBe(true);
    expect(vatCheck?.skipReason).toBe('no_actual');
  });

  it('row_qty_price: расхождение 1.08₽ при sum=39295.08 укладывается в tolerance 0.1%', () => {
    const r = validateUpdTotals({
      totalSum: null,
      vatSum: null,
      items: [{ qty: 600, price: 65.49, sum: 39295.08, vatRate: null, vatSum: null }],
    });
    const row = r.checks.find((c) => c.name === 'row_qty_price');
    expect(row?.ok).toBe(true);
    expect(row?.diff).toBeCloseTo(1.08, 2);
    // max(1, 39295.08 * 0.001) ≈ 39.3 — спокойно покрывает 1.08₽.
    expect(row?.tolerance).toBeCloseTo(39.3, 1);
  });

  it('row_qty_price: настоящая ошибка (qty/price перепутаны) ловится несмотря на расширенный tolerance', () => {
    // Сюжет УПД 2493: код товара 796 распознан как qty, реальное qty 222.
    // 796 × 65.49 = 52130, реальный sum=14538, расхождение 37592₽. tolerance
    // max(1, 14.5₽) — далеко не покрывает.
    const r = validateUpdTotals({
      totalSum: null,
      vatSum: null,
      items: [{ qty: 796, price: 65.49, sum: 14538, vatRate: null, vatSum: null }],
    });
    const row = r.checks.find((c) => c.name === 'row_qty_price');
    expect(row?.ok).toBe(false);
    expect(r.hasMismatch).toBe(true);
  });

  it('scope построчных проверок содержит номер строки (1-based)', () => {
    const r = validateUpdTotals({
      totalSum: null,
      vatSum: null,
      items: [
        { qty: 1, price: 100, sum: 100, vatRate: 20, vatSum: 20 },
        { qty: 2, price: 50, sum: 100, vatRate: 20, vatSum: 20 },
      ],
    });
    const rows = r.checks.filter((c) => c.name === 'row_qty_price');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.scope).toEqual({ row: 1 });
    expect(rows[1]?.scope).toEqual({ row: 2 });
  });
});
