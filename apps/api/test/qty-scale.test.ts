import { describe, expect, it } from 'vitest';
import type { UpdPdfItem, UpdPdfParsed } from '@matcheck/contracts';
import { applyQtyScale, buildQtyScaleTrace, detectQtyScale } from '../src/domain/edo/qty-scale.js';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function scaledItem(over: Partial<UpdPdfItem> = {}): UpdPdfItem {
  const qty = 74;
  const price = 123.45;
  const base = round2(qty * price);
  const sum = round2(base * 1.22);
  return {
    rowNo: 1,
    nameRaw: 'Клапан противопожарный',
    qty: qty * 1000,
    unit: 'шт',
    price,
    sum,
    vatRate: 22,
    vatSum: round2((sum * 22) / 122),
    volumeM3: null,
    massKg: null,
    volumeConfidence: null,
    groupName: null,
    ...over,
  } as UpdPdfItem;
}

function doc(item: UpdPdfItem = scaledItem(), over: Partial<UpdPdfParsed> = {}): UpdPdfParsed {
  return {
    docNumber: 'Т26-1315-7',
    docDate: '2026-09-01',
    totalSum: item.sum,
    vatSum: item.vatSum,
    itemsCount: 1,
    confidence: 0.98,
    supplier: null,
    recipient: null,
    consignee: null,
    items: [item],
    ...over,
  } as UpdPdfParsed;
}

describe('detectQtyScale', () => {
  it('находит доказуемую потерю запятой 74000 → 74', () => {
    const candidates = detectQtyScale(doc());
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      row: 1,
      kind: 'lost_decimal_1000',
      qtyFrom: 74000,
      qtyTo: 74,
      applicable: true,
    });
  });

  it('применяет по индексу, а не по напечатанному rowNo', () => {
    const parsed = doc(scaledItem({ rowNo: 348 }));
    const result = applyQtyScale(parsed, detectQtyScale(parsed));
    expect(result.parsed.items[0]!.qty).toBe(74);
    expect(result.applied).toHaveLength(1);
  });

  it.each([1000, 1_000_000])('не трогает настоящее сходящееся количество %s', (qty) => {
    const price = 123.45;
    const base = round2(qty * price);
    const sum = round2(base * 1.22);
    const healthy = scaledItem({
      qty,
      price,
      sum,
      vatSum: round2((sum * 22) / 122),
    });
    expect(detectQtyScale(doc(healthy, { totalSum: sum, vatSum: healthy.vatSum }))).toEqual([]);
  });

  it('не принимает поддельное подтверждение НДС', () => {
    expect(detectQtyScale(doc(scaledItem({ vatSum: 1 })))).toEqual([]);
  });

  it('работает без построчного НДС, если остальные доказательства есть', () => {
    const withVat = scaledItem();
    const withoutLineVat = { ...withVat, vatRate: null, vatSum: null };
    expect(detectQtyScale(doc(withoutLineVat, { vatSum: withVat.vatSum }))[0]?.applicable).toBe(
      true,
    );
  });

  it.each([
    [{ price: 120 }, 'price_multiple_10'],
    [{ price: 123 }, 'integer_price'],
    [{ unit: 'тыс. шт' }, 'thousand_unit'],
  ] as const)('оставляет рискованный случай наблюдением: %s', (over, reason) => {
    const original = scaledItem();
    const qtyTo = (original.qty ?? 0) / 1000;
    const price = over.price ?? original.price!;
    const base = round2(qtyTo * price);
    const sum = round2(base * 1.22);
    const candidate = scaledItem({
      ...over,
      sum,
      vatSum: round2((sum * 22) / 122),
    });
    const found = detectQtyScale(doc(candidate, { totalSum: sum, vatSum: candidate.vatSum }));
    expect(found[0]).toMatchObject({ applicable: false, blockedBy: reason });
    expect(applyQtyScale(doc(candidate), found).applied).toEqual([]);
  });

  it('не трогает количество меньше 1000 и масштаб ×100', () => {
    expect(detectQtyScale(doc(scaledItem({ qty: 74 })))).toEqual([]);
    expect(detectQtyScale(doc(scaledItem({ qty: 7400 })))).toEqual([]);
  });
});

describe('buildQtyScaleTrace', () => {
  it('хранит прочитанное и исправленное количество', () => {
    const candidates = detectQtyScale(doc());
    const trace = buildQtyScaleTrace({
      mode: 'on',
      candidates,
      appliedRows: new Set([1]),
      generation: 0,
      docVersion: '2026-10-01T00:00:00.000Z',
    });
    expect(trace?.entries[0]).toMatchObject({ state: 'applied', qtyFrom: 74000, qtyTo: 74 });
  });
});
