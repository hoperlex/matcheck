import { describe, expect, it } from 'vitest';
import type { LinkedEdoItem, LinkedEdoItemsResult } from '../src/domain/edo/linked-edo-items.js';
import {
  computeEdoSummary,
  type ItemMoneyInput,
} from '../src/domain/operations/edo-effective-totals.js';
import { edoLinesKey, planExportLines } from '../src/domain/operations/edo-export-lines.js';

const SCAN_A = '00000000-0000-4000-8000-00000000000a';

type Item = ItemMoneyInput & { name: string };

const items: Item[] = [
  {
    name: 'факт скана',
    sourceDocumentId: SCAN_A,
    qtyActual: '1',
    qtyPlanned: null,
    price: '100',
    vatSum: '22',
  },
  {
    name: 'ручная',
    sourceDocumentId: null,
    qtyActual: '2',
    qtyPlanned: null,
    price: '50',
    vatSum: '22',
  },
];

function edoLine(name: string): LinkedEdoItem {
  return {
    position: 0,
    lineNo: 1,
    nameRaw: name,
    qty: 1,
    unit: 'шт',
    unitCode: null,
    price: 1000,
    sumExVat: 1000,
    vatRate: 22,
    vatSum: 220,
    sum: 1220,
    itemKind: 1,
    productCode: null,
  };
}

const summary = computeEdoSummary({
  edo: [
    {
      matchId: 'm1',
      source: 'export',
      documentId: 'd1',
      operator: 'sbis',
      docNumber: '1',
      docDate: '2026-11-16',
      totalSum: 1220,
      vatSum: 220,
      sectionDocumentId: SCAN_A,
      deliveryCount: 1,
    },
  ],
  documents: [
    {
      id: SCAN_A,
      kind: 'upd',
      docNumber: '1',
      docDate: '2026-11-16',
      totalSum: '122.00',
      linked: true,
    },
  ],
  items,
})!;
const key = edoLinesKey({ source: 'export', documentId: 'd1' });

describe('planExportLines', () => {
  it('строки УПД вместо факта пары, затем остаток факта', () => {
    const ready: LinkedEdoItemsResult = {
      state: 'ready',
      totals: null,
      reasons: [],
      items: [edoLine('из XML')],
    };
    const lines = planExportLines(summary, items, new Map([[key, ready]]));
    expect(
      lines.map((l) =>
        l.kind === 'edo'
          ? `edo:${l.item.nameRaw}`
          : l.kind === 'fact'
            ? `fact:${l.item.name}`
            : l.kind,
      ),
    ).toEqual(['edo:из XML', 'fact:ручная']);
    // Итог строки приёмки — как в списке, и сумма строк под ним с ним сходится.
    expect(summary.list.exVat).toBe(1000 + 100);
  });

  it('УПД не прочиталась — на её месте факт пары с причиной', () => {
    const failed: LinkedEdoItemsResult = {
      state: 'storage_failed',
      totals: null,
      reasons: [],
      items: [],
    };
    const lines = planExportLines(summary, items, new Map([[key, failed]]));
    expect(lines).toEqual([
      {
        kind: 'fact',
        item: items[0],
        note: 'строки ЭДО не прочитаны: файл не получен из хранилища',
      },
      { kind: 'fact', item: items[1], note: null },
    ]);
  });

  it('УПД без пары не прочиталась — строка-пометка вместо пустоты', () => {
    const lonely = computeEdoSummary({
      edo: [{ ...summary.documents[0]!, sectionDocumentId: null, docNumber: '9', docDate: null }],
      documents: [],
      items: [],
    })!;
    const lines = planExportLines(lonely, [], new Map());
    expect(lines).toEqual([
      { kind: 'edo_missing', doc: lonely.documents[0], reason: 'файл не прочитан' },
    ]);
  });
});
