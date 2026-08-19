import { describe, expect, it } from 'vitest';
import {
  planAssemblyDocumentMerges,
  type AssemblyMergeDocument,
} from '../src/domain/edo/upd-assembly-merge.js';

const base = (
  id: string,
  items: AssemblyMergeDocument['items'],
  over: Partial<AssemblyMergeDocument> = {},
): AssemblyMergeDocument => ({
  id,
  supplierDirectoryId: 'supplier-1',
  docNumber: 'УПД-100',
  docDate: '2026-08-17',
  items,
  ...over,
});

const item = (id: string, nameRaw: string, qty: string, sum: string | null) => ({
  id,
  nameRaw,
  qty,
  sum,
});

describe('склейка распознанных сегментов одной УПД', () => {
  it('одиночный документ и разные реквизиты остаются no-op', () => {
    const actions = planAssemblyDocumentMerges([
      base('a', [item('a1', 'Цемент', '1', '100')]),
      base('b', [item('b1', 'Песок', '1', '200')], { docNumber: 'УПД-101' }),
      base('c', [item('c1', 'Щебень', '1', '300')], { supplierDirectoryId: null }),
    ]);
    expect(actions).toEqual([]);
  });

  it('полные копии страниц сворачиваются в первый сегмент без дубля строки', () => {
    const [action] = planAssemblyDocumentMerges([
      base('first', [item('a1', 'Плита ПК', '2.0000', '1000.00')]),
      base('copy', [item('b1', '  плита   пк ', '2', '1000')]),
    ]);
    expect(action).toEqual({
      keeperId: 'first',
      documentIds: ['first', 'copy'],
      droppedDocumentIds: ['copy'],
      itemIds: ['a1'],
      identicalItems: true,
    });
  });

  it('разные части объединяют позиции и дедуплицируют пересечение', () => {
    const [action] = planAssemblyDocumentMerges([
      base('first', [item('a1', 'Арматура 12', '7', '700'), item('a2', 'Цемент М500', '6', '600')]),
      base('continuation', [
        item('b1', 'Цемент М500', '6.0000', '600.00'),
        item('b2', 'Песок', '1', '100'),
      ]),
    ]);
    expect(action?.itemIds).toEqual(['a1', 'a2', 'b2']);
    expect(action?.identicalItems).toBe(false);
  });

  it('совпадение реквизитов из другой даты или другого поставщика не склеивает', () => {
    const actions = planAssemblyDocumentMerges([
      base('a', [item('a1', 'Цемент', '1', '100')]),
      base('b', [item('b1', 'Цемент', '1', '100')], { docDate: '2026-08-18' }),
      base('c', [item('c1', 'Цемент', '1', '100')], {
        supplierDirectoryId: 'supplier-2',
      }),
    ]);
    expect(actions).toEqual([]);
  });
});
