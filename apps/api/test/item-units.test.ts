import { describe, expect, it, vi } from 'vitest';
import {
  decideUnitsFromDocument,
  documentItemIdsForUnits,
  resolveItemUnits,
  type DocumentItemUnit,
} from '../src/domain/operations/item-units.js';
import type { ItemOrigin } from '../src/domain/operations/item-origin.js';

const DOC_A = '11111111-1111-4111-8111-111111111111';
const DOC_B = '22222222-2222-4222-8222-222222222222';
const ITEM_A1 = 'aaaaaaa1-1111-4111-8111-111111111111';
const ITEM_B1 = 'bbbbbbb1-1111-4111-8111-111111111111';

const origin = (over: Partial<ItemOrigin> = {}): ItemOrigin => ({
  sourceDocumentId: DOC_A,
  sourceDocumentItemId: ITEM_A1,
  ...over,
});

const docItem = (over: Partial<DocumentItemUnit> = {}): DocumentItemUnit => ({
  id: ITEM_A1,
  sourceDocumentId: DOC_A,
  unit: 'м³',
  ...over,
});

describe('resolveItemUnits', () => {
  it('возвращает единицу документа, когда клиент прислал «шт»', () => {
    // Ровно случай 14289: в документе «м³», планшет прислал «шт».
    const decisions = resolveItemUnits({
      incoming: [{ unit: 'шт' }],
      origins: [origin()],
      documentItems: [docItem()],
      linkedDocumentIds: [DOC_A],
    });

    expect(decisions).toEqual([
      { index: 0, unit: 'м³', incomingUnit: 'шт', sourceDocumentItemId: ITEM_A1 },
    ]);
  });

  it('не трогает осознанно выбранную единицу', () => {
    const decisions = resolveItemUnits({
      incoming: [{ unit: 'кг' }],
      origins: [origin()],
      documentItems: [docItem()],
      linkedDocumentIds: [DOC_A],
    });

    expect(decisions).toEqual([]);
  });

  it('молчит, когда в документе тоже «шт»', () => {
    const decisions = resolveItemUnits({
      incoming: [{ unit: 'шт' }],
      origins: [origin()],
      documentItems: [docItem({ unit: 'шт' })],
      linkedDocumentIds: [DOC_A],
    });

    expect(decisions).toEqual([]);
  });

  it('не трогает строку без привязки', () => {
    const decisions = resolveItemUnits({
      incoming: [{ unit: 'шт' }],
      origins: [{ sourceDocumentId: null, sourceDocumentItemId: null }],
      documentItems: [docItem()],
      linkedDocumentIds: [DOC_A],
    });

    expect(decisions).toEqual([]);
  });

  it('не берёт строку чужого документа: два FK согласованность не гарантируют', () => {
    // Происхождение указывает на DOC_A, а строка принадлежит DOC_B.
    const decisions = resolveItemUnits({
      incoming: [{ unit: 'шт' }],
      origins: [origin({ sourceDocumentItemId: ITEM_B1 })],
      documentItems: [docItem({ id: ITEM_B1, sourceDocumentId: DOC_B })],
      linkedDocumentIds: [DOC_A, DOC_B],
    });

    expect(decisions).toEqual([]);
  });

  it('не берёт единицу из отвязанного документа', () => {
    const decisions = resolveItemUnits({
      incoming: [{ unit: 'шт' }],
      origins: [origin()],
      documentItems: [docItem()],
      linkedDocumentIds: [],
    });

    expect(decisions).toEqual([]);
  });

  it('игнорирует пустую единицу документа', () => {
    const decisions = resolveItemUnits({
      incoming: [{ unit: 'шт' }],
      origins: [origin()],
      documentItems: [docItem({ unit: '  ' })],
      linkedDocumentIds: [DOC_A],
    });

    expect(decisions).toEqual([]);
  });

  it('сравнивает единицы без оглядки на регистр и пробелы', () => {
    const decisions = resolveItemUnits({
      incoming: [{ unit: ' ШТ ' }],
      origins: [origin()],
      documentItems: [docItem({ unit: ' пог. м ' })],
      linkedDocumentIds: [DOC_A],
    });

    expect(decisions[0]).toMatchObject({ unit: 'пог. м' });
  });

  it('разбирает список позиций, трогая только подходящие', () => {
    const decisions = resolveItemUnits({
      incoming: [{ unit: 'шт' }, { unit: 'м' }, { unit: 'шт' }],
      origins: [
        origin(),
        origin({ sourceDocumentItemId: ITEM_B1, sourceDocumentId: DOC_B }),
        { sourceDocumentId: null, sourceDocumentItemId: null },
      ],
      documentItems: [docItem(), docItem({ id: ITEM_B1, sourceDocumentId: DOC_B, unit: 'м' })],
      linkedDocumentIds: [DOC_A, DOC_B],
    });

    expect(decisions.map((d) => d.index)).toEqual([0]);
  });
});

describe('documentItemIdsForUnits', () => {
  it('просит только строки, которые могут понадобиться', () => {
    const ids = documentItemIdsForUnits({
      incoming: [{ unit: 'шт' }, { unit: 'кг' }],
      origins: [origin(), origin({ sourceDocumentItemId: ITEM_B1 })],
    });

    expect(ids).toEqual([ITEM_A1]);
  });

  it('пустой список, когда «шт» никто не присылал — запроса к БД не будет', () => {
    const ids = documentItemIdsForUnits({
      incoming: [{ unit: 'м' }],
      origins: [origin()],
    });

    expect(ids).toEqual([]);
  });
});

describe('decideUnitsFromDocument', () => {
  const load = (rows: DocumentItemUnit[]) => {
    const fn = vi.fn(async () => rows);
    return fn;
  };

  it('в режиме off не ходит в базу и ничего не решает', async () => {
    const loadDocumentItems = load([docItem()]);

    const decisions = await decideUnitsFromDocument({
      mode: 'off',
      incoming: [{ unit: 'шт' }],
      origins: [origin()],
      linkedDocumentIds: [DOC_A],
      loadDocumentItems,
    });

    expect(decisions).toEqual([]);
    expect(loadDocumentItems).not.toHaveBeenCalled();
  });

  it('не ходит в базу, когда «шт» никто не присылал', async () => {
    const loadDocumentItems = load([docItem()]);

    const decisions = await decideUnitsFromDocument({
      mode: 'on',
      incoming: [{ unit: 'м' }],
      origins: [origin()],
      linkedDocumentIds: [DOC_A],
      loadDocumentItems,
    });

    expect(decisions).toEqual([]);
    expect(loadDocumentItems).not.toHaveBeenCalled();
  });

  it('в shadow считает так же, как в on: решение одно, применяет его вызывающий', async () => {
    const loadDocumentItems = load([docItem()]);

    const shadow = await decideUnitsFromDocument({
      mode: 'shadow',
      incoming: [{ unit: 'шт' }],
      origins: [origin()],
      linkedDocumentIds: [DOC_A],
      loadDocumentItems,
    });
    const on = await decideUnitsFromDocument({
      mode: 'on',
      incoming: [{ unit: 'шт' }],
      origins: [origin()],
      linkedDocumentIds: [DOC_A],
      loadDocumentItems,
    });

    expect(shadow).toEqual(on);
    expect(shadow[0]).toMatchObject({ unit: 'м³' });
  });

  it('запрашивает только нужные строки документа', async () => {
    const loadDocumentItems = load([docItem()]);

    await decideUnitsFromDocument({
      mode: 'on',
      incoming: [{ unit: 'шт' }, { unit: 'кг' }],
      origins: [origin(), origin({ sourceDocumentItemId: ITEM_B1 })],
      linkedDocumentIds: [DOC_A],
      loadDocumentItems,
    });

    expect(loadDocumentItems).toHaveBeenCalledWith([ITEM_A1]);
  });
});
