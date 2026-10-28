/**
 * Подсказки у строк таблицы фото: проваленные проверки сверки и расхождение
 * со строкой УПД операции. Данные — приёмка 22246 (УПД № 1820 верен, фото —
 * нет).
 */
import { describe, expect, it } from 'vitest';
import type { PhotoLinkedDocument, PhotoRecognitionItem, UpdValidation } from '@matcheck/contracts';
import { photoRowHints, rowCheckText } from './photoRowHints';

const upd1820: PhotoLinkedDocument = {
  id: '469ac4ba-9b48-48a8-9201-8a32781868f0',
  docNumber: '1820',
  matchedBy: 'number',
  items: [
    { rowNo: 1, nameRaw: 'Швеллер 10П', qty: 204, unit: 'пог.м' },
    { rowNo: 2, nameRaw: 'Швеллер 8П', qty: 300, unit: 'пог.м' },
    { rowNo: 3, nameRaw: 'Автодоставка', qty: 1, unit: 'шт' },
  ],
};

// 1 этап: «1б» прочитано как 16, единица «пог. м» — с пробелом.
const stage1: PhotoRecognitionItem[] = [
  { rowNo: 1, nameRaw: 'Швеллер 10П', qty: 16, unit: 'пог. м', price: 632.79 },
  { rowNo: 2, nameRaw: 'Швеллер 8П', qty: 300, unit: 'пог. м', price: 552.46 },
  { rowNo: 3, nameRaw: 'Автодоставка', qty: 1, unit: 'шт', price: 15573.77 },
];
// 2 этап: номер графы «3» в количестве, «шт» вместо «пог.м».
const stage2: PhotoRecognitionItem[] = [
  { rowNo: 1, nameRaw: 'Швеллер 10П', qty: 3, unit: 'шт' },
  { rowNo: 2, nameRaw: 'Швеллер 8П', qty: 300, unit: 'шт' },
  { rowNo: 3, nameRaw: 'Автодоставка', qty: 1, unit: 'шт' },
];

function validation(
  failed: { name: 'row_qty_price' | 'row_vat_rate' | 'sum_total'; row?: number }[],
): UpdValidation {
  return {
    hasMismatch: failed.length > 0,
    checkedAt: '2026-10-28T06:27:54.000Z',
    checks: failed.map((f) => ({
      name: f.name,
      scope: f.row ? { row: f.row } : 'document',
      expected: 1,
      actual: 2,
      diff: 1,
      tolerance: 0.01,
      ok: false,
    })),
  };
}

describe('photoRowHints', () => {
  it('1 этап: строка 1 расходится с УПД количеством, «пог. м» = «пог.м»', () => {
    const h = photoRowHints(stage1, null, upd1820);
    expect(h.compared).toBe(3);
    expect(h.mismatched).toBe(1);
    expect(h.rows[0]!.doc).toEqual({ qty: 204, unit: 'пог.м' });
    expect(h.rows[1]!.doc).toBeNull();
    expect(h.rows[2]!.doc).toBeNull();
  });

  it('2 этап (опознан по строкам): количество и единица у строк 1–2', () => {
    const h = photoRowHints(stage2, null, { ...upd1820, matchedBy: 'rows' });
    expect(h.compared).toBe(3);
    expect(h.mismatched).toBe(2);
    expect(h.rows[0]!.doc).toEqual({ qty: 204, unit: 'пог.м' });
    // 300 = 300, но «шт» против «пог.м».
    expect(h.rows[1]!.doc).toEqual({ qty: 300, unit: 'пог.м' });
    expect(h.rows[2]!.doc).toBeNull();
  });

  it('проверка привязана к индексу строки, а не к напечатанному номеру', () => {
    // Строка с номером 5 стоит первой: scope.row = 1 — это она.
    const items: PhotoRecognitionItem[] = [
      { rowNo: 5, nameRaw: 'Х', qty: 1 },
      { rowNo: 6, nameRaw: 'Y', qty: 1 },
    ];
    const h = photoRowHints(items, validation([{ name: 'row_qty_price', row: 1 }]), null);
    expect(h.rows[0]!.failed).toEqual(['row_qty_price']);
    expect(h.rows[1]!.failed).toEqual([]);
  });

  it('проверки документа к строкам не относятся', () => {
    const h = photoRowHints(stage1, validation([{ name: 'sum_total' }]), null);
    expect(h.rows.every((r) => r.failed.length === 0)).toBe(true);
  });

  it('без УПД — сравнивать не с чем', () => {
    const h = photoRowHints(stage1, null, null);
    expect(h.compared).toBe(0);
    expect(h.rows.every((r) => r.doc === null)).toBe(true);
  });

  it('документ найден, но ни одна строка не сопоставилась — compared = 0', () => {
    const other: PhotoLinkedDocument = {
      ...upd1820,
      items: [{ rowNo: 7, nameRaw: 'Арматура А500С 12', qty: 1, unit: 'т' }],
    };
    const h = photoRowHints(stage1, null, other);
    expect(h.compared).toBe(0);
    expect(h.mismatched).toBe(0);
  });
});

describe('rowCheckText', () => {
  it('текст выбирается по проверке: НДС — не про количество', () => {
    expect(rowCheckText('row_vat_rate')).toMatch(/НДС строки/);
    expect(rowCheckText('row_vat_rate')).not.toMatch(/Кол-во/);
    expect(rowCheckText('row_qty_price')).toMatch(/Кол-во × цена/);
    expect(rowCheckText('sum_total')).toBe('Строка не прошла сверку сумм');
  });
});
