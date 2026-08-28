/**
 * Сводка документов операции: порядок и разделение linked/упомянутых.
 *
 * Чистая функция — проверяем без БД. Важное здесь не форматирование, а два
 * инварианта, на которых держится карточка: связанные идут первыми и ровно в
 * порядке sourceDocumentIds (иначе разъедется с primarySourceDocument), а
 * отвязанный документ не исчезает — по нему подписан блок материалов.
 */
import { describe, expect, it } from 'vitest';
import {
  buildOperationSourceDocuments,
  type SourceDocumentSummaryRow,
} from '../src/domain/operations/source-document-summary.js';

const row = (
  id: string,
  over: Partial<SourceDocumentSummaryRow> = {},
): SourceDocumentSummaryRow => ({
  id,
  kind: 'upd',
  status: 'parsed',
  docNumber: `№${id}`,
  docDate: new Date('2026-08-26T00:00:00.000Z'),
  expectedDate: null,
  totalSum: '100.00',
  vatSum: null,
  ...over,
});

describe('buildOperationSourceDocuments', () => {
  it('связанные идут первыми и в порядке sourceDocumentIds', () => {
    const out = buildOperationSourceDocuments({
      rows: [row('b'), row('a'), row('c')],
      linkedIds: ['b', 'a'],
      mentionedIds: ['b', 'a', 'c'],
    });

    expect(out.map((d) => d.id)).toEqual(['b', 'a', 'c']);
    expect(out.map((d) => d.linked)).toEqual([true, true, false]);
  });

  it('дата приводится к YYYY-MM-DD — карточка печатает значение как есть', () => {
    const [doc] = buildOperationSourceDocuments({
      rows: [row('a', { expectedDate: new Date('2026-08-28T00:00:00.000Z') })],
      linkedIds: ['a'],
      mentionedIds: ['a'],
    });

    expect(doc!.docDate).toBe('2026-08-26');
    expect(doc!.expectedDate).toBe('2026-08-28');
  });

  it('отвязанные сортируются по дате, номеру и id — порядок стабилен', () => {
    const out = buildOperationSourceDocuments({
      rows: [
        row('x', { docDate: null, docNumber: 'Я-1' }),
        row('y', { docDate: new Date('2026-08-27T00:00:00.000Z'), docNumber: 'Б-1' }),
        row('z', { docDate: new Date('2026-08-26T00:00:00.000Z'), docNumber: 'В-1' }),
      ],
      linkedIds: [],
      mentionedIds: ['x', 'y', 'z'],
    });

    // Документ без даты — последним: NULLS LAST, как в SQL-сортировках рядом.
    expect(out.map((d) => d.id)).toEqual(['z', 'y', 'x']);
  });

  it('документ без строки в выборке пропускается, а не роняет сборку', () => {
    const out = buildOperationSourceDocuments({
      rows: [row('a')],
      linkedIds: ['a', 'ghost'],
      mentionedIds: ['a', 'ghost'],
    });

    expect(out.map((d) => d.id)).toEqual(['a']);
  });

  it('операция без документов даёт пустой массив', () => {
    expect(buildOperationSourceDocuments({ rows: [], linkedIds: [], mentionedIds: [] })).toEqual(
      [],
    );
  });
});
