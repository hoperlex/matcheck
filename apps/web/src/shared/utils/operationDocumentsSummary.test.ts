import { describe, expect, it } from 'vitest';
import {
  formatDocumentsShort,
  groupDocumentsByKind,
  summarizeDates,
  sumDocumentTotals,
} from './operationDocumentsSummary';
import type { OperationSourceDocument } from '@matcheck/contracts';

const doc = (over: Partial<OperationSourceDocument> = {}): OperationSourceDocument => ({
  id: over.id ?? 'd1',
  kind: 'upd',
  status: 'parsed',
  docNumber: '0000-0082603',
  docDate: '2026-08-26',
  expectedDate: '2026-08-28',
  totalSum: '747171.00',
  vatSum: null,
  linked: true,
  ...over,
});

describe('groupDocumentsByKind', () => {
  it('УПД и накладные — разные чипы, порядок первого появления сохраняется', () => {
    const groups = groupDocumentsByKind([
      doc({ id: 'a' }),
      doc({ id: 'b', kind: 'transport_waybill' }),
      doc({ id: 'c' }),
    ]);

    expect(groups.map((g) => g.kindLabel)).toEqual(['УПД', 'Накладная']);
    expect(groups[0]!.documents.map((d) => d.id)).toEqual(['a', 'c']);
  });
});

describe('summarizeDates', () => {
  it('совпадающие даты дают одно значение', () => {
    const out = summarizeDates([doc({ id: 'a' }), doc({ id: 'b' })], 'docDate');
    expect(out).toEqual({ text: '2026-08-26', known: 2, total: 2 });
  });

  it('разные даты дают диапазон', () => {
    const out = summarizeDates(
      [doc({ id: 'a', docDate: '2026-08-27' }), doc({ id: 'b', docDate: '2026-08-26' })],
      'docDate',
    );
    expect(out!.text).toBe('2026-08-26 — 2026-08-27');
  });

  it('дата не у всех — known меньше total, подмены нет', () => {
    const out = summarizeDates([doc({ id: 'a' }), doc({ id: 'b', docDate: null })], 'docDate');
    expect(out).toEqual({ text: '2026-08-26', known: 1, total: 2 });
  });

  it('даты нет ни у кого — сводки нет', () => {
    expect(summarizeDates([doc({ docDate: null })], 'docDate')).toBeNull();
  });
});

describe('sumDocumentTotals', () => {
  it('складывает суммы всех документов', () => {
    const out = sumDocumentTotals([
      doc({ id: 'a', totalSum: '747171.00' }),
      doc({ id: 'b', totalSum: '865655.00' }),
      doc({ id: 'c', totalSum: '776240.00' }),
      doc({ id: 'd', totalSum: '134590.00' }),
    ]);
    // Ровно приёмка 12586: четыре УПД одной поставки.
    expect(out).toEqual({ total: 2523656, known: 4, count: 4 });
  });

  it('копейки не накапливают ошибку', () => {
    const out = sumDocumentTotals([
      doc({ id: 'a', totalSum: '0.10' }),
      doc({ id: 'b', totalSum: '0.20' }),
    ]);
    expect(out!.total).toBe(0.3);
  });

  it('отсутствующая сумма не считается нулём — known меньше count', () => {
    const out = sumDocumentTotals([doc({ id: 'a' }), doc({ id: 'b', totalSum: null })]);
    expect(out).toEqual({ total: 747171, known: 1, count: 2 });
  });

  it('нет ни одной суммы — сводки нет', () => {
    expect(sumDocumentTotals([doc({ totalSum: null })])).toBeNull();
  });
});

describe('formatDocumentsShort', () => {
  it('один вид — ярлык отдельно, номера через запятую', () => {
    const out = formatDocumentsShort([
      doc({ id: 'a', docNumber: '0000-0082603' }),
      doc({ id: 'b', docNumber: '0000-0082604' }),
    ]);
    expect(out).toEqual({ kindLabel: 'УПД', numbers: '0000-0082603, 0000-0082604' });
  });

  it('разные виды — каждый номер со своим ярлыком', () => {
    const out = formatDocumentsShort([
      doc({ id: 'a', docNumber: '1' }),
      doc({ id: 'b', kind: 'transport_waybill', docNumber: 'ТН-7' }),
    ]);
    expect(out).toEqual({ kindLabel: null, numbers: 'УПД 1, Накладная ТН-7' });
  });

  it('документов нет — подписи нет', () => {
    expect(formatDocumentsShort([])).toEqual({ kindLabel: null, numbers: null });
  });
});
