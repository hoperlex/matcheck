import { describe, it, expect } from 'vitest';
import type { UpdPdfParsed } from '@matcheck/contracts';
import {
  getExcelVisionFallbackReasons,
  needsExcelVisionFallback,
  mergeExcelStructuralWithVision,
} from '../src/domain/edo/excel-vision-fallback.js';
import { consigneeOwnIdentity } from '../src/domain/sourceDocuments/party-directory-guard.js';

// Валидный структурный результат: суммы сходятся (items.sum=totalSum,
// items.vatSum=vatSum), confidence высокий, шапка заполнена.
function good(over: Partial<UpdPdfParsed> = {}): UpdPdfParsed {
  return {
    docNumber: 'A-1',
    docDate: '2026-06-01',
    totalSum: 122,
    vatSum: 22,
    itemsCount: 1,
    supplier: { inn: '1', kpp: '2', name: 'S' },
    recipient: { inn: '3', kpp: '4', name: 'R' },
    items: [
      {
        nameRaw: 'X',
        qty: 1,
        unit: 'шт',
        price: 100,
        sum: 122,
        vatRate: 22,
        vatSum: 22,
        volumeM3: null,
        massKg: null,
        volumeConfidence: null,
        groupName: null,
      },
    ],
    confidence: 0.95,
    ...over,
  };
}

describe('getExcelVisionFallbackReasons', () => {
  it('валидный structural → нет причин, fallback не нужен', () => {
    expect(getExcelVisionFallbackReasons(good())).toEqual([]);
    expect(needsExcelVisionFallback(good())).toBe(false);
  });

  it('structural == null → no_structural', () => {
    expect(getExcelVisionFallbackReasons(null)).toEqual(['no_structural']);
  });

  it('нет позиций → no_items (+ no_doc_header только при пустой шапке)', () => {
    const r = getExcelVisionFallbackReasons(good({ items: [] }));
    expect(r).toContain('no_items');
  });

  it('низкая уверенность → low_confidence', () => {
    expect(getExcelVisionFallbackReasons(good({ confidence: 0.5 }))).toContain('low_confidence');
  });

  it('суммы не сходятся → validation_mismatch', () => {
    // totalSum=999, а сумма позиций=122 → реальный mismatch.
    expect(getExcelVisionFallbackReasons(good({ totalSum: 999 }))).toContain('validation_mismatch');
  });

  it('vatSum пуст, но есть item.vatRate > 0 → vat_missing_with_rate', () => {
    expect(getExcelVisionFallbackReasons(good({ vatSum: null }))).toContain('vat_missing_with_rate');
  });

  it('docNumber отсутствует, но items/суммы хорошие → fallback НЕ из-за этого', () => {
    // Один пустой docNumber при нормальных позициях — не повод гонять Vision.
    expect(getExcelVisionFallbackReasons(good({ docNumber: null }))).toEqual([]);
  });

  it('один item — норма, не триггерит сам по себе', () => {
    expect(getExcelVisionFallbackReasons(good())).toEqual([]);
  });

  it('vatSum пуст при vatRate=0 («Без НДС») — НЕ триггерит', () => {
    const noVat = good({
      vatSum: null,
      totalSum: 100,
      items: [
        {
          nameRaw: 'X',
          qty: 1,
          unit: 'шт',
          price: 100,
          sum: 100,
          vatRate: 0,
          vatSum: null,
          volumeM3: null,
          massKg: null,
          volumeConfidence: null,
          groupName: null,
        },
      ],
    });
    expect(getExcelVisionFallbackReasons(noVat)).toEqual([]);
  });
});

describe('mergeExcelStructuralWithVision — чей список материалов', () => {
  const item = (name: string) => ({
    nameRaw: name,
    qty: 1,
    unit: 'шт',
    price: 100,
    sum: 122,
    vatRate: 20,
    vatSum: 22,
    volumeM3: null,
    massKg: null,
    volumeConfidence: null,
    groupName: null,
  });

  it('список, сошедшийся со «Всего наименований», побеждает', () => {
    // Ровно кейс сложного Excel: структурный парсер вытащил первые строки и
    // споткнулся на разметке, Vision увидел лист целиком. Раньше побеждал
    // структурный — и половина материалов пропадала молча.
    const structural = good({ items: [item('A')], itemsCount: 3, confidence: 0.9 });
    const vision = good({ items: [item('A'), item('B'), item('C')], itemsCount: 3 });

    const m = mergeExcelStructuralWithVision(structural, vision);

    expect(m.result.items).toHaveLength(3);
    expect(m.mergedFields).toContain('items');
  });

  it('структурный сошёлся со счётчиком — список Vision не берём', () => {
    // Защита от галлюцинаций: модель дописала строку, счётчик её не
    // подтверждает.
    const structural = good({ items: [item('A'), item('B')], itemsCount: 2, confidence: 0.9 });
    const vision = good({ items: [item('A'), item('B'), item('Выдумка')], itemsCount: 2 });

    const m = mergeExcelStructuralWithVision(structural, vision);

    expect(m.result.items).toHaveLength(2);
    expect(m.mergedFields).not.toContain('items');
  });

  it('счётчика нет — берём более длинный список', () => {
    // Пропущенная строка материала дороже лишней: лишнюю менеджер увидит в
    // карточке, недостающую — только на площадке.
    const structural = good({ items: [item('A')], itemsCount: null, confidence: 0.9 });
    const vision = good({ items: [item('A'), item('B')], itemsCount: null });

    expect(mergeExcelStructuralWithVision(structural, vision).result.items).toHaveLength(2);
  });

  it('списки равной длины — остаётся структурный', () => {
    const structural = good({ items: [item('A')], itemsCount: null, confidence: 0.9 });
    const vision = good({ items: [item('Другое имя')], itemsCount: null });

    const m = mergeExcelStructuralWithVision(structural, vision);

    expect(m.result.items[0]!.nameRaw).toBe('A');
    expect(m.mergedFields).not.toContain('items');
  });
});

describe('mergeExcelStructuralWithVision', () => {
  it('structural пустой по items → берём Vision целиком', () => {
    const vision = good({ docNumber: 'V' });
    const m = mergeExcelStructuralWithVision(good({ items: [] }), vision);
    expect(m.tookVisionWhole).toBe(true);
    expect(m.result).toBe(vision);
  });

  it('structural == null → Vision целиком', () => {
    const vision = good();
    expect(mergeExcelStructuralWithVision(null, vision).result).toBe(vision);
  });

  it('низкая уверенность structural → Vision целиком', () => {
    const vision = good();
    expect(mergeExcelStructuralWithVision(good({ confidence: 0.4 }), vision).tookVisionWhole).toBe(
      true,
    );
  });

  it('merge НЕ затирает structural.items', () => {
    const structural = good();
    const vision = good({
      docNumber: 'V',
      items: [{ ...good().items[0]!, nameRaw: 'VISION-ITEM', sum: 999 }],
    });
    const m = mergeExcelStructuralWithVision(structural, vision);
    expect(m.tookVisionWhole).toBe(false);
    expect(m.result.items).toBe(structural.items);
    expect(m.result.items[0]!.nameRaw).toBe('X');
  });

  it('merge добирает пустые docNumber/docDate/vatSum из Vision', () => {
    const structural = good({ docNumber: null, docDate: null, vatSum: null });
    const vision = good({ docNumber: 'V-NUM', docDate: '2026-06-02', vatSum: 50 });
    const m = mergeExcelStructuralWithVision(structural, vision);
    expect(m.result.docNumber).toBe('V-NUM');
    expect(m.result.docDate).toBe('2026-06-02');
    expect(m.result.vatSum).toBe(50);
    expect(m.mergedFields).toEqual(expect.arrayContaining(['docNumber', 'docDate', 'vatSum']));
    // items остались структурными
    expect(m.result.items).toBe(structural.items);
  });

  it('merge НЕ затирает заполненные поля structural', () => {
    const structural = good({ docNumber: 'KEEP' });
    const vision = good({ docNumber: 'OVERWRITE' });
    const m = mergeExcelStructuralWithVision(structural, vision);
    expect(m.result.docNumber).toBe('KEEP');
    expect(m.mergedFields).not.toContain('docNumber');
  });

  it('confidence не завышается слепо (max structural / min(vision,0.9))', () => {
    const m = mergeExcelStructuralWithVision(good({ confidence: 0.8 }), good({ confidence: 1 }));
    expect(m.result.confidence).toBe(0.9); // min(1, 0.9)=0.9 > 0.8
  });
});

/**
 * Грузополучатель на гибридном Excel-пути.
 *
 * Структурный парсер графу 4 читает и жёстко ставит inn/kpp = null. Но у
 * неполного Excel в дело вступает Vision — а он подчиняется промпту и на v9
 * подставляет туда реквизиты покупателя. Проверяется, что слияние ведёт себя
 * предсказуемо, а подстановку в итоге срезает общий гард сторон.
 */
describe('Excel-fallback: грузополучатель', () => {
  it('структурный без графы 4 добирает её из Vision', () => {
    const structural = good({ consignee: null });
    const vision = good({ consignee: { inn: null, kpp: null, name: 'ООО «АЛЬЯНС»' } });
    const m = mergeExcelStructuralWithVision(structural, vision);
    expect(m.result.consignee?.name).toBe('ООО «АЛЬЯНС»');
    expect(m.mergedFields).toContain('consignee');
  });

  it('структурная графа 4 не затирается Vision-версией', () => {
    // Структурный парсер читает ячейку документа, Vision — картинку; при
    // расхождении верить надо ячейке.
    const structural = good({ consignee: { inn: null, kpp: null, name: 'ООО «СУ-10»' } });
    const vision = good({ consignee: { inn: '7736255508', kpp: null, name: 'ООО «АЛЬЯНС»' } });
    const m = mergeExcelStructuralWithVision(structural, vision);
    expect(m.result.consignee?.name).toBe('ООО «СУ-10»');
    expect(m.result.consignee?.inn ?? null).toBeNull();
    expect(m.mergedFields).not.toContain('consignee');
  });

  it('реквизиты, принесённые Vision из графы покупателя, срезает гард сторон', () => {
    // Сквозная проверка связки: merge сам по себе доверяет Vision, и это
    // нормально — отличить подстановку от «он же» умеет consigneeOwnIdentity,
    // через который воркер прогоняет результат перед записью.
    // Покупателя структурный парсер прочитал сам (ячейка есть всегда), а графу
    // 4 не нашёл — её добирает Vision и приносит с реквизитами покупателя.
    const structural = good({
      consignee: null,
      recipient: { inn: '7736255508', kpp: '774550001', name: 'ООО «СУ-10»' },
    });
    const vision = good({
      recipient: { inn: '7736255508', kpp: '774550001', name: 'ООО «СУ-10»' },
      consignee: { inn: '7736255508', kpp: '774550001', name: 'ООО «АЛЬЯНС»' },
    });
    const m = mergeExcelStructuralWithVision(structural, vision);
    // До гарда в результате лежат чужие реквизиты…
    expect(m.result.consignee?.inn).toBe('7736255508');
    // …а после — только имя.
    const identity = consigneeOwnIdentity(m.result.consignee, m.result.recipient);
    expect(identity).toEqual({ inn: null, kpp: null });
    expect(m.result.consignee?.name).toBe('ООО «АЛЬЯНС»');
  });

  it('пустой структурный результат заменяется Vision целиком', () => {
    const vision = good({ consignee: { inn: null, kpp: null, name: 'ООО «АЛЬЯНС»' } });
    const m = mergeExcelStructuralWithVision(good({ items: [], confidence: 0.2 }), vision);
    expect(m.tookVisionWhole).toBe(true);
    expect(m.result.consignee?.name).toBe('ООО «АЛЬЯНС»');
  });
});
