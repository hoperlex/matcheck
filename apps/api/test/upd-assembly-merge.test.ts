import { describe, expect, it } from 'vitest';
import {
  dedupeAssemblyItems,
  planAssemblyDocumentMerges,
  planAssemblyDocumentMergesLegacy,
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

const item = (
  id: string,
  nameRaw: string,
  qty: string,
  sum: string | null,
  over: { rowNo?: number | null; price?: string | null; unit?: string | null } = {},
) => ({
  id,
  nameRaw,
  qty,
  sum,
  ...over,
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
    expect(action).toMatchObject({
      keeperId: 'first',
      documentIds: ['first', 'copy'],
      droppedDocumentIds: ['copy'],
      itemIds: ['a1'],
      identicalItems: true,
      relation: 'copies',
    });
  });

  it('расхождения OCR в наименовании больше не задваивают позиции', () => {
    // Боевой случай УПД 201/21127213-2: два экземпляра одного листа, модель
    // прочла тире по-разному. Прежний ключ дедупа включал текст как есть —
    // документ получал 4 позиции вместо 2 и итог 18 800 ₽ вместо 9 400 ₽.
    const [action] = planAssemblyDocumentMerges([
      base('first', [
        item('a1', 'Контактор модульный 2НО 20А 230В МК --103', '1', '1900.00'),
        item('a2', 'Контактор модульный 2НО 25А 230В МК --103', '5', '7500.00'),
      ]),
      base('copy', [
        item('b1', 'Контактор модульный 2НО 20А 230В МК-103', '1', '1900.00'),
        item('b2', 'Контактор модульный 2НО 25А 230В МК-103', '5', '7500.00'),
      ]),
    ]);
    expect(action?.itemIds).toEqual(['a1', 'a2']);
    expect(action?.relation).toBe('copies');
  });

  it('копия, потерявшая строку при сканировании, не отнимает её у комплекта', () => {
    // Взаимодополняющие пропуски: в первом скане нет «Песка», во втором —
    // «Цемента». Выбрать один документ целиком значило бы потерять позицию.
    const [action] = planAssemblyDocumentMerges([
      base('first', [item('a1', 'Арматура 12', '7', '700'), item('a2', 'Цемент М500', '6', '600')]),
      base('copy', [item('b1', 'Арматура 12', '7', '700'), item('b2', 'Песок', '1', '100')]),
    ]);
    expect(action?.itemIds).toEqual(['a1', 'a2', 'b2']);
  });

  it('напечатанные номера позиций отличают копию от продолжения', () => {
    const copies = planAssemblyDocumentMerges([
      base('first', [item('a1', 'Кабель', '10', '1000', { rowNo: 1 })]),
      base('copy', [item('b1', 'Кабель', '10', '1000', { rowNo: 1 })]),
    ]);
    expect(copies[0]?.relation).toBe('copies');

    const parts = planAssemblyDocumentMerges([
      base('first', [item('a1', 'Кабель', '10', '1000', { rowNo: 1 })]),
      base('tail', [item('b1', 'Лоток', '3', '300', { rowNo: 2 })]),
    ]);
    expect(parts[0]?.relation).toBe('parts');
    expect(parts[0]?.itemIds).toEqual(['a1', 'b1']);
  });

  it('две разные позиции с одинаковыми числами не схлопываются', () => {
    // Количество и сумма совпали до копейки, но это разные материалы —
    // склеивать их по числам нельзя.
    const [action] = planAssemblyDocumentMerges([
      base('first', [item('a1', 'Кабель ВВГнг 3х1,5', '100', '5000.00')]),
      base('other', [item('b1', 'Лоток лестничный 100х50', '100', '5000.00')]),
    ]);
    expect(action?.itemIds).toEqual(['a1', 'b1']);
    expect(action?.relation).toBe('parts');
  });

  it('неоднозначное сопоставление оставляет обе строки', () => {
    // У keeper две строки с одинаковыми числами и похожими названиями:
    // какой из них соответствует строка второго сегмента — неизвестно.
    const [action] = planAssemblyDocumentMerges([
      base('first', [
        item('a1', 'Труба 20х2', '5', '500.00'),
        item('a2', 'Труба 20х2 ', '5', '500.00'),
      ]),
      base('copy', [item('b1', 'Труба 20х2', '5', '500.00')]),
    ]);
    expect(action?.itemIds).toEqual(['a1', 'a2', 'b1']);
    expect(action?.relation).toBe('unknown');
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

describe('прежнее правило склейки (рубильник выключен)', () => {
  it('дедуплицирует по тексту наименования — то есть задваивает расхождения OCR', () => {
    // Характеризационный тест: фиксирует поведение, которое сегодня на бою.
    // Именно из-за него документ получал 4 позиции вместо 2. Тест не одобряет
    // это поведение, а стережёт обещание «выключенный рубильник = как раньше».
    const [action] = planAssemblyDocumentMergesLegacy([
      base('first', [item('a1', 'Контактор МК --103', '1', '1900.00')]),
      base('copy', [item('b1', 'Контактор МК-103', '1', '1900.00')]),
    ]);
    expect(action?.itemIds).toEqual(['a1', 'b1']);
    expect(action?.relation).toBe('unknown');
  });

  it('точное совпадение текста схлопывает строку, как и раньше', () => {
    const [action] = planAssemblyDocumentMergesLegacy([
      base('first', [item('a1', 'Плита ПК', '2.0000', '1000.00')]),
      base('copy', [item('b1', '  плита   пк ', '2', '1000')]),
    ]);
    expect(action?.itemIds).toEqual(['a1']);
    expect(action?.identicalItems).toBe(true);
  });
});

describe('схлопывание задвоенных строк внутри документа (починка боевых данных)', () => {
  it('убирает второй экземпляр, сохраняя порядок первого', () => {
    const { keep, drop } = dedupeAssemblyItems([
      item('a1', 'Контактор модульный 2НО 20А 230В МК --103', '1', '1900.00'),
      item('a2', 'Контактор модульный 2НО 25А 230В МК --103', '5', '7500.00'),
      item('b1', 'Контактор модульный 2НО 20А 230В МК-103', '1', '1900.00'),
      item('b2', 'Контактор модульный 2НО 25А 230В МК-103', '5', '7500.00'),
    ]);
    expect(keep.map((i) => i.id)).toEqual(['a1', 'a2']);
    expect(drop.map((i) => i.id)).toEqual(['b1', 'b2']);
  });

  it('честный повтор позиции в бланке переживает починку', () => {
    // В бланке позиция напечатана дважды, экземпляров два — строк четыре.
    // Слепое «оставить одну» съело бы настоящую строку документа.
    const { keep, drop } = dedupeAssemblyItems([
      item('a1', 'Плита ПК', '2', '1000.00'),
      item('a2', 'Плита ПК', '2', '1000.00'),
      item('b1', 'Плита ПК', '2', '1000.00'),
      item('b2', 'Плита ПК', '2', '1000.00'),
    ]);
    expect(keep.map((i) => i.id)).toEqual(['a1', 'a2']);
    expect(drop.map((i) => i.id)).toEqual(['b1', 'b2']);
  });

  it('нечётная группа округляется в пользу сохранения строки', () => {
    // Три строки при двух экземплярах: один скан позицию потерял. Оставляем
    // две — потерять настоящую строку хуже, чем оставить лишнюю.
    const { keep } = dedupeAssemblyItems([
      item('a1', 'Плита ПК', '2', '1000.00'),
      item('a2', 'Плита ПК', '2', '1000.00'),
      item('a3', 'Плита ПК', '2', '1000.00'),
    ]);
    expect(keep.map((i) => i.id)).toEqual(['a1', 'a2']);
  });

  it('разные позиции с одинаковыми числами остаются обе', () => {
    const { keep, drop } = dedupeAssemblyItems([
      item('a1', 'Кабель ВВГнг 3х1,5', '100', '5000.00'),
      item('a2', 'Лоток лестничный 100х50', '100', '5000.00'),
    ]);
    expect(keep.map((i) => i.id)).toEqual(['a1', 'a2']);
    expect(drop).toEqual([]);
  });
});
