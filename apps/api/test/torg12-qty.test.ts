/**
 * Пересчёт количества по графам ТОРГ-12.
 *
 * Правило эвристическое ровно настолько, насколько это допустимо: оно
 * срабатывает только там, где количество либо не напечатано, либо равно массе
 * нетто при невесовой единице. Всё остальное — включая обычные УПД, где новых
 * полей вовсе нет, — обязано пройти мимо, иначе правка молча испортит
 * количество в приёмке.
 */
import { describe, expect, it } from 'vitest';
import type { UpdPdfParsed } from '@matcheck/contracts';
import {
  applyTorg12Qty,
  buildTorg12QtyTrace,
  detectTorg12Qty,
} from '../src/domain/edo/torg12-qty.js';

type Item = UpdPdfParsed['items'][number];

const doc = (items: Array<Partial<Item>>): UpdPdfParsed =>
  ({
    docNumber: '1002004449',
    docDate: '2026-09-21',
    totalSum: null,
    vatSum: null,
    supplier: null,
    recipient: null,
    confidence: 0.9,
    items: items.map((i, idx) => ({
      nameRaw: i.nameRaw ?? `позиция ${idx + 1}`,
      unit: i.unit ?? 'шт',
      qty: i.qty ?? null,
      price: i.price ?? null,
      sum: i.sum ?? null,
      vatRate: i.vatRate ?? null,
      vatSum: i.vatSum ?? null,
      ...i,
    })),
  }) as unknown as UpdPdfParsed;

describe('detectTorg12Qty', () => {
  it('боевой случай: 13 мест по 60 м², в количестве стоит масса нетто', () => {
    const parsed = doc([
      {
        nameRaw: 'ВЕНТИ БАТТС Н 1000х600х100',
        unit: 'м2',
        qty: 2886,
        qtyPerPlace: 60,
        places: 13,
        massNetKg: 2886,
      },
    ]);
    const [candidate, ...rest] = detectTorg12Qty(parsed);
    expect(rest).toEqual([]);
    expect(candidate).toMatchObject({ kind: 'mass_as_qty', qtyFrom: 2886, qtyTo: 780 });

    const { parsed: next, applied } = applyTorg12Qty(parsed, [candidate!]);
    expect(applied).toHaveLength(1);
    expect(next.items[0]!.qty).toBe(780);
    // Исходный разбор не мутирован — на него ссылается след.
    expect(parsed.items[0]!.qty).toBe(2886);
  });

  it('количество не напечатано вовсе — считаем по графам', () => {
    const parsed = doc([{ unit: 'м2', qty: null, qtyPerPlace: 60, places: 13 }]);
    expect(detectTorg12Qty(parsed)[0]).toMatchObject({ kind: 'qty_missing', qtyTo: 780 });
  });

  it('единица весовая — графа 10 и есть количество, не трогаем', () => {
    for (const unit of ['кг', 'КГ', 'т']) {
      const parsed = doc([{ unit, qty: 2886, qtyPerPlace: 60, places: 13, massNetKg: 2886 }]);
      expect(detectTorg12Qty(parsed)).toEqual([]);
    }
  });

  it('количество напечатано и массе не равно — строка не кандидат', () => {
    const parsed = doc([
      { unit: 'м2', qty: 500, qtyPerPlace: 60, places: 13, massNetKg: 2886 },
    ]);
    expect(detectTorg12Qty(parsed)).toEqual([]);
  });

  it('количество уже совпадает с произведением граф — правки нет', () => {
    const parsed = doc([{ unit: 'м2', qty: 780, qtyPerPlace: 60, places: 13, massNetKg: 2886 }]);
    expect(detectTorg12Qty(parsed)).toEqual([]);
  });

  it('обычная УПД без граф ТОРГ-12 правилом не затрагивается', () => {
    const parsed = doc([
      { nameRaw: 'Труба', unit: 'м', qty: 18, price: 100, sum: 2196 },
      { nameRaw: 'Доставка', unit: 'шт', qty: null, price: null, sum: 1000 },
    ]);
    expect(detectTorg12Qty(parsed)).toEqual([]);
    expect(applyTorg12Qty(parsed, []).parsed).toBe(parsed);
  });

  it('нулевые и отрицательные графы игнорируются', () => {
    expect(detectTorg12Qty(doc([{ qty: null, qtyPerPlace: 0, places: 13 }]))).toEqual([]);
    expect(detectTorg12Qty(doc([{ qty: null, qtyPerPlace: 60, places: -1 }]))).toEqual([]);
  });

  it('правится только своя строка: остальные позиции неизменны', () => {
    const parsed = doc([
      { nameRaw: 'Плита', unit: 'м2', qty: 2886, qtyPerPlace: 60, places: 13, massNetKg: 2886 },
      { nameRaw: 'Крепёж', unit: 'шт', qty: 400, price: 12, sum: 4800 },
    ]);
    const candidates = detectTorg12Qty(parsed);
    const { parsed: next } = applyTorg12Qty(parsed, candidates);
    expect(next.items[0]!.qty).toBe(780);
    expect(next.items[1]).toEqual(parsed.items[1]);
  });
});

describe('след правила', () => {
  it('в shadow все кандидаты — наблюдение', () => {
    const parsed = doc([{ unit: 'м2', qty: 2886, qtyPerPlace: 60, places: 13, massNetKg: 2886 }]);
    const candidates = detectTorg12Qty(parsed);
    const trace = buildTorg12QtyTrace({
      mode: 'shadow',
      candidates,
      appliedRows: new Set(),
      generation: 0,
      docVersion: 1,
    });
    expect(trace).toMatchObject({ mode: 'shadow', ruleVersion: 1 });
    expect(trace!.entries[0]).toMatchObject({ state: 'observed', qtyFrom: 2886, qtyTo: 780 });
  });

  it('без кандидатов следа нет вовсе', () => {
    expect(
      buildTorg12QtyTrace({
        mode: 'on',
        candidates: [],
        appliedRows: new Set(),
        generation: null,
        docVersion: null,
      }),
    ).toBeNull();
  });
});
