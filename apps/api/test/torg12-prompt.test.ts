/**
 * Промпт ТОРГ-12 только для поставщиков из списка: когда второй разбор
 * делается, а когда нет. Главное здесь — «нет»: любой документ не из списка
 * должен отсекаться до вызова модели, иначе правило перестаёт быть узким.
 */
import { describe, expect, it } from 'vitest';
import type { UpdPdfParsed } from '@matcheck/contracts';
import {
  clearTorg12Money,
  innInList,
  parseSupplierInns,
  summarizeForTrace,
  torg12PromptApplies,
  type Torg12PromptContext,
} from '../src/domain/edo/torg12-prompt.js';
import type { ParseMode } from '../src/domain/edo/parse-mode.js';

const ROCKWOOL = '5012093506';

const rockwoolPhoto: Torg12PromptContext = {
  mode: 'on',
  parseMode: 'image_vision',
  secondPassJob: false,
  segmentRepairJob: false,
  jobGeneration: 0,
  supplierInn: ROCKWOOL,
  inns: parseSupplierInns(ROCKWOOL),
};

describe('parseSupplierInns', () => {
  it('список через запятую, пробелы и мусор отбрасываются', () => {
    expect([...parseSupplierInns(' 5012093506 , 7714529160,,')]).toEqual([
      '5012093506',
      '7714529160',
    ]);
  });

  it('пусто — пустой список', () => {
    expect(parseSupplierInns('').size).toBe(0);
    expect(parseSupplierInns(undefined).size).toBe(0);
  });
});

describe('torg12PromptApplies', () => {
  it('накладная РОКВУЛ с фото, скана или склеенных листов — да', () => {
    for (const parseMode of ['image_vision', 'vision_pdf', 'segment_vision'] as ParseMode[]) {
      expect(torg12PromptApplies({ ...rockwoolPhoto, parseMode })).toBe(true);
    }
    expect(torg12PromptApplies({ ...rockwoolPhoto, mode: 'shadow' })).toBe(true);
  });

  it('ИНН с пробелами и дефисами узнаётся', () => {
    expect(torg12PromptApplies({ ...rockwoolPhoto, supplierInn: '5012-093 506' })).toBe(true);
  });

  it('off — нет', () => {
    expect(torg12PromptApplies({ ...rockwoolPhoto, mode: 'off' })).toBe(false);
  });

  it('чужой поставщик, пустой ИНН или пустой список — нет', () => {
    expect(torg12PromptApplies({ ...rockwoolPhoto, supplierInn: '7714529160' })).toBe(false);
    expect(torg12PromptApplies({ ...rockwoolPhoto, supplierInn: null })).toBe(false);
    expect(torg12PromptApplies({ ...rockwoolPhoto, inns: parseSupplierInns('') })).toBe(false);
  });

  it('текстовый PDF, Excel, М-15, второй проход — нет', () => {
    for (const parseMode of [
      'text',
      'text_bundle',
      'vision_bundle',
      'excel_structural',
      'excel_vision',
      'm15_vision',
      'second_pass_vision',
    ] as ParseMode[]) {
      expect(torg12PromptApplies({ ...rockwoolPhoto, parseMode })).toBe(false);
    }
  });

  it('повторы и ручной повтор (поколение > 0) — нет', () => {
    expect(torg12PromptApplies({ ...rockwoolPhoto, secondPassJob: true })).toBe(false);
    expect(torg12PromptApplies({ ...rockwoolPhoto, segmentRepairJob: true })).toBe(false);
    expect(torg12PromptApplies({ ...rockwoolPhoto, jobGeneration: 1 })).toBe(false);
  });
});

describe('summarizeForTrace', () => {
  it('сводка содержит номер, дату, строки и графы 7/8', () => {
    const parsed = {
      docNumber: '10626044499',
      docDate: '2026-09-21',
      totalSum: null,
      confidence: 0.9,
      items: [
        {
          rowNo: 1,
          nameRaw: 'ВЕНТИ БАТТС Н 1000х600х100',
          unit: 'м2',
          qty: null,
          qtyPerPlace: 60,
          places: 13,
        },
      ],
    } as unknown as UpdPdfParsed;
    expect(summarizeForTrace(parsed)).toEqual({
      docNumber: '10626044499',
      docDate: '2026-09-21',
      items: 1,
      rows: [
        {
          rowNo: 1,
          nameRaw: 'ВЕНТИ БАТТС Н 1000х600х100',
          unit: 'м2',
          qty: null,
          qtyPerPlace: 60,
          places: 13,
        },
      ],
      totalSum: null,
      confidence: 0.9,
    });
  });
});

describe('innInList', () => {
  it('сравнивает только цифры; пустой ИНН — нет', () => {
    const inns = parseSupplierInns(ROCKWOOL);
    expect(innInList('5012 093-506', inns)).toBe(true);
    expect(innInList('7714529160', inns)).toBe(false);
    expect(innInList(null, inns)).toBe(false);
    expect(innInList('', inns)).toBe(false);
  });
});

describe('clearTorg12Money', () => {
  // Боевой сдвиг граф (пара P1): масса нетто 2886 кг ушла в цену и сумму.
  const shifted = {
    docNumber: '10626044499',
    docDate: '2026-09-21',
    totalSum: 2886,
    vatSum: null,
    pricing: 'printed',
    supplier: { inn: ROCKWOOL, kpp: null, name: 'ООО "РОКВУЛ"' },
    confidence: 0.9,
    items: [
      {
        rowNo: 1,
        nameRaw: 'ВЕНТИ БАТТС Н 1000х600х100 (20 ПАЧ/ПАЛ) Плита минераловатная',
        unit: 'м2',
        qty: null,
        qtyPerPlace: 60,
        places: 13,
        massNetKg: 3152.5,
        price: 2886,
        sum: 2886,
        vatRate: null,
        vatSum: null,
      },
    ],
  } as unknown as UpdPdfParsed;

  it('обнуляет деньги строк и документа, ставит pricing = absent', () => {
    const { parsed, cleared } = clearTorg12Money(shifted);
    expect(parsed.totalSum).toBeNull();
    expect(parsed.vatSum).toBeNull();
    expect(parsed.pricing).toBe('absent');
    expect(parsed.items[0]).toMatchObject({ price: null, sum: null, vatRate: null, vatSum: null });
    expect(cleared).toEqual([
      { row: 1, field: 'price', value: 2886 },
      { row: 1, field: 'sum', value: 2886 },
      { row: null, field: 'totalSum', value: 2886 },
    ]);
  });

  it('не трогает номер, стороны, наименование и графы 7/8', () => {
    const { parsed } = clearTorg12Money(shifted);
    expect(parsed.docNumber).toBe('10626044499');
    expect(parsed.supplier).toEqual(shifted.supplier);
    expect(parsed.items[0]).toMatchObject({
      nameRaw: shifted.items[0]!.nameRaw,
      unit: 'м2',
      qtyPerPlace: 60,
      places: 13,
      massNetKg: 3152.5,
    });
  });

  it('без денег — пустой список обнулённого, исходный объект не меняется', () => {
    const clean = clearTorg12Money(shifted).parsed;
    expect(clearTorg12Money(clean).cleared).toEqual([]);
    // Чистая функция: исходный ответ модели остаётся для следа как был.
    expect(shifted.items[0]!.price).toBe(2886);
    expect(shifted.totalSum).toBe(2886);
  });
});
