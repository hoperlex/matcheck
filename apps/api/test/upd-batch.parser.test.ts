import { describe, it, expect } from 'vitest';
import type { PageClassification, PageType } from '../src/domain/edo/upd-page-prefilter.js';
import type { UpdPdfParsed } from '@matcheck/contracts';
import {
  segmentUpdPages,
  aggregateUpdDocuments,
  type ParsedUpdSubdocument,
} from '../src/domain/edo/upd-batch.parser.js';

// ─── helpers ───
function cls(page: number, type: PageType, use = true): PageClassification {
  return { page, type, use };
}

// Валидный УПД-субдокумент: суммы сходятся, одна позиция.
function sub(over: Partial<ParsedUpdSubdocument> = {}): ParsedUpdSubdocument {
  const base: UpdPdfParsed = {
    docNumber: '487',
    docDate: '2026-06-24',
    totalSum: 100,
    vatSum: 18,
    itemsCount: 1,
    supplier: { inn: '1', kpp: '2', name: 'S' },
    recipient: { inn: '3', kpp: '4', name: 'R' },
    items: [
      {
        nameRaw: 'X',
        qty: 1,
        unit: 'шт',
        price: 82,
        sum: 100,
        vatRate: 22,
        vatSum: 18,
        volumeM3: null,
        massKg: null,
        volumeConfidence: null,
        groupName: null,
      },
    ],
    confidence: 0.9,
  };
  return { ...base, pages: [1], segmentIndex: 0, ...over };
}

describe('segmentUpdPages', () => {
  it('4× upd_main → 4 сегмента по одной странице (normal)', () => {
    const segs = segmentUpdPages([
      cls(1, 'upd_main'),
      cls(2, 'upd_main'),
      cls(3, 'upd_main'),
      cls(4, 'upd_main'),
    ]);
    expect(segs).toHaveLength(4);
    expect(segs.map((s) => s.pages)).toEqual([[1], [2], [3], [4]]);
    expect(segs.every((s) => s.confidence === 'normal')).toBe(true);
    expect(segs.map((s) => s.segmentIndex)).toEqual([0, 1, 2, 3]);
  });

  it('1 длинный УПД (main + 2 continuation) → один сегмент [1,2,3]', () => {
    const segs = segmentUpdPages([
      cls(1, 'upd_main'),
      cls(2, 'upd_continuation'),
      cls(3, 'upd_continuation'),
    ]);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.pages).toEqual([1, 2, 3]);
    expect(segs[0]!.confidence).toBe('normal');
  });

  it('mixed: main, continuation, main → 2 сегмента [1,2] и [3]', () => {
    const segs = segmentUpdPages([
      cls(1, 'upd_main'),
      cls(2, 'upd_continuation'),
      cls(3, 'upd_main'),
    ]);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.pages).toEqual([1, 2]);
    expect(segs[1]!.pages).toEqual([3]);
  });

  it('первая страница other (selected) → fallback-группа, страница не потеряна', () => {
    const segs = segmentUpdPages([cls(1, 'other'), cls(2, 'upd_main')]);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.pages).toEqual([1]);
    expect(segs[0]!.confidence).toBe('fallback');
    expect(segs[1]!.pages).toEqual([2]);
    // ни одна выбранная страница не пропала
    expect(segs.flatMap((s) => s.pages)).toEqual([1, 2]);
  });

  it('continuation без предшествующего main → защитная fallback-группа', () => {
    const segs = segmentUpdPages([cls(1, 'upd_continuation'), cls(2, 'upd_main')]);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.confidence).toBe('fallback');
    expect(segs[0]!.reasons).toContain('continuation_without_main');
  });

  it('certificate / transport_waybill с use=false → не попадают в сегменты', () => {
    const segs = segmentUpdPages([
      cls(1, 'upd_main', true),
      cls(2, 'certificate', false),
      cls(3, 'transport_waybill', false),
    ]);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.pages).toEqual([1]);
  });

  it('selectedPages содержит страницу, которой нет в классификации → сохраняем консервативно', () => {
    // page 2 не упомянута классификатором, но выбрана на extract.
    const segs = segmentUpdPages([cls(1, 'upd_main')], [1, 2]);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.pages).toEqual([1, 2]); // страница 2 не потеряна
    expect(segs[0]!.confidence).toBe('uncertain');
    expect(segs[0]!.reasons.some((r) => r.startsWith('attached_unknown_page'))).toBe(true);
  });

  it('неожиданная certificate-страница ВНУТРИ выбранных → uncertain, но не теряется', () => {
    const segs = segmentUpdPages(
      [cls(1, 'upd_main'), cls(2, 'certificate')],
      [1, 2],
    );
    expect(segs).toHaveLength(1);
    expect(segs[0]!.pages).toEqual([1, 2]);
    expect(segs[0]!.confidence).toBe('uncertain');
  });

  it('без selectedPages берёт страницы по use=true', () => {
    const segs = segmentUpdPages([
      cls(1, 'upd_main', true),
      cls(2, 'other', false),
      cls(3, 'upd_main', true),
    ]);
    expect(segs.flatMap((s) => s.pages)).toEqual([1, 3]);
  });
});

describe('aggregateUpdDocuments', () => {
  it('4 субдокумента → docNumber "487, 488, 489, 490"', () => {
    const docs = [
      sub({ docNumber: '487', pages: [1], segmentIndex: 0 }),
      sub({ docNumber: '488', pages: [2], segmentIndex: 1 }),
      sub({ docNumber: '489', pages: [3], segmentIndex: 2 }),
      sub({ docNumber: '490', pages: [4], segmentIndex: 3 }),
    ];
    const agg = aggregateUpdDocuments(docs);
    expect(agg.docNumber).toBe('487, 488, 489, 490');
    expect(agg.subdocs).toHaveLength(4);
  });

  it('totalSum/vatSum складываются по субдокументам', () => {
    const docs = [
      sub({ totalSum: 100, vatSum: 18, pages: [1] }),
      sub({ totalSum: 200, vatSum: 36, pages: [2] }),
    ];
    const agg = aggregateUpdDocuments(docs);
    expect(agg.totalSum).toBe(300);
    expect(agg.vatSum).toBe(54);
  });

  it('items объединяются, itemLineNos последовательны и по-субдокументно', () => {
    const a = sub({
      pages: [1],
      segmentIndex: 0,
      items: [
        { nameRaw: 'A1', qty: 1, unit: 'шт', price: 1, sum: 1, vatRate: 0, vatSum: 0, volumeM3: null, massKg: null, volumeConfidence: null, groupName: null },
        { nameRaw: 'A2', qty: 1, unit: 'шт', price: 1, sum: 1, vatRate: 0, vatSum: 0, volumeM3: null, massKg: null, volumeConfidence: null, groupName: null },
      ],
    });
    const b = sub({
      pages: [2],
      segmentIndex: 1,
      items: [
        { nameRaw: 'B1', qty: 1, unit: 'шт', price: 1, sum: 1, vatRate: 0, vatSum: 0, volumeM3: null, massKg: null, volumeConfidence: null, groupName: null },
      ],
    });
    const agg = aggregateUpdDocuments([a, b]);
    expect(agg.items.map((i) => i.nameRaw)).toEqual(['A1', 'A2', 'B1']);
    expect(agg.itemsCount).toBe(3);
    expect(agg.subdocs[0]!.itemLineNos).toEqual([1, 2]);
    expect(agg.subdocs[1]!.itemLineNos).toEqual([3]);
  });

  it('канонический порядок — по первой странице, не по входному порядку', () => {
    const agg = aggregateUpdDocuments([
      sub({ docNumber: '490', pages: [4], segmentIndex: 3 }),
      sub({ docNumber: '487', pages: [1], segmentIndex: 0 }),
      sub({ docNumber: '489', pages: [3], segmentIndex: 2 }),
      sub({ docNumber: '488', pages: [2], segmentIndex: 1 }),
    ]);
    expect(agg.docNumber).toBe('487, 488, 489, 490');
  });

  it('одинаковые даты/поставщики → общие, без reasons', () => {
    const agg = aggregateUpdDocuments([sub({ pages: [1] }), sub({ pages: [2] })]);
    expect(agg.docDate).toBe('2026-06-24');
    expect(agg.supplier).toEqual({ inn: '1', kpp: '2', name: 'S' });
    expect(agg.reasons).not.toContain('multiple_doc_dates');
    expect(agg.reasons).not.toContain('multiple_suppliers');
  });

  it('разные даты → первая по порядку страниц + reason multiple_doc_dates', () => {
    const agg = aggregateUpdDocuments([
      sub({ docDate: '2026-06-24', pages: [1] }),
      sub({ docDate: '2026-06-25', pages: [2] }),
    ]);
    expect(agg.docDate).toBe('2026-06-24');
    expect(agg.reasons).toContain('multiple_doc_dates');
  });

  it('разные поставщики → первый + reason multiple_suppliers (не падает)', () => {
    const agg = aggregateUpdDocuments([
      sub({ supplier: { inn: '1', kpp: '2', name: 'S1' }, pages: [1] }),
      sub({ supplier: { inn: '9', kpp: '9', name: 'S2' }, pages: [2] }),
    ]);
    expect(agg.supplier).toEqual({ inn: '1', kpp: '2', name: 'S1' });
    expect(agg.reasons).toContain('multiple_suppliers');
  });

  it('все totalSum/vatSum null → агрегат null, без NaN', () => {
    const agg = aggregateUpdDocuments([
      sub({ totalSum: null, vatSum: null, pages: [1] }),
      sub({ totalSum: null, vatSum: null, pages: [2] }),
    ]);
    expect(agg.totalSum).toBeNull();
    expect(agg.vatSum).toBeNull();
    expect(Number.isNaN(agg.totalSum as unknown as number)).toBe(false);
  });

  it('часть totalSum null → суммируются только non-null', () => {
    const agg = aggregateUpdDocuments([
      sub({ totalSum: 100, pages: [1] }),
      sub({ totalSum: null, pages: [2] }),
      sub({ totalSum: 50, pages: [3] }),
    ]);
    expect(agg.totalSum).toBe(150);
  });

  it('confidence — консервативно минимум по субдокументам', () => {
    const agg = aggregateUpdDocuments([
      sub({ confidence: 0.9, pages: [1] }),
      sub({ confidence: 0.6, pages: [2] }),
    ]);
    expect(agg.confidence).toBe(0.6);
  });

  it('пустой documents[] → бросает явную ошибку', () => {
    expect(() => aggregateUpdDocuments([])).toThrow(/пустой список/);
  });
});
