import { describe, expect, it } from 'vitest';
import {
  compareCopyByRowNo,
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
  over: {
    rowNo?: number | null;
    price?: string | null;
    unit?: string | null;
    qtyRead?: string | null;
  } = {},
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

  describe('правило ×1000 обработало экземпляры по-разному', () => {
    // Экземпляр продавца: правка применена (74, прочитано 74000). Экземпляр
    // покупателя — один из двух вариантов ниже. В обоих строка одна и та же.
    const fixed = item('a1', 'Клапан обратный', '74', '111456.08', {
      price: '1234.56',
      qtyRead: '74000',
    });

    it.each([
      ['модель прочла второй экземпляр верно', '74'],
      ['правка у второго экземпляра заблокирована', '74000'],
    ])('%s — строка не задваивается', (_label, otherQty) => {
      const [action] = planAssemblyDocumentMerges([
        base('first', [fixed]),
        base('copy', [item('b1', 'Клапан обратный', otherQty, '111456.08', { price: '1234.56' })]),
      ]);
      expect(action).toMatchObject({ relation: 'copies', itemIds: ['a1'] });
    });

    it('без следа правки 74 и 74000 — разные строки, как и раньше', () => {
      const [action] = planAssemblyDocumentMerges([
        base('first', [item('a1', 'Клапан обратный', '74', '111456.08', { price: '1234.56' })]),
        base('copy', [
          item('b1', 'Клапан обратный', '74000', '111456.08', { price: '1234.56' }),
        ]),
      ]);
      expect(action?.itemIds).toEqual(['a1', 'b1']);
    });
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

describe('копии по номеру позиции (copyByRowNo)', () => {
  // Форма № 5146 (19.10): УПД без цен, 66 строк. 64 из них — «Окно Rehau …»,
  // различаются только хвостом номера заказа; строки 62 и 63 — единственные
  // непохожие. Оба экземпляра (с печатью и без) прочитаны полностью.
  const windows = (prefix: string): AssemblyMergeDocument['items'] =>
    Array.from({ length: 66 }, (_, i) => {
      const rowNo = i + 1;
      if (rowNo === 62) return item(`${prefix}${rowNo}`, 'Соединительный профиль Н-образный', '24', null, { rowNo, unit: 'шт' });
      if (rowNo === 63) return item(`${prefix}${rowNo}`, 'Упаковка (WDW02194800\\66)', '1', null, { rowNo, unit: 'шт' });
      return item(
        `${prefix}${rowNo}`,
        `Окно Rehau Original Intelio (Фурнитура Рехау Dynamics Basic) (WDW02194800\\${rowNo})`,
        '1',
        null,
        { rowNo, unit: 'шт' },
      );
    });
  const pair = () => [base('stamp', windows('a')), base('plain', windows('b'))];

  it('без рубильника экземпляр дописывается целиком — характеризация дефекта', () => {
    const [action] = planAssemblyDocumentMerges(pair());
    expect(action?.relation).toBe('copies');
    expect(action?.itemIds).toHaveLength(130);
  });

  it('с рубильником остаётся одна строка на номер позиции', () => {
    const [action] = planAssemblyDocumentMerges(pair(), { copyByRowNo: true });
    expect(action?.relation).toBe('copies');
    expect(action?.itemIds).toEqual(windows('a').map((i) => i.id));
    expect(action?.reasons[0]).toMatch(/строки по номеру позиции/);
  });

  it('расхождение OCR в числах при том же номере не даёт второй строки', () => {
    const docs = () => [
      base('stamp', [
        item('a1', 'Кабель ВВГнг 3х1,5', '100', '5000.00', { rowNo: 1, price: '50.00' }),
        item('a2', 'Лоток 100х50', '10', '3000.00', { rowNo: 2, price: '300.00' }),
      ]),
      base('plain', [
        item('b1', 'Кабель ВВГнг 3х1,5', '100', '5000.00', { rowNo: 1, price: '50.00' }),
        item('b2', 'Лоток 100х50', '10', '3800.00', { rowNo: 2, price: '380.00' }),
      ]),
    ];
    expect(planAssemblyDocumentMerges(docs())[0]?.itemIds).toEqual(['a1', 'a2', 'b2']);
    expect(planAssemblyDocumentMerges(docs(), { copyByRowNo: true })[0]?.itemIds).toEqual([
      'a1',
      'a2',
    ]);
  });

  it('обрезанный экземпляр дополняется недостающими номерами без повторов', () => {
    // Первый ответ модели по одному экземпляру: строки 1, 62, 63.
    const full = windows('b');
    const truncated = windows('a').filter((i) => [1, 62, 63].includes(i.rowNo!));
    const [action] = planAssemblyDocumentMerges([base('stamp', truncated), base('plain', full)], {
      copyByRowNo: true,
    });
    expect(action?.itemIds).toHaveLength(66);
    expect(action?.itemIds.slice(0, 3)).toEqual(['a1', 'a62', 'a63']);
    expect(action?.itemIds).not.toContain('b1');
    expect(action?.itemIds).toContain('b2');
  });

  it('третий экземпляр не повторяет то, чем второй дополнил keeper', () => {
    const rows = (prefix: string, nos: number[]) =>
      nos.map((n) => item(`${prefix}${n}`, `Позиция ${n}`, '1', null, { rowNo: n }));
    const [action] = planAssemblyDocumentMerges(
      [base('k', rows('a', [1, 2])), base('c1', rows('b', [1, 2, 3, 4])), base('c2', rows('c', [1, 2, 3, 4]))],
      { copyByRowNo: true },
    );
    expect(action?.itemIds).toEqual(['a1', 'a2', 'b3', 'b4']);
  });

  it.each([
    [
      'части с продолжающимися номерами',
      [
        base('first', [item('a1', 'Кабель', '10', '1000', { rowNo: 1 }), item('a2', 'Лоток', '3', '300', { rowNo: 2 })]),
        base('tail', [item('b1', 'Труба', '5', '500', { rowNo: 3 }), item('b2', 'Муфта', '7', '70', { rowNo: 4 })]),
      ],
    ],
    [
      'номер есть не у всех строк',
      [
        base('first', [item('a1', 'Кабель', '10', '1000', { rowNo: 1 }), item('a2', 'Лоток', '3', '300', { rowNo: null })]),
        base('copy', [item('b1', 'Кабель', '10', '1000', { rowNo: 1 }), item('b2', 'Лоток', '3', '310', { rowNo: 2 })]),
      ],
    ],
    [
      'номер повторяется внутри экземпляра',
      [
        base('first', [item('a1', 'Кабель', '10', '1000', { rowNo: 1 }), item('a2', 'Лоток', '3', '300', { rowNo: 2 })]),
        base('copy', [item('b1', 'Кабель', '10', '1000', { rowNo: 1 }), item('b2', 'Лоток', '3', '310', { rowNo: 1 })]),
      ],
    ],
    [
      'номеров нет вовсе (неоднозначное сопоставление)',
      [
        base('first', [item('a1', 'Труба 20х2', '5', '500.00'), item('a2', 'Труба 20х2 ', '5', '500.00')]),
        base('copy', [item('b1', 'Труба 20х2', '5', '500.00')]),
      ],
    ],
  ])('%s — результат прежний', (_name, documents) => {
    expect(planAssemblyDocumentMerges(documents, { copyByRowNo: true })).toEqual(
      planAssemblyDocumentMerges(documents),
    );
  });

  it('сравнение для улики: строки и повторы номера по обоим правилам', () => {
    const documents = pair();
    const before = planAssemblyDocumentMerges(documents);
    const after = planAssemblyDocumentMerges(documents, { copyByRowNo: true });
    expect(compareCopyByRowNo(documents, before, after)).toEqual([
      expect.objectContaining({
        keeperId: 'stamp',
        droppedDocumentIds: ['plain'],
        relation: 'copies',
        itemsBefore: 130,
        itemsAfter: 66,
        repeatedRowNosBefore: 64,
        repeatedRowNosAfter: 0,
      }),
    ]);
  });
});
