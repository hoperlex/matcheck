import { describe, expect, it } from 'vitest';
import { buildItemSections, NO_DOCUMENT_SECTION_KEY } from './operationItemSections';
import type { OperationSourceDocument } from '@matcheck/contracts';

const doc = (id: string, over: Partial<OperationSourceDocument> = {}): OperationSourceDocument => ({
  id,
  kind: 'upd',
  status: 'parsed',
  docNumber: `№${id}`,
  docDate: '2026-08-26',
  expectedDate: null,
  totalSum: '100.00',
  vatSum: null,
  linked: true,
  ...over,
});

const row = (key: string, sourceDocumentId: string | null) => ({ key, sourceDocumentId });

describe('buildItemSections', () => {
  it('раскладывает строки по документам в порядке сводки', () => {
    const sections = buildItemSections({
      items: [row('a', 'd2'), row('b', 'd1'), row('c', 'd2')],
      documents: [doc('d1'), doc('d2')],
    });

    expect(sections.map((s) => s.key)).toEqual(['d1', 'd2']);
    expect(sections[0]!.items.map((i) => i.key)).toEqual(['b']);
    expect(sections[1]!.items.map((i) => i.key)).toEqual(['a', 'c']);
  });

  it('связанный документ без позиций даёт пустой блок, а не исчезает', () => {
    const sections = buildItemSections({
      items: [row('a', 'd1')],
      documents: [doc('d1'), doc('d2')],
    });

    expect(sections.map((s) => s.key)).toEqual(['d1', 'd2']);
    expect(sections[1]!.items).toEqual([]);
  });

  it('строка с документом вне сводки попадает в свой блок, а не пропадает', () => {
    // Так выглядит офлайн-снимок от /sync: поля sourceDocuments в нём нет.
    const sections = buildItemSections({
      items: [row('a', 'ghost'), row('b', null)],
      documents: [],
    });

    expect(sections.map((s) => s.key)).toEqual(['ghost', NO_DOCUMENT_SECTION_KEY]);
    expect(sections[0]!.unknownDocumentId).toBe('ghost');
    expect(sections[0]!.items.map((i) => i.key)).toEqual(['a']);
  });

  it('ни одна строка не теряется при любой комбинации', () => {
    const items = [
      row('a', 'd1'),
      row('b', null),
      row('c', 'ghost'),
      row('d', 'd2'),
      row('e', null),
    ];
    const sections = buildItemSections({
      items,
      documents: [doc('d1'), doc('d2', { linked: false })],
    });

    expect(sections.flatMap((s) => s.items)).toHaveLength(items.length);
    expect(sections.flatMap((s) => s.items.map((i) => i.key)).sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    // «Без привязки» — всегда последним, отвязанный документ остаётся блоком.
    expect(sections[sections.length - 1]!.key).toBe(NO_DOCUMENT_SECTION_KEY);
    expect(sections[1]!.document?.linked).toBe(false);
  });

  it('без документов и без строк остаётся один блок «без привязки»', () => {
    const sections = buildItemSections({ items: [], documents: [] });
    expect(sections).toHaveLength(1);
    expect(sections[0]!.key).toBe(NO_DOCUMENT_SECTION_KEY);
  });

  it('лишнего пустого блока «без привязки» не появляется', () => {
    const sections = buildItemSections({ items: [row('a', 'd1')], documents: [doc('d1')] });
    expect(sections.map((s) => s.key)).toEqual(['d1']);
  });
});
