/**
 * Relaxed-проход: фрагмент с чужой датой присоединяется к своей УПД.
 *
 * Основной случай взят с боя как есть — приёмка 13776, пакет
 * a29e2812…, номер 201/21126719-1 одного поставщика:
 *
 *   39c2a981  2026-09-04  итог 23 404,53  строки 1 и 2
 *   44fed8d2  2026-09-04  итог  8 177,00  строка 1        → строгая склейка
 *   a2f049d0  2025-11-25  итог 23 404,53  строка 2        → оставался отдельным
 *
 * Третий документ публиковался вторым, привязывался к той же приёмке, и
 * «Соединитель пруток — полоса, 80х80» учитывался дважды: 47 шт превращались в
 * 94, лишние 12 482 ₽.
 *
 * Обратите внимание, чего тесты НЕ разрешают: склейки двух одиночек между
 * собой, присоединения при нескольких подходящих группах и при неполном
 * вложении строк. Каждый из этих случаев — отказ, а не «лучше, чем ничего».
 */
import { describe, expect, it } from 'vitest';
import {
  planAssemblyDocumentMerges,
  type AssemblyMergeAction,
  type AssemblyMergeDocument,
} from '../src/domain/edo/upd-assembly-merge.js';
import {
  applyRelaxedJoins,
  assertDisjointActions,
  planRelaxedCopyJoins,
  type AssemblyRelaxedMode,
} from '../src/domain/edo/upd-assembly-relaxed.js';

const doc = (
  id: string,
  items: AssemblyMergeDocument['items'],
  over: Partial<AssemblyMergeDocument> = {},
): AssemblyMergeDocument => ({
  id,
  supplierDirectoryId: 'supplier-1',
  docNumber: '201/21126719-1',
  docDate: '2026-09-04',
  declaredTotal: '23404.53',
  items,
  ...over,
});

const item = (
  id: string,
  nameRaw: string,
  qty: string,
  sum: string,
  over: Partial<AssemblyMergeDocument['items'][number]> = {},
) => ({ id, nameRaw, qty, sum, unit: 'шт', vatRate: '22.00', ...over });

/** Строки боевого документа 13776. */
const ZAZHIM = (id: string) =>
  item(id, 'Зажим фальцевый', '17.0000', '8177.00', {
    rowNo: 1,
    price: '394.2600',
    vatSum: '1474.54',
  });
const SOEDINITEL = (id: string, nameRaw = 'Соединитель пруток - полоса, 80х80 мм') =>
  item(id, nameRaw, '47.0000', '15227.53', {
    rowNo: 2,
    price: '265.5700',
    vatSum: '2745.95',
  });

/** Боевая конфигурация 13776: строгая пара плюс обрезок с датой на год мимо. */
function bundle13776(): AssemblyMergeDocument[] {
  return [
    doc('39c2a981', [ZAZHIM('i-1'), SOEDINITEL('i-2')]),
    doc('44fed8d2', [ZAZHIM('i-3')], { declaredTotal: '8177.00' }),
    doc('a2f049d0', [SOEDINITEL('i-4')], { docDate: '2025-11-25' }),
  ];
}

function plan(documents: AssemblyMergeDocument[], mode: AssemblyRelaxedMode) {
  const strict = planAssemblyDocumentMerges(documents);
  const report = planRelaxedCopyJoins(documents, strict, mode);
  return { strict, report, actions: applyRelaxedJoins(strict, report) };
}

describe('relaxed-склейка: фрагмент с чужой датой', () => {
  it('приёмка 13776: обрезок присоединяется к своей УПД и отдельным документом не публикуется', () => {
    const { actions, report } = plan(bundle13776(), 'on');

    expect(report.joins).toEqual([
      {
        singleId: 'a2f049d0',
        keeperId: '39c2a981',
        matchedItems: 1,
        reason: expect.stringContaining('разошлась дата'),
      },
    ]);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      keeperId: '39c2a981',
      documentIds: ['39c2a981', '44fed8d2', 'a2f049d0'],
      droppedDocumentIds: ['44fed8d2', 'a2f049d0'],
      relaxedDocumentIds: ['a2f049d0'],
    });
    // Главное: строка обрезка НЕ дописывается к keeper — она уже там.
    // Иначе «Соединитель» снова оказался бы в приёмке дважды.
    expect(actions[0]?.itemIds).toEqual(['i-1', 'i-2']);
  });

  it('keeper остаётся представителем строгой группы — с верной датой', () => {
    // Дата и шапка берутся от keeper. Отдай мы keeper обрезку, документ уехал
    // бы в приёмку с датой 2025-11-25 при верных строках.
    const { actions } = plan(bundle13776(), 'on');
    expect(actions[0]?.keeperId).toBe('39c2a981');
    expect(actions[0]?.relation).toBe(planAssemblyDocumentMerges(bundle13776())[0]?.relation);
  });

  it('строки, itemIds и relation строгой группы не меняются от присоединения', () => {
    // Relaxed дополняет действие, а не строит своё: второе действие на ту же
    // группу тихо изменило бы keeper, relation и итог.
    const strictOnly = planAssemblyDocumentMerges(bundle13776());
    const { actions } = plan(bundle13776(), 'on');
    expect(actions[0]?.itemIds).toEqual(strictOnly[0]?.itemIds);
    expect(actions[0]?.identicalItems).toBe(strictOnly[0]?.identicalItems);
    expect(actions[0]?.relation).toBe(strictOnly[0]?.relation);
  });
});

describe('relaxed-склейка: границы правила', () => {
  it('другой поставщик — отказ: один номер у разных поставщиков законен', () => {
    const documents = bundle13776();
    documents[2] = doc('a2f049d0', [SOEDINITEL('i-4')], {
      docDate: '2025-11-25',
      supplierDirectoryId: 'supplier-2',
    });
    const { report, actions } = plan(documents, 'on');
    expect(report.joins).toEqual([]);
    expect(actions[0]?.documentIds).toEqual(['39c2a981', '44fed8d2']);
  });

  it('документ без поставщика в справочнике в проход не идёт', () => {
    const documents = bundle13776();
    documents[2] = doc('a2f049d0', [SOEDINITEL('i-4')], {
      docDate: '2025-11-25',
      supplierDirectoryId: null,
    });
    const { report } = plan(documents, 'on');
    expect(report.joins).toEqual([]);
    expect(report.rejected).toContainEqual({
      documentId: 'a2f049d0',
      reason: 'нет поставщика или номера',
    });
  });

  it('другой итог — отказ', () => {
    const documents = bundle13776();
    documents[2] = doc('a2f049d0', [SOEDINITEL('i-4')], {
      docDate: '2025-11-25',
      declaredTotal: '15227.53',
    });
    const { report } = plan(documents, 'on');
    expect(report.joins).toEqual([]);
    expect(report.rejected).toContainEqual({
      documentId: 'a2f049d0',
      reason: 'подходящей строгой группы нет',
    });
  });

  it('нулевой итог не признак совпадения — отказ', () => {
    // Нулём отдаются документы без стоимостной части: по такому «итогу»
    // совпал бы кто угодно.
    const documents = [
      doc('keeper', [ZAZHIM('i-1')], { declaredTotal: '0' }),
      doc('twin', [ZAZHIM('i-3')], { declaredTotal: '0' }),
      doc('single', [ZAZHIM('i-4')], { docDate: '2025-11-25', declaredTotal: '0.00' }),
    ];
    const { report } = plan(documents, 'on');
    expect(report.joins).toEqual([]);
    expect(report.rejected).toContainEqual({
      documentId: 'single',
      reason: 'итог не прочитан или нулевой',
    });
  });

  it('строки вложены не полностью — отказ, документ остаётся отдельным', () => {
    const documents = bundle13776();
    documents[2] = doc(
      'a2f049d0',
      [SOEDINITEL('i-4'), item('i-5', 'Держатель проводника', '3', '900', { rowNo: 3 })],
      { docDate: '2025-11-25' },
    );
    const { report, actions } = plan(documents, 'on');
    expect(report.joins).toEqual([]);
    expect(report.rejected).toContainEqual({
      documentId: 'a2f049d0',
      reason: 'строки вложены не полностью (1 без пары)',
    });
    expect(actions[0]?.documentIds).not.toContain('a2f049d0');
  });

  it('неоднозначное сопоставление — отказ', () => {
    // В бланке позиция повторена дважды с теми же числами. Какой именно
    // строке соответствует единственная строка обрезка — неизвестно, и
    // сопоставлять наугад нельзя: ошибка здесь означает потерянную строку.
    const documents = [
      doc('keeper', [ZAZHIM('i-1'), SOEDINITEL('i-2'), SOEDINITEL('i-3')]),
      doc('twin', [ZAZHIM('i-4')], { declaredTotal: '8177.00' }),
      doc('single', [SOEDINITEL('i-5', 'Соединитель пруток — полоса, 80х80 мм')], {
        docDate: '2025-11-25',
      }),
    ];
    const { report } = plan(documents, 'on');
    expect(report.joins).toEqual([]);
    expect(report.rejected).toContainEqual({
      documentId: 'single',
      reason: 'сопоставление строк неоднозначно',
    });
  });

  it('разная ставка НДС при равной стоимости — не копия', () => {
    // Расширенный ключ отличает эти строки; ключ строгого прохода — нет.
    const documents = [
      doc('keeper', [ZAZHIM('i-1'), SOEDINITEL('i-2')]),
      doc('twin', [ZAZHIM('i-3')], { declaredTotal: '8177.00' }),
      doc('single', [SOEDINITEL('i-4')], { docDate: '2025-11-25' }),
    ];
    documents[2]!.items[0]!.vatRate = '10.00';
    documents[2]!.items[0]!.vatSum = '1384.32';
    const { report } = plan(documents, 'on');
    expect(report.joins).toEqual([]);
    expect(report.rejected).toContainEqual({
      documentId: 'single',
      reason: 'строки вложены не полностью (1 без пары)',
    });
  });

  it('подходящих групп несколько — отказ, а не «первая попавшаяся»', () => {
    // Жадный выбор присоединил бы фрагмент к чужому документу.
    const documents = [
      doc('keeper-a', [ZAZHIM('a1'), SOEDINITEL('a2')]),
      doc('twin-a', [ZAZHIM('a3')], { declaredTotal: '8177.00' }),
      doc('keeper-b', [ZAZHIM('b1'), SOEDINITEL('b2')]),
      doc('twin-b', [ZAZHIM('b3')], { declaredTotal: '8177.00' }),
      doc('single', [SOEDINITEL('s1')], { docDate: '2025-11-25' }),
    ];
    // Две строгие группы с одним номером различаются датой.
    documents[2]!.docDate = '2026-09-05';
    documents[3]!.docDate = '2026-09-05';
    const { report } = plan(documents, 'on');
    expect(report.joins).toEqual([]);
    expect(report.rejected).toContainEqual({
      documentId: 'single',
      reason: 'подходящих групп несколько',
    });
  });

  it('две одиночки между собой не склеиваются даже в «on» — только улика', () => {
    // У них нет независимого подтверждения, какая из двух дат верна.
    const documents = [
      doc('full', [ZAZHIM('i-1'), SOEDINITEL('i-2')]),
      doc('fragment', [SOEDINITEL('i-3')], { docDate: '2025-11-25' }),
    ];
    const { report, actions } = plan(documents, 'on');
    expect(actions).toEqual([]);
    expect(report.joins).toEqual([]);
    expect(report.singletonPairs).toEqual([
      { keeperId: 'full', otherId: 'fragment', reason: expect.stringContaining('две одиночки') },
    ]);
  });
});

describe('relaxed-склейка: режимы рубильника', () => {
  it('off — план в точности прежний, проход не считается вовсе', () => {
    const documents = bundle13776();
    const strict = planAssemblyDocumentMerges(documents);
    const report = planRelaxedCopyJoins(documents, strict, 'off');
    expect(report).toEqual({
      mode: 'off',
      joins: [],
      rejected: [],
      singletonPairs: [],
      documentsWouldJoin: 0,
    });
    expect(applyRelaxedJoins(strict, report)).toEqual(strict);
  });

  it('shadow — кандидат найден, но состав пакета не меняется', () => {
    const { strict, report, actions } = plan(bundle13776(), 'shadow');
    expect(report.documentsWouldJoin).toBe(1);
    expect(report.joins[0]?.singleId).toBe('a2f049d0');
    expect(actions).toEqual(strict);
    expect(actions[0]?.documentIds).toEqual(['39c2a981', '44fed8d2']);
  });

  it('документ, не признанный кандидатом, при «on» обрабатывается как при «off»', () => {
    const documents = bundle13776();
    documents[2] = doc('other', [item('x1', 'Кабель ВВГнг 3х2,5', '100', '25000')], {
      docNumber: '201/21126720-1',
      declaredTotal: '25000.00',
    });
    const off = plan(documents, 'off');
    const on = plan(documents, 'on');
    expect(on.actions).toEqual(off.actions);
  });
});

describe('инвариант непересечения действий', () => {
  it('каждый документ входит ровно в одно действие', () => {
    const { actions } = plan(bundle13776(), 'on');
    const ids = actions.flatMap((a) => a.documentIds);
    expect(new Set(ids).size).toBe(ids.length);
    expect(() => assertDisjointActions(actions)).not.toThrow();
  });

  it('пересечение действий — ошибка планировщика, а не тихая правка данных', () => {
    // worker применяет действия последовательно к одному снимку строк: два
    // действия на один документ дали бы двойное копирование и неверный
    // mergedInto. Лучше откатить сборку пакета целиком.
    const overlapping: AssemblyMergeAction[] = [
      {
        keeperId: 'a',
        documentIds: ['a', 'shared'],
        droppedDocumentIds: ['shared'],
        itemIds: [],
        identicalItems: false,
        relation: 'copies',
        reasons: [],
      },
      {
        keeperId: 'b',
        documentIds: ['b', 'shared'],
        droppedDocumentIds: ['shared'],
        itemIds: [],
        identicalItems: false,
        relation: 'copies',
        reasons: [],
      },
    ];
    expect(() => assertDisjointActions(overlapping)).toThrow(/два действия склейки/);
  });
});
