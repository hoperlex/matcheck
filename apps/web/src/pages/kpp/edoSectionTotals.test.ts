/**
 * Сводки блока с УПД из ЭДО: «ЭДО: …» и «Факт: …».
 *
 * Главное: неизвестное не считается нулём. Строка без цены, УПД без итога —
 * видны пометкой, а не тонут в сумме, которая выглядит полной.
 */
import { describe, expect, it } from 'vitest';
import { formatMoneyRu } from '../../shared/utils/formatRu';
import { edoTotals, factTotals, formatPartialSum, type FactRow } from './edoSectionTotals';
import type { EdoItemsResponse } from './useDeliveryEdoItems';

const row = (over: Partial<FactRow> = {}): FactRow => ({
  qtyActual: null,
  qtyPlanned: null,
  price: null,
  vatRate: null,
  vatSum: null,
  ...over,
});

const doc = (totals: EdoItemsResponse['totals'], items = 1): EdoItemsResponse => ({
  matchId: 'm',
  source: 'export',
  label: { operator: 'sbis', docNumber: '1', docDate: null, correctionNumber: null },
  state: 'ready',
  totals,
  reasons: [],
  items: Array.from({ length: items }, (_, position) => ({
    position,
    lineNo: position + 1,
    nameRaw: `Позиция ${position + 1}`,
    qty: 1,
    unit: 'шт',
    unitCode: null,
    price: 1,
    sumExVat: 1,
    vatRate: null,
    vatSum: null,
    sum: 1,
    itemKind: 1,
    productCode: null,
  })),
});

describe('factTotals — по правилу сохранения', () => {
  it('приёмка 21768, УПД 41296: без НДС Σ qty × price, НДС — из строк', () => {
    // Две строки факта по бумажной УПД: цены и НДС как в базе.
    const totals = factTotals([
      row({ qtyPlanned: '45', price: '128.79', vatSum: '1275.02' }),
      row({ qtyPlanned: '45', price: '129.51', vatSum: '1282.15' }),
    ]);
    expect(totals.count).toBe(2);
    expect(totals.exVat).toEqual({ value: expect.closeTo(11623.5, 6), missing: 0 });
    expect(totals.vat).toEqual({ value: expect.closeTo(2557.17, 6), missing: 0 });
  });

  it('факт важнее плана; НДС пересчитывается, если есть ставка', () => {
    const totals = factTotals([
      row({ qtyPlanned: '10', qtyActual: '4', price: '100', vatRate: '22', vatSum: '1.00' }),
    ]);
    expect(totals.exVat.value).toBe(400);
    // 4 × 100 × 22 % = 88 — пересчитанный, а не сохранённые 1.00.
    expect(totals.vat.value).toBeCloseTo(88, 6);
  });

  it('строки без цены и без НДС считаются отдельно, не нулём', () => {
    const totals = factTotals([
      row({ qtyActual: '2', price: '10', vatSum: '4' }),
      row({ qtyActual: '3' }),
      row({ qtyActual: '5', price: '1' }),
    ]);
    expect(totals.exVat).toEqual({ value: 25, missing: 1 });
    expect(totals.vat).toEqual({ value: 4, missing: 2 });
  });

  it('ни у одной строки нет цены — суммы нет вовсе', () => {
    expect(factTotals([row({ qtyActual: '1' })]).exVat).toEqual({ value: null, missing: 1 });
    expect(factTotals([]).exVat).toEqual({ value: null, missing: 0 });
  });
});

describe('edoTotals — по итогам УПД', () => {
  it('складывает итоги без НДС и НДС, строки считает по всем УПД', () => {
    const totals = edoTotals([
      doc({ totalSum: 71691, totalExVat: 58763.11, vatSum: 12927.89 }, 3),
      doc({ totalSum: 14180.4, totalExVat: 11623.28, vatSum: 2557.12 }, 2),
    ]);
    expect(totals.count).toBe(5);
    expect(totals.exVat).toEqual({ value: expect.closeTo(70386.39, 6), missing: 0 });
    expect(totals.vat).toEqual({ value: expect.closeTo(15485.01, 6), missing: 0 });
  });

  it('у УПД без итога — пометка, а не ноль', () => {
    const totals = edoTotals([
      doc({ totalSum: 100, totalExVat: null, vatSum: 20 }),
      doc({ totalSum: 50, totalExVat: 40, vatSum: null }),
      doc(null),
    ]);
    expect(totals.exVat).toEqual({ value: 40, missing: 2 });
    expect(totals.vat).toEqual({ value: 20, missing: 2 });
  });
});

describe('formatPartialSum', () => {
  it('полная сумма — просто деньги', () => {
    expect(formatPartialSum({ value: 1614.75, missing: 0 }, 'цены', 'rows')).toBe(
      formatMoneyRu(1614.75),
    );
  });

  it('неполная — с пометкой и верным падежом', () => {
    expect(formatPartialSum({ value: 10, missing: 1 }, 'цены', 'rows')).toBe(
      `${formatMoneyRu(10)} (у 1 строки нет цены)`,
    );
    expect(formatPartialSum({ value: 10, missing: 3 }, 'цены', 'rows')).toBe(
      `${formatMoneyRu(10)} (у 3 строк нет цены)`,
    );
    expect(formatPartialSum({ value: 10, missing: 11 }, 'НДС', 'rows')).toBe(
      `${formatMoneyRu(10)} (у 11 строк нет НДС)`,
    );
    expect(formatPartialSum({ value: 10, missing: 21 }, 'НДС', 'rows')).toBe(
      `${formatMoneyRu(10)} (у 21 строки нет НДС)`,
    );
    expect(formatPartialSum({ value: 10, missing: 2 }, 'итога без НДС', 'documents')).toBe(
      `${formatMoneyRu(10)} (у 2 УПД нет итога без НДС)`,
    );
  });

  it('известного нет — «—»', () => {
    expect(formatPartialSum({ value: null, missing: 4 }, 'цены', 'rows')).toBe('—');
  });
});
