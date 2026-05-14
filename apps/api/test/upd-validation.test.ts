import { describe, it, expect } from 'vitest';
import { validateUpdTotals } from '../src/domain/edo/upd-validation.js';

describe('validateUpdTotals — сверка арифметики УПД', () => {
  it('всё сходится: построчно qty×price=sum, sum×vat%=vatSum, Σ строк = шапка', () => {
    const r = validateUpdTotals({
      totalSum: 1100,
      vatSum: 220,
      itemsCount: 1,
      items: [{ qty: 5.5, price: 200, sum: 1100, vatRate: 20, vatSum: 220 }],
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

  it('Построчно НДС: vatRate=20 для sum=1000 ожидает vatSum=200, актуальный 205 → mismatch', () => {
    const r = validateUpdTotals({
      totalSum: null,
      vatSum: null,
      items: [{ qty: 1, price: 1000, sum: 1000, vatRate: 20, vatSum: 205 }],
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
