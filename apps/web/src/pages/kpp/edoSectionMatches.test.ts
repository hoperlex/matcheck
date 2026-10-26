/**
 * Куда в карточке встаёт привязанная УПД из ЭДО: в блок бумажного документа
 * или отдельно — ровно в одно место.
 */
import { describe, expect, it } from 'vitest';
import type { OperationSourceDocument } from '@matcheck/contracts';
import { edoMatchesForSection, edoMatchesWithoutSection } from './edoSectionMatches';
import type { LinkedEdoDocument } from './LinkedEdoChips';

const doc = (id: string, linked = true): OperationSourceDocument => ({
  id,
  kind: 'upd',
  status: 'parsed',
  docNumber: id,
  docDate: null,
  expectedDate: null,
  totalSum: null,
  vatSum: null,
  linked,
});

const match = (id: string, sectionDocumentId: string | null): LinkedEdoDocument => ({
  id,
  documentId: `reg-${id}`,
  source: 'export',
  docNumber: id,
  docDate: null,
  supplierName: null,
  supplierInn: null,
  totalSum: null,
  linkedAt: '2026-10-26T10:00:00Z',
  sectionDocumentId,
  alsoIn: [],
  alsoInCount: 0,
  operator: 'sbis',
});

describe('edoMatchesForSection / edoMatchesWithoutSection', () => {
  const documents = [doc('40765'), doc('41296'), doc('old', false)];
  const matches = [
    match('a', '40765'),
    match('b', '40765'),
    match('c', '41296'),
    match('whole', null),
    // Бумажная УПД отвязана, а список привязок ещё старый.
    match('stale', 'old'),
    // Блок, которого в карточке нет вовсе.
    match('gone', 'missing'),
  ];

  it('в блок связанного документа — его привязки', () => {
    expect(edoMatchesForSection(documents[0]!, matches).map((m) => m.id)).toEqual(['a', 'b']);
    expect(edoMatchesForSection(documents[1]!, matches).map((m) => m.id)).toEqual(['c']);
  });

  it('отвязанный блок с устаревшей привязкой таблицу ЭДО не получает', () => {
    expect(edoMatchesForSection(documents[2]!, matches)).toEqual([]);
    expect(edoMatchesForSection(null, matches)).toEqual([]);
  });

  it('без блока — привязка к приёмке, к отвязанному и к отсутствующему документу', () => {
    expect(edoMatchesWithoutSection(matches, documents).map((m) => m.id)).toEqual([
      'whole',
      'stale',
      'gone',
    ]);
  });

  it('каждая привязка — ровно в одном месте', () => {
    const placed = [
      ...documents.flatMap((d) => edoMatchesForSection(d, matches)),
      ...edoMatchesWithoutSection(matches, documents),
    ].map((m) => m.id);
    expect(placed.sort()).toEqual(matches.map((m) => m.id).sort());
  });
});
