import { describe, expect, it } from 'vitest';
import {
  planUnlinkedRestores,
  type DocumentItemRow,
  type UnlinkedItemRow,
} from '../src/domain/operations/unlinked-item-restore.js';

function item(over: Partial<UnlinkedItemRow> & { itemId: string }): UnlinkedItemRow {
  return { nameRaw: 'ЦПС-С5', unit: 'шт', qty: '22.0000', ...over };
}

function docItem(over: Partial<DocumentItemRow> & { itemId: string }): DocumentItemRow {
  return { nameRaw: 'ЦПС-С5', unit: 'м³', qty: '22.0000', ...over };
}

describe('planUnlinkedRestores', () => {
  it('восстанавливает привязку при единственном совпадении названия', () => {
    // Боевой случай 14289: единица расходится, название совпадает дословно.
    const plan = planUnlinkedRestores({
      unlinked: [item({ itemId: 'row-1' })],
      documentItems: [docItem({ itemId: 'doc-1' })],
    });

    expect(plan.manual).toEqual([]);
    expect(plan.restore).toEqual([
      {
        itemId: 'row-1',
        sourceDocumentItemId: 'doc-1',
        nameRaw: 'ЦПС-С5',
        unitDiffers: true,
        qtyDiffers: false,
      },
    ]);
  });

  it('не считает расхождением разную запись одного количества', () => {
    const plan = planUnlinkedRestores({
      unlinked: [item({ itemId: 'row-1', qty: '22' })],
      documentItems: [docItem({ itemId: 'doc-1', qty: '22.0000' })],
    });

    expect(plan.restore[0]!.qtyDiffers).toBe(false);
  });

  it('отмечает расхождение количества, не отказываясь от привязки', () => {
    const plan = planUnlinkedRestores({
      unlinked: [item({ itemId: 'row-1', qty: '20' })],
      documentItems: [docItem({ itemId: 'doc-1', qty: '22' })],
    });

    expect(plan.restore).toHaveLength(1);
    expect(plan.restore[0]!.qtyDiffers).toBe(true);
  });

  it('сопоставляет названия, различающиеся регистром и пробелами', () => {
    const plan = planUnlinkedRestores({
      unlinked: [item({ itemId: 'row-1', nameRaw: '  цпс-с5  ' })],
      documentItems: [docItem({ itemId: 'doc-1', nameRaw: 'ЦПС-С5' })],
    });

    expect(plan.restore).toHaveLength(1);
  });

  it('уводит в ручной разбор две одинаковые строки документа', () => {
    const plan = planUnlinkedRestores({
      unlinked: [item({ itemId: 'row-1' })],
      documentItems: [docItem({ itemId: 'doc-1' }), docItem({ itemId: 'doc-2' })],
    });

    expect(plan.restore).toEqual([]);
    expect(plan.manual).toEqual([{ itemId: 'row-1', nameRaw: 'ЦПС-С5', reason: 'ambiguous' }]);
  });

  it('уводит в ручной разбор две одинаковые строки приёмки', () => {
    const plan = planUnlinkedRestores({
      unlinked: [item({ itemId: 'row-1' }), item({ itemId: 'row-2' })],
      documentItems: [docItem({ itemId: 'doc-1' })],
    });

    expect(plan.restore).toEqual([]);
    expect(plan.manual.map((m) => m.reason)).toEqual(['ambiguous', 'ambiguous']);
  });

  it('строку, которой в документе нет, оставляет без привязки', () => {
    const plan = planUnlinkedRestores({
      unlinked: [item({ itemId: 'row-1', nameRaw: 'Ветошь' })],
      documentItems: [docItem({ itemId: 'doc-1' })],
    });

    expect(plan.restore).toEqual([]);
    expect(plan.manual).toEqual([{ itemId: 'row-1', nameRaw: 'Ветошь', reason: 'no_match' }]);
  });

  it('разбирает несколько разных позиций разом', () => {
    const plan = planUnlinkedRestores({
      unlinked: [
        item({ itemId: 'row-1', nameRaw: 'Анкер' }),
        item({ itemId: 'row-2', nameRaw: 'Гайка' }),
        item({ itemId: 'row-3', nameRaw: 'Ветошь' }),
      ],
      documentItems: [
        docItem({ itemId: 'doc-1', nameRaw: 'Анкер' }),
        docItem({ itemId: 'doc-2', nameRaw: 'Гайка' }),
      ],
    });

    expect(plan.restore.map((r) => [r.itemId, r.sourceDocumentItemId])).toEqual([
      ['row-1', 'doc-1'],
      ['row-2', 'doc-2'],
    ]);
    expect(plan.manual).toEqual([{ itemId: 'row-3', nameRaw: 'Ветошь', reason: 'no_match' }]);
  });
});
