import { describe, expect, it } from 'vitest';
import {
  computeEdoSummary,
  docNumberPairKey,
  type EdoSummaryInput,
  type ItemMoneyInput,
  type ScanDocumentInput,
} from '../src/domain/operations/edo-effective-totals.js';

const SCAN_A = '00000000-0000-4000-8000-00000000000a';
const SCAN_B = '00000000-0000-4000-8000-00000000000b';

function edo(over: Partial<EdoSummaryInput> & { matchId: string }): EdoSummaryInput {
  return {
    source: 'export',
    documentId: `doc-${over.matchId}`,
    operator: 'sbis',
    docNumber: '14622014',
    docDate: '2026-11-16',
    totalSum: 15963.82,
    vatSum: 2878.72,
    sectionDocumentId: null,
    deliveryCount: 1,
    ...over,
  };
}

function scan(over: Partial<ScanDocumentInput> & { id: string }): ScanDocumentInput {
  return {
    kind: 'upd',
    docNumber: '22735030 / SX',
    docDate: '2026-11-16',
    totalSum: '15963.82',
    linked: true,
    ...over,
  };
}

function item(
  sourceDocumentId: string | null,
  qty: string,
  price: string | null,
  vat: string | null,
): ItemMoneyInput {
  return { sourceDocumentId, qtyActual: qty, qtyPlanned: null, price, vatSum: vat };
}

/** Строки факта 25495: 4 позиции, без НДС 13 085,10, НДС 2 878,72. */
const ITEMS_25495 = [
  item(SCAN_A, '2', '2900', '1276.00'),
  item(SCAN_A, '1', '2736.40', '602.01'),
  item(SCAN_A, '1', '1041.42', '229.11'),
  item(SCAN_A, '2', '1753.64', '771.60'),
];

describe('computeEdoSummary', () => {
  it('без УПД из ЭДО — null: шапка и список считают как раньше', () => {
    expect(
      computeEdoSummary({ edo: [], documents: [scan({ id: SCAN_A })], items: ITEMS_25495 }),
    ).toBeNull();
  });

  it('1 скан + 1 УПД в блоке: пара по блоку, суммы из ЭДО', () => {
    const s = computeEdoSummary({
      edo: [
        edo({ matchId: 'm1', sectionDocumentId: SCAN_A, totalSum: 2323906.09, vatSum: 419065.53 }),
      ],
      documents: [scan({ id: SCAN_A, totalSum: '156336.00' })],
      items: [item(SCAN_A, '1', '156335.40', null)],
    })!;
    expect(s.documents[0]).toMatchObject({
      pairedSourceDocumentId: SCAN_A,
      pairedBy: 'section',
      replacesFact: true,
    });
    expect(s.header).toMatchObject({ total: 2323906.09, known: 1, count: 1, source: 'edo' });
    expect(s.header.comparison).toEqual({ edo: 2323906.09, scan: 156336, mismatch: true });
    expect(s.list).toMatchObject({
      exVat: 1904840.56,
      vat: 419065.53,
      source: 'edo',
      factExVat: null,
    });
    expect(s.unpairedLinkedDocumentIds).toEqual([]);
    expect(s.ambiguous).toBe(false);
  });

  it('25495: связь «к приёмке целиком», номера разные, итог и дата совпали → пара', () => {
    const s = computeEdoSummary({
      edo: [edo({ matchId: 'm1' })],
      documents: [scan({ id: SCAN_A })],
      items: ITEMS_25495,
    })!;
    expect(s.documents[0]).toMatchObject({ pairedSourceDocumentId: SCAN_A, pairedBy: 'sum_date' });
    expect(s.header).toMatchObject({ total: 15963.82, source: 'edo' });
    expect(s.header.comparison).toEqual({ edo: 15963.82, scan: 15963.82, mismatch: false });
    expect(s.list).toMatchObject({ exVat: 13085.1, vat: 2878.72, source: 'edo' });
  });

  it('пара по номеру — без разделителей и ведущих нулей', () => {
    expect(docNumberPairKey('001029-01')).toBe(docNumberPairKey('1029-01'));
    expect(docNumberPairKey('1116-1')).toBe(docNumberPairKey('1116-01'));
    expect(docNumberPairKey('№ 201/21128161')).toBe(docNumberPairKey('201 21128161'));
    expect(docNumberPairKey('б/н')).toBeNull();
    const s = computeEdoSummary({
      edo: [edo({ matchId: 'm1', docNumber: '001023-06', totalSum: 933726.32 })],
      documents: [scan({ id: SCAN_A, docNumber: '1023-06', totalSum: '765349.44' })],
      items: [],
    })!;
    expect(s.documents[0]).toMatchObject({ pairedSourceDocumentId: SCAN_A, pairedBy: 'number' });
  });

  it('A + B, скан A отвязан со строками: ЭДО A заменяет строки A, B остаётся в сумме', () => {
    const s = computeEdoSummary({
      // unlink-source обнулил блок — связь стала «к приёмке целиком».
      edo: [edo({ matchId: 'mA', docNumber: '100', totalSum: 1220, vatSum: 220 })],
      documents: [
        scan({ id: SCAN_A, docNumber: '100', totalSum: '1220.00', linked: false }),
        scan({ id: SCAN_B, docNumber: '200', totalSum: '2440.00' }),
      ],
      items: [item(SCAN_A, '1', '1000', '220'), item(SCAN_B, '1', '2000', '440')],
    })!;
    expect(s.documents[0]).toMatchObject({ pairedSourceDocumentId: SCAN_A, pairedBy: 'number' });
    expect(s.unpairedLinkedDocumentIds).toEqual([SCAN_B]);
    expect(s.header).toMatchObject({ total: 3660, known: 2, count: 2, source: 'mixed' });
    // Отвязанный скан с итогом не сверяется: человек его уже убрал.
    expect(s.header.comparison).toBeNull();
    expect(s.list).toMatchObject({
      exVat: 3000,
      vat: 660,
      source: 'mixed',
      edoExVat: 1000,
      factExVat: 2000,
    });
    expect(s.ambiguous).toBe(false);
  });

  it('то же, строки A удалены: ЭДО A без пары, B в сумме, ambiguous', () => {
    const s = computeEdoSummary({
      edo: [edo({ matchId: 'mA', docNumber: '100', totalSum: 1220, vatSum: 220 })],
      documents: [scan({ id: SCAN_B, docNumber: '200', totalSum: '2440.00' })],
      items: [item(SCAN_B, '1', '2000', '440')],
    })!;
    expect(s.documents[0]).toMatchObject({
      pairedSourceDocumentId: null,
      pairedBy: null,
      replacesFact: true,
    });
    expect(s.header.total).toBe(3660);
    expect(s.list).toMatchObject({ exVat: 3000, vat: 660, source: 'mixed' });
    expect(s.ambiguous).toBe(true);
  });

  it('два кандидата с равным итогом и датой — пары нет', () => {
    const s = computeEdoSummary({
      edo: [edo({ matchId: 'm1', docNumber: '999' })],
      documents: [scan({ id: SCAN_A, docNumber: '1' }), scan({ id: SCAN_B, docNumber: '2' })],
      items: [],
    })!;
    expect(s.documents[0]!.pairedSourceDocumentId).toBeNull();
    expect(s.ambiguous).toBe(true);
  });

  it('пара по номеру имеет приоритет над парой по итогу у соседней УПД', () => {
    const s = computeEdoSummary({
      edo: [
        // Первая подходит к A по итогу и дате, вторая — к A по номеру.
        edo({ matchId: 'm1', docNumber: '555', totalSum: 100, vatSum: 18 }),
        edo({ matchId: 'm2', docNumber: '777', totalSum: 900, vatSum: 150 }),
      ],
      documents: [scan({ id: SCAN_A, docNumber: '777', totalSum: '100.00' })],
      items: [],
    })!;
    expect(s.documents.map((d) => d.pairedBy)).toEqual([null, 'number']);
  });

  it('ЭДО без скана: сравнения нет, ручные строки без цены сумму не меняют', () => {
    const s = computeEdoSummary({
      edo: [
        edo({ matchId: 'm1', totalSum: 2650, vatSum: 477.87 }),
        edo({ matchId: 'm2', totalSum: 20628, vatSum: 3719.8 }),
      ],
      documents: [],
      items: [item(null, '3', null, null)],
    })!;
    expect(s.header).toMatchObject({
      total: 23278,
      known: 2,
      count: 2,
      source: 'edo',
      comparison: null,
    });
    expect(s.list).toMatchObject({ exVat: 19080.33, vat: 4197.67, source: 'edo' });
    expect(s.ambiguous).toBe(false);
  });

  it('ручная строка с ценой → «ЭДО + факт»', () => {
    const s = computeEdoSummary({
      edo: [edo({ matchId: 'm1', totalSum: 1220, vatSum: 220 })],
      documents: [],
      items: [item(null, '2', '50', '22')],
    })!;
    expect(s.list).toMatchObject({
      exVat: 1100,
      vat: 242,
      source: 'mixed',
      edoExVat: 1000,
      factExVat: 100,
    });
  });

  it('НДС у УПД неизвестен: в списке группа на факте, в шапке итог из ЭДО', () => {
    const s = computeEdoSummary({
      edo: [edo({ matchId: 'm1', sectionDocumentId: SCAN_A, vatSum: null })],
      documents: [scan({ id: SCAN_A })],
      items: ITEMS_25495,
    })!;
    expect(s.header.total).toBe(15963.82);
    expect(s.documents[0]!.replacesFact).toBe(false);
    expect(s.list.source).toBe('fact');
    expect(s.list.exVat).toBeCloseTo(13085.1, 6);
    expect(s.list.edoMissing).toBe(1);
  });

  it('итог УПД неизвестен — «указана у k из n», а не ноль', () => {
    const s = computeEdoSummary({
      edo: [
        edo({ matchId: 'm1', totalSum: null, vatSum: null }),
        edo({ matchId: 'm2', docNumber: '2', totalSum: 100, vatSum: 20 }),
      ],
      documents: [],
      items: [],
    })!;
    expect(s.header).toMatchObject({ total: 100, known: 1, count: 2 });
  });

  it('накладная в блоке ЭДО: пара по блоку, сравнения нет (не УПД)', () => {
    const s = computeEdoSummary({
      edo: [edo({ matchId: 'm1', sectionDocumentId: SCAN_A })],
      documents: [scan({ id: SCAN_A, kind: 'transport_waybill', totalSum: '1.00' })],
      items: [],
    })!;
    expect(s.documents[0]!.pairedBy).toBe('section');
    expect(s.header.comparison).toBeNull();
  });

  it('расхождение: копейка — округление, две — пометка', () => {
    const at = (scanTotal: string) =>
      computeEdoSummary({
        edo: [edo({ matchId: 'm1', sectionDocumentId: SCAN_A, totalSum: 100 })],
        documents: [scan({ id: SCAN_A, totalSum: scanTotal })],
        items: [],
      })!.header.comparison!.mismatch;
    expect(at('100.01')).toBe(false);
    expect(at('100.02')).toBe(true);
  });

  it('УПД на 3 приёмки — sharedMax', () => {
    const s = computeEdoSummary({
      edo: [edo({ matchId: 'm1', deliveryCount: 3 })],
      documents: [],
      items: [],
    })!;
    expect(s.sharedMax).toBe(3);
  });

  it('накладная без суммы не делает подпись «смешанной»', () => {
    const s = computeEdoSummary({
      edo: [edo({ matchId: 'm1', sectionDocumentId: SCAN_A })],
      documents: [
        scan({ id: SCAN_A }),
        scan({ id: SCAN_B, kind: 'transport_waybill', totalSum: null }),
      ],
      items: [],
    })!;
    expect(s.header).toMatchObject({ source: 'edo', known: 1, count: 2 });
  });
});
