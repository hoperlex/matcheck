/**
 * Правило, по которому строку приёмки признают задвоенной копией.
 *
 * По нему будут удалять строки из подтверждённых МОЛ приёмок, поэтому тесты
 * держат обе границы сразу: что задвоение находится и что при малейшем следе
 * ручной правки строка уходит человеку, а не под удаление.
 *
 * Фикстуры — боевые: 13776 (обрезок с чужой датой), 13731 и 14072 (у фрагментов
 * разошёлся поставщик, причём во втором случае документ приписан банку из
 * платёжных реквизитов).
 */
import { describe, expect, it } from 'vitest';
import {
  differingFields,
  documentGroupKey,
  findDuplicatePairs,
  looksLikeKpp,
  pairVerdict,
  pickSurvivor,
  type DuplicateCandidateRow,
} from '../src/domain/edo/duplicated-delivery-items.js';

const BUNDLE = 'bundle-1';
const SUPPLIER = 'supplier-1';

function row(over: Partial<DuplicateCandidateRow> = {}): DuplicateCandidateRow {
  return {
    id: 'item-1',
    line_no: 1,
    name_raw: 'Соединитель пруток - полоса, 80х80 мм',
    qty_actual: '47.0000',
    qty_planned: null,
    unit: 'шт',
    price: '265.5700',
    vat_rate: '22.00',
    vat_sum: '2745.95',
    material_id: null,
    item_kind: 'material',
    asset_id: null,
    inventory_number: null,
    serial_number: null,
    comment: null,
    volume_m3: null,
    mass_kg: null,
    volume_confidence: null,
    group_name: null,
    source_document_id: 'doc-full',
    source_document_item_id: 'sdi-1',
    bundle_id: BUNDLE,
    doc_number: '201/21126719-1',
    supplier_directory_id: SUPPLIER,
    supplier_name: 'ООО Поставщик',
    supplier_inn: '7743429410',
    doc_is_technical: false,
    doc_created_at: new Date('2026-09-04T14:10:04Z'),
    doc_items: 2,
    ...over,
  };
}

/** Приёмка 13776: полный документ и обрезок с той же строкой. */
function pair13776(): DuplicateCandidateRow[] {
  return [
    row({ id: 'keep', line_no: 2, source_document_id: 'doc-full', doc_items: 2 }),
    row({
      id: 'dup',
      line_no: 3,
      source_document_id: 'doc-fragment',
      source_document_item_id: 'sdi-2',
      doc_items: 1,
      doc_created_at: new Date('2026-09-04T14:10:05Z'),
    }),
  ];
}

describe('задвоенные строки приёмки: поиск пар', () => {
  it('приёмка 13776: пара находится, остаётся строка полного документа', () => {
    const [pair, ...rest] = findDuplicatePairs(pair13776());
    expect(rest).toEqual([]);
    expect(pair?.deletable).toBe(true);
    expect(pair?.keep.id).toBe('keep');
    expect(pair?.drop.id).toBe('dup');
    expect(pair?.reasons).toEqual([]);
  });

  it('строки одного документа парой не считаются', () => {
    // В бланке позиция может честно повторяться — это не задвоение разрезом.
    const rows = [
      row({ id: 'a', line_no: 1 }),
      row({ id: 'b', line_no: 2, source_document_item_id: 'sdi-2' }),
    ];
    expect(findDuplicatePairs(rows)).toEqual([]);
  });

  it('разные номера документов не связываются', () => {
    const rows = [
      row({ id: 'a', source_document_id: 'doc-1' }),
      row({ id: 'b', source_document_id: 'doc-2', doc_number: '201/21126720-1' }),
    ];
    expect(findDuplicatePairs(rows)).toEqual([]);
  });

  it('разные пакеты не связываются даже при одном номере', () => {
    const rows = [
      row({ id: 'a', source_document_id: 'doc-1' }),
      row({ id: 'b', source_document_id: 'doc-2', bundle_id: 'bundle-2' }),
    ];
    expect(findDuplicatePairs(rows)).toEqual([]);
  });

  it('разное количество — разные позиции, не пара', () => {
    const rows = [
      row({ id: 'a', source_document_id: 'doc-1' }),
      row({ id: 'b', source_document_id: 'doc-2', qty_actual: '46.0000' }),
    ];
    expect(findDuplicatePairs(rows)).toEqual([]);
  });

  it('каждая строка попадает не более чем в одну пару', () => {
    // Три одинаковые строки из трёх документов: пара одна, третья остаётся —
    // «лишняя строка видна менеджеру, потерянная — нет».
    const rows = [
      row({ id: 'a', source_document_id: 'doc-1' }),
      row({ id: 'b', source_document_id: 'doc-2' }),
      row({ id: 'c', source_document_id: 'doc-3' }),
    ];
    const pairs = findDuplicatePairs(rows);
    expect(pairs).toHaveLength(1);
    expect([pairs[0]!.keep.id, pairs[0]!.drop.id].sort()).toEqual(['a', 'b']);
  });

  it('документ без номера в разбор не идёт', () => {
    expect(documentGroupKey(row({ doc_number: null }))).toBeNull();
    // «б/н» тоже: по такому номеру документы не различить.
    expect(documentGroupKey(row({ doc_number: 'б/н' }))).toBeNull();
  });
});

describe('задвоенные строки приёмки: что НЕ удаляется', () => {
  it('любое различие пользовательского поля уводит пару на ручной разбор', () => {
    // Цена правлена руками — значит строку трогал человек.
    const [a, b] = pair13776();
    const changed = { ...b!, price: '300.0000' };
    const verdict = pairVerdict(a!, changed);
    expect(verdict.deletable).toBe(false);
    expect(verdict.reasons).toContain('price');
  });

  it('комментарий инспектора тоже считается правкой', () => {
    const [a, b] = pair13776();
    const verdict = pairVerdict(a!, { ...b!, comment: 'пересчитано на месте' });
    expect(verdict.deletable).toBe(false);
    expect(verdict.reasons).toContain('comment');
  });

  it('приёмки 13731 и 14072: разошёлся поставщик — только ручной разбор', () => {
    // 13731: «ООО МИКРОКЛИМАТ» с ИНН 9702018196 и он же с «ИНН» 770201001 —
    // это КПП. 14072: второй фрагмент приписан «АО АЛЬФА-БАНК» из платёжных
    // реквизитов в подвале УПД. Автоматически удалять такое нельзя: одинаковый
    // номер у разных поставщиков в одном пакете тоже бывает.
    const [a, b] = pair13776();
    const verdict = pairVerdict(a!, {
      ...b!,
      supplier_directory_id: 'supplier-2',
      supplier_name: 'АО "АЛЬФА-БАНК"',
      supplier_inn: '775101001',
    });
    expect(verdict.deletable).toBe(false);
    expect(verdict.reasons).toEqual(['поставщик документа']);
  });

  it('ИНН из девяти цифр опознаётся как КПП', () => {
    expect(looksLikeKpp('770201001')).toBe(true);
    expect(looksLikeKpp('9702018196')).toBe(false);
    expect(looksLikeKpp(null)).toBe(false);
  });

  it('номер строки в приёмке различием не считается', () => {
    // line_no назначает upsert, а не человек: у второй копии он другой просто
    // потому, что она вторая. Иначе кандидатов не осталось бы вовсе.
    const [a, b] = pair13776();
    expect(differingFields(a!, { ...b!, line_no: 99 })).toEqual([]);
  });
});

describe('какая строка остаётся', () => {
  it('строка полного документа, а не обрезка', () => {
    const [a, b] = pair13776();
    expect(pickSurvivor(a!, b!).keep.id).toBe('keep');
    // Порядок аргументов роли не играет.
    expect(pickSurvivor(b!, a!).keep.id).toBe('keep');
  });

  it('при равном числе позиций архивный документ уступает живому', () => {
    const a = row({ id: 'a', source_document_id: 'doc-1', doc_items: 2, doc_is_technical: true });
    const b = row({ id: 'b', source_document_id: 'doc-2', doc_items: 2 });
    expect(pickSurvivor(a, b).keep.id).toBe('b');
  });

  it('при прочем равенстве остаётся более ранний документ', () => {
    const a = row({
      id: 'a',
      source_document_id: 'doc-1',
      doc_created_at: new Date('2026-09-04T14:10:04Z'),
    });
    const b = row({
      id: 'b',
      source_document_id: 'doc-2',
      doc_created_at: new Date('2026-09-04T14:10:05Z'),
    });
    expect(pickSurvivor(a, b).keep.id).toBe('a');
  });
});
