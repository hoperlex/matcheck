import { describe, expect, it } from 'vitest';
import {
  rankEdoAgainstReferences,
  rankEdoDocument,
  type MatchReference,
} from '../src/domain/operations/edo-match.js';

const reference: MatchReference = {
  numbers: ['Т26-1315-11'],
  dates: ['2026-10-09'],
  supplierInn: '7701234567',
  supplierName: 'Поставщик',
  sums: ['127297.50'],
  itemNames: ['Арматура А500'],
  arrivedDate: '2026-10-09',
};

describe('EDO document matching', () => {
  it('recognizes punctuation and Cyrillic/Latin lookalikes in the number', () => {
    const result = rankEdoDocument(reference, {
      docNumber: 'T26 1315/11',
      docDate: '2026-10-09',
      supplierInn: '7701234567',
      supplierName: 'Другое название',
      totalSum: '127297,50',
      itemNames: ['Арматура А500'],
    });
    expect(result.level).toBe('high');
    expect(result.conflicts).toEqual([]);
  });

  it('does not call a date-only hit a reliable match', () => {
    const result = rankEdoDocument(reference, {
      docNumber: 'Иной номер',
      docDate: '2026-10-09',
      supplierInn: '7800000000',
      supplierName: 'Другой',
      totalSum: '500',
      itemNames: ['Песок'],
    });
    expect(result.level).not.toBe('high');
    expect(result.conflicts).toContain('ИНН поставщика отличается');
  });

  it('requires review when the supplier INN differs despite matching number and sum', () => {
    const result = rankEdoDocument(reference, {
      docNumber: 'Т26-1315-11',
      docDate: '2026-10-09',
      supplierInn: '7800000000',
      supplierName: 'Поставщик',
      totalSum: '127297.50',
      itemNames: ['Арматура А500'],
    });
    expect(result.level).toBe('possible');
    expect(result.conflicts).toContain('ИНН поставщика отличается');
  });

  it('reports missing evidence without inventing a match', () => {
    const result = rankEdoDocument(
      { ...reference, numbers: [], sums: [], itemNames: [] },
      {
        docNumber: null,
        docDate: '2026-10-09',
        supplierInn: null,
        supplierName: null,
        totalSum: null,
        itemNames: [],
      },
    );
    expect(result.missing).toContain('номер УПД');
    expect(result.level).toBe('weak');
  });

  it('compares each paper UPD separately in a multi-document delivery', () => {
    const result = rankEdoAgainstReferences(
      [
        { ...reference, paperDocNumber: 'Т26-1315-11' },
        {
          ...reference,
          paperDocNumber: 'А-22',
          numbers: ['А-22'],
          sums: ['500.00'],
          itemNames: ['Песок'],
        },
      ],
      {
        docNumber: 'A-22',
        docDate: '2026-10-09',
        supplierInn: '7701234567',
        supplierName: 'Поставщик',
        totalSum: '500.00',
        itemNames: ['Песок'],
      },
    );
    expect(result.paperDocNumber).toBe('А-22');
    expect(result.level).toBe('high');
  });
});
