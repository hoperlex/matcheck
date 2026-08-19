import { describe, expect, it } from 'vitest';
import { UpdPdfParsedSchema, type UpdPdfParsed } from '@matcheck/contracts';
import { normalizeUpdNoPricingTotals } from '../src/domain/edo/upd-no-pricing-normalize.js';

const parsed = (over: Partial<UpdPdfParsed> = {}): UpdPdfParsed => ({
  docNumber: 'РН-1',
  docDate: '2026-08-17',
  totalSum: null,
  vatSum: null,
  pricing: 'absent',
  itemsCount: 1,
  supplier: null,
  recipient: null,
  consignee: null,
  items: [{ nameRaw: 'Материал без цены', qty: 2, unit: 'шт' }],
  confidence: 0.9,
  ...over,
});

describe('нормализация УПД без стоимостной части', () => {
  it('при выключенном флаге возвращает тот же объект без изменений', () => {
    const input = parsed();
    expect(normalizeUpdNoPricingTotals(input, false)).toBe(input);
  });

  it('старый ответ без pricing остаётся прежним даже при включённом флаге', () => {
    const input = parsed({ pricing: undefined });
    expect(normalizeUpdNoPricingTotals(input, true)).toBe(input);
  });

  it('явный absent и полностью пустая стоимость дают нулевые итоги', () => {
    expect(normalizeUpdNoPricingTotals(parsed(), true)).toMatchObject({
      totalSum: 0,
      vatSum: 0,
    });
  });

  it.each([
    ['printed', parsed({ pricing: 'printed' })],
    ['unclear', parsed({ pricing: 'unclear' })],
    [
      'есть цена строки',
      parsed({ items: [{ nameRaw: 'Материал', qty: 1, unit: 'шт', price: 10 }] }),
    ],
    [
      'есть сумма строки',
      parsed({ items: [{ nameRaw: 'Материал', qty: 1, unit: 'шт', sum: 10 }] }),
    ],
    ['нет позиций', parsed({ items: [] })],
  ])('%s → no-op', (_label, input) => {
    expect(normalizeUpdNoPricingTotals(input, true)).toBe(input);
  });

  it('контракт приводит неизвестное pricing к null, а отсутствие поля допускает', () => {
    expect(UpdPdfParsedSchema.parse({ ...parsed(), pricing: 'invented' }).pricing).toBeNull();
    expect(UpdPdfParsedSchema.parse({ ...parsed(), pricing: undefined }).pricing).toBeUndefined();
  });
});
