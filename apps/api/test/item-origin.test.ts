import { describe, expect, it } from 'vitest';
import {
  resolveItemOrigins,
  type ExistingItemRow,
  type IncomingItem,
} from '../src/domain/operations/item-origin.js';

const DOC_A = '11111111-1111-4111-8111-111111111111';
const DOC_B = '22222222-2222-4222-8222-222222222222';
const ITEM_A1 = 'aaaaaaa1-1111-4111-8111-111111111111';
const ITEM_A2 = 'aaaaaaa2-1111-4111-8111-111111111111';

function existing(over: Partial<ExistingItemRow> & { id: string }): ExistingItemRow {
  return {
    nameRaw: 'Арматура А500С 12мм',
    unit: 'т',
    lineNo: 1,
    sourceDocumentId: DOC_A,
    sourceDocumentItemId: ITEM_A1,
    ...over,
  };
}

function incoming(over: Partial<IncomingItem> = {}): IncomingItem {
  return { nameRaw: 'Арматура А500С 12мм', unit: 'т', lineNo: 1, ...over };
}

describe('resolveItemOrigins', () => {
  it('сохраняет происхождение строки, найденной по id, даже когда клиент его не прислал', () => {
    const rows = [existing({ id: 'row-1' })];

    const [origin] = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ id: 'row-1' })],
      linkedDocumentIds: [DOC_A],
    });

    expect(origin).toEqual({ sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 });
  });

  it('игнорирует попытку клиента переписать происхождение существующей строки', () => {
    const rows = [existing({ id: 'row-1' })];

    const [origin] = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ id: 'row-1', sourceDocumentId: DOC_B, sourceDocumentItemId: null })],
      linkedDocumentIds: [DOC_A, DOC_B],
    });

    expect(origin).toEqual({ sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 });
  });

  it('сохраняет происхождение отвязанного документа', () => {
    // Документа больше нет в linkedDocumentIds — связь сняли, но откуда
    // приехала строка, мы по-прежнему знаем.
    const rows = [existing({ id: 'row-1' })];

    const [origin] = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ id: 'row-1' })],
      linkedDocumentIds: [],
    });

    expect(origin).toEqual({ sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 });
  });

  it('новая строка получает присланное происхождение, если документ привязан', () => {
    const [origin] = resolveItemOrigins({
      existing: [],
      incoming: [incoming({ sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 })],
      linkedDocumentIds: [DOC_A],
    });

    expect(origin).toEqual({ sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 });
  });

  it('отбрасывает происхождение из документа, не привязанного к приёмке', () => {
    const [origin] = resolveItemOrigins({
      existing: [],
      incoming: [incoming({ sourceDocumentId: DOC_B })],
      linkedDocumentIds: [DOC_A],
    });

    expect(origin).toEqual({ sourceDocumentId: null, sourceDocumentItemId: null });
  });

  it('строка, внесённая руками, остаётся без происхождения', () => {
    const [origin] = resolveItemOrigins({
      existing: [],
      incoming: [incoming({ nameRaw: 'Ветошь' })],
      linkedDocumentIds: [DOC_A],
    });

    expect(origin).toEqual({ sourceDocumentId: null, sourceDocumentItemId: null });
  });

  it('наследует происхождение по названию и номеру строки, когда id потерян', () => {
    const rows = [existing({ id: 'row-1' })];

    const [origin] = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ id: undefined, nameRaw: '  арматура   а500с 12ММ ' })],
      linkedDocumentIds: [DOC_A],
    });

    expect(origin).toEqual({ sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 });
  });

  it('не угадывает, когда одинаковых строк несколько', () => {
    // Две одинаковые позиции из разных УПД на одном номере строки — ровно тот
    // случай, где сопоставление по названию соврало бы.
    const rows = [
      existing({ id: 'row-1', sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 }),
      existing({ id: 'row-2', sourceDocumentId: DOC_B, sourceDocumentItemId: ITEM_A2 }),
    ];

    const origins = resolveItemOrigins({
      existing: rows,
      incoming: [incoming(), incoming()],
      linkedDocumentIds: [DOC_A, DOC_B],
    });

    expect(origins).toEqual([
      { sourceDocumentId: null, sourceDocumentItemId: null },
      { sourceDocumentId: null, sourceDocumentItemId: null },
    ]);
  });

  it('не отдаёт одно происхождение двум строкам', () => {
    const rows = [existing({ id: 'row-1' })];

    const origins = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ id: 'row-1' }), incoming()],
      linkedDocumentIds: [DOC_A],
    });

    expect(origins[0]).toEqual({ sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 });
    expect(origins[1]).toEqual({ sourceDocumentId: null, sourceDocumentItemId: null });
  });

  it('различает строки по номеру: разные позиции одного названия не путаются', () => {
    const rows = [
      existing({ id: 'row-1', lineNo: 1, sourceDocumentItemId: ITEM_A1 }),
      existing({ id: 'row-2', lineNo: 2, sourceDocumentItemId: ITEM_A2 }),
    ];

    const origins = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ lineNo: 2 }), incoming({ lineNo: 1 })],
      linkedDocumentIds: [DOC_A],
    });

    expect(origins[0]?.sourceDocumentItemId).toBe(ITEM_A2);
    expect(origins[1]?.sourceDocumentItemId).toBe(ITEM_A1);
  });

  it('порядок результата совпадает с порядком входа', () => {
    const rows = [existing({ id: 'row-1', nameRaw: 'Первая' })];

    const origins = resolveItemOrigins({
      existing: rows,
      incoming: [
        incoming({ nameRaw: 'Другая' }),
        incoming({ id: 'row-1', nameRaw: 'Первая' }),
        incoming({ nameRaw: 'Третья', sourceDocumentId: DOC_A }),
      ],
      linkedDocumentIds: [DOC_A],
    });

    expect(origins).toHaveLength(3);
    expect(origins[0]).toEqual({ sourceDocumentId: null, sourceDocumentItemId: null });
    expect(origins[1]?.sourceDocumentId).toBe(DOC_A);
    expect(origins[2]).toEqual({ sourceDocumentId: DOC_A, sourceDocumentItemId: null });
  });
});
