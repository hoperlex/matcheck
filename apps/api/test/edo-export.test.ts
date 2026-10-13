/**
 * Выгрузка УПД по списку поставщиков: чистые функции.
 *
 * Список собирают руками — в нём бывают пустые и испорченные ИНН. Каждая
 * отброшенная строка обязана получить номер и причину: молча потерянный
 * поставщик — это УПД, которых не окажется в выгрузке, и никто не узнает почему.
 *
 * Отбор документов проверяется через настоящую классификацию сообщения: так
 * тест ловит и расхождение с тем, как категории выставляет Диадок-слой.
 */
import { describe, expect, it } from 'vitest';
import { classifyMessageEntities } from '../src/domain/edo/diadoc.entities.js';
import type { DiadocMessage } from '../src/domain/edo/diadoc.types.js';
import { parseSupplierRows } from '../src/domain/edo/export-suppliers.js';
import {
  MAX_EXPORT_ATTEMPTS,
  matchSupplier,
  retryDelayHours,
  selectForCensus,
  selectForExport,
  storableDate,
  toIsoDate,
} from '../src/domain/edo/export-upd.js';
import { buildEdoExportKey } from '../src/domain/storage/s3.path.js';

const HEADER = ['Порядковый номер', 'Название', 'Альтернативные названия', 'ИНН'];

describe('список поставщиков из Excel', () => {
  it('валидные ИНН берутся, испорченные отбрасываются с номером строки и причиной', () => {
    const list = parseSupplierRows([
      HEADER,
      [1, 'Группа Компаний ИНОКС', '', '5906154545'],
      [2, 'ИП с ведущим нулём', '', '026508784775'],
      [3, 'АНТИСЛИП', '', ''],
      [4, 'ООО ЭЛЕКТРОМОНТАЖ', '', '50272996594'],
      [5, 'Переставленные цифры', '', '7736255088'],
      [6, 'ИНОКС ещё раз', '', '5906154545'],
      [7, 'С пробелами', '', ' 7736 255508 '],
      ['', '', '', ''],
    ]);

    expect([...list.byInn]).toEqual([
      ['5906154545', 'Группа Компаний ИНОКС'],
      ['026508784775', 'ИП с ведущим нулём'],
      ['7736255508', 'С пробелами'],
    ]);
    expect(list.issues).toEqual([
      { row: 4, name: 'АНТИСЛИП', inn: '', reason: 'empty' },
      { row: 5, name: 'ООО ЭЛЕКТРОМОНТАЖ', inn: '50272996594', reason: 'length' },
      { row: 6, name: 'Переставленные цифры', inn: '7736255088', reason: 'checksum' },
      { row: 7, name: 'ИНОКС ещё раз', inn: '5906154545', reason: 'duplicate' },
    ]);
    // Полностью пустая строка — хвост листа, а не поставщик.
    expect(list.rows).toBe(7);
  });

  it('колонки ищутся по заголовку, а не по позиции', () => {
    const list = parseSupplierRows([
      ['ИНН', 'Комментарий', 'Название'],
      ['5906154545', 'что-то', 'ИНОКС'],
    ]);
    expect([...list.byInn]).toEqual([['5906154545', 'ИНОКС']]);
  });

  it('без колонок «ИНН» и «Название» список не читается', () => {
    expect(() => parseSupplierRows([['Поставщик', 'Код'], ['ИНОКС', '1']])).toThrow(/ИНН/);
    expect(() => parseSupplierRows([])).toThrow(/ИНН/);
  });
});

const OUR_BOX = 'box-наш';

function entity(info: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    EntityId: 'e1',
    EntityType: 'Attachment',
    DocumentInfo: { TypeNamedId: 'UniversalTransferDocument', Function: 'СЧФДОП', ...info },
    ...extra,
  };
}

function selected(info: Record<string, unknown>, extra: Record<string, unknown> = {}): boolean {
  const message = {
    MessageId: 'm1',
    FromBoxId: 'box-контрагента',
    ToBoxId: OUR_BOX,
    Entities: [entity(info, extra)],
  } as DiadocMessage;
  const classified = classifyMessageEntities(message, OUR_BOX);
  expect(classified.skipped).toBeNull();
  return selectForExport(classified.entities[0]!);
}

describe('какие документы выгружаются', () => {
  it('УПД любой функции и исправление УПД — да', () => {
    expect(selected({ Function: 'СЧФДОП' })).toBe(true);
    expect(selected({ Function: 'ДОП' })).toBe(true);
    expect(selected({ Function: 'СЧФ' })).toBe(true);
    expect(selected({ Function: undefined })).toBe(true);
    expect(selected({ TypeNamedId: 'UniversalTransferDocumentRevision' })).toBe(true);
  });

  it('тестовый, аннулированный, удалённый, исходящий, зашифрованный — нет', () => {
    expect(selected({ IsTest: true })).toBe(false);
    expect(selected({ RevocationStatus: 'RevocationAccepted' })).toBe(false);
    expect(selected({ IsDeleted: true })).toBe(false);
    expect(selected({ DocumentDirection: 'Outbound' })).toBe(false);
    expect(selected({ IsEncryptedContent: true })).toBe(false);
  });

  it('счёт-фактура, скан, УКД и подпись — нет', () => {
    expect(selected({ TypeNamedId: 'Invoice', Function: 'default' })).toBe(false);
    expect(selected({ TypeNamedId: 'Nonformalized', Function: 'default' })).toBe(false);
    expect(selected({ TypeNamedId: 'UniversalCorrectionDocument', Function: 'КСЧФДИС' })).toBe(false);
    expect(selected({}, { EntityType: 'Signature', ParentEntityId: 'e0' })).toBe(false);
  });
});

describe('продавец из списка', () => {
  const list = new Map([
    ['7712345678', 'Поставщик из списка'],
    ['026508784775', 'ИП из списка'],
  ]);
  const party = (inn: string) => ({ inn, kpp: null, name: `Продавец ${inn}` });

  it('находится по 10 и 12 знакам', () => {
    expect(matchSupplier({ suppliers: [party('7712345678')] }, list)).toEqual({
      sellerInns: ['7712345678'],
      listed: { inn: '7712345678', name: 'Поставщик из списка' },
    });
    expect(matchSupplier({ suppliers: [party('026508784775')] }, list).listed?.inn).toBe('026508784775');
  });

  it('в списке только второй продавец — документ всё равно берётся', () => {
    expect(matchSupplier({ suppliers: [party('5000000000'), party('7712345678')] }, list)).toEqual({
      sellerInns: ['5000000000', '7712345678'],
      listed: { inn: '7712345678', name: 'Поставщик из списка' },
    });
  });

  it('ни одного продавца из списка — помнятся все ИНН документа', () => {
    expect(matchSupplier({ suppliers: [party('5000000000'), party('6000000000'), party('')] }, list)).toEqual({
      sellerInns: ['5000000000', '6000000000'],
      listed: null,
    });
  });
});

describe('продавец без списка (все УПД ящика)', () => {
  const party = (inn: string) => ({ inn, kpp: null, name: `Продавец ${inn}` });

  it('первый продавец с ИНН, который помещается в реестр', () => {
    expect(matchSupplier({ suppliers: [party('7712345678')] }, null)).toEqual({
      sellerInns: ['7712345678'],
      listed: { inn: '7712345678', name: 'Продавец 7712345678' },
    });
  });

  it('ИНН длиннее 12 цифр — не продавец реестра, но остаётся в seller_inns', () => {
    expect(matchSupplier({ suppliers: [party('77123456789012'), party('5906154545')] }, null)).toEqual({
      sellerInns: ['77123456789012', '5906154545'],
      listed: { inn: '5906154545', name: 'Продавец 5906154545' },
    });
    expect(matchSupplier({ suppliers: [party('77123456789012')] }, null).listed).toBeNull();
  });
});

const KEY_IDS = { accountId: 'ACC-1', messageId: 'Msg-2', entityId: 'A1B2-c3' };

describe('ключ в хранилище', () => {
  it('детерминирован: ИНН, дата, номер и тройка учётка/сообщение/сущность', () => {
    const input = { inn: '7712345678', docDate: '2026-09-25', docNumber: 'ЦБ-674', ...KEY_IDS };
    expect(buildEdoExportKey(input)).toBe('edo-export/7712345678/2026-09-25_tsb-674_acc-1_msg-2_a1b2-c3.xml');
    expect(buildEdoExportKey(input)).toBe(buildEdoExportKey({ ...input }));
  });

  it('одна сущность в разных сообщениях — разные ключи', () => {
    const base = { inn: '7712345678', docDate: '2026-09-25', docNumber: '1', ...KEY_IDS };
    expect(buildEdoExportKey(base)).not.toBe(buildEdoExportKey({ ...base, messageId: 'Msg-3' }));
    expect(buildEdoExportKey(base)).not.toBe(buildEdoExportKey({ ...base, accountId: 'ACC-2' }));
  });

  it('только ASCII: номер с «/», «+», «%», «?», «#» не ломает подпись запроса', () => {
    const key = buildEdoExportKey({
      inn: '7712345678',
      docDate: '2026-09-25',
      docNumber: 'СУ-БП/25+45 %?#',
      ...KEY_IDS,
    });
    expect(key).toBe('edo-export/7712345678/2026-09-25_su-bp-25-45_acc-1_msg-2_a1b2-c3.xml');
    expect(key).toMatch(/^[a-z0-9/_.-]+$/);
  });

  it('без даты, номера и ИНН — заглушки, а не пустые сегменты', () => {
    expect(buildEdoExportKey({ inn: '7712345678', docDate: null, docNumber: '  ', ...KEY_IDS })).toBe(
      'edo-export/7712345678/undated_nonum_acc-1_msg-2_a1b2-c3.xml',
    );
    expect(buildEdoExportKey({ inn: '7712345678', docDate: '25.09.2026', docNumber: null, ...KEY_IDS })).toBe(
      'edo-export/7712345678/undated_nonum_acc-1_msg-2_a1b2-c3.xml',
    );
    expect(buildEdoExportKey({ inn: null, docDate: '2026-09-25', docNumber: '1', ...KEY_IDS })).toBe(
      'edo-export/unknown/2026-09-25_1_acc-1_msg-2_a1b2-c3.xml',
    );
  });
});

describe('дата документа', () => {
  it('принимает формат XML и формат метаданных Диадока', () => {
    expect(toIsoDate('2026-09-25')).toBe('2026-09-25');
    expect(toIsoDate('25.09.2026')).toBe('2026-09-25');
    expect(toIsoDate('')).toBeNull();
    expect(toIsoDate(null)).toBeNull();
    expect(toIsoDate('сентябрь')).toBeNull();
  });

  it('в базу — только существующий день 2000–2100: иначе запись строки остановила бы страницу', () => {
    expect(storableDate('25.09.2026')).toBe('2026-09-25');
    expect(storableDate('31.02.2026')).toBeNull();
    expect(storableDate('2026-13-01')).toBeNull();
    expect(storableDate('01.01.0026')).toBeNull();
    expect(storableDate('01.01.2226')).toBeNull();
  });
});

function classify(info: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const message = {
    MessageId: 'm1',
    FromBoxId: 'box-контрагента',
    ToBoxId: OUR_BOX,
    Entities: [entity(info, extra)],
  } as DiadocMessage;
  return classifyMessageEntities(message, OUR_BOX).entities[0]!;
}

describe('перепись без скачивания', () => {
  it('скан, счёт-фактура и накладная — да; УПД, подпись, тестовый и УКД — нет', () => {
    expect(selectForCensus(classify({ TypeNamedId: 'Nonformalized', Function: 'default' }))).toBe(true);
    expect(selectForCensus(classify({ TypeNamedId: 'Invoice', Function: 'default' }))).toBe(true);
    expect(selectForCensus(classify({ TypeNamedId: 'XmlTorg12', Function: 'default' }))).toBe(true);
    expect(selectForCensus(classify({}))).toBe(false);
    expect(selectForCensus(classify({}, { EntityType: 'Signature', ParentEntityId: 'e0' }))).toBe(false);
    expect(selectForCensus(classify({ TypeNamedId: 'Nonformalized', Function: 'default', IsTest: true }))).toBe(
      false,
    );
    expect(selectForCensus(classify({ TypeNamedId: 'UniversalCorrectionDocument', Function: 'КСЧФДИС' }))).toBe(
      false,
    );
  });

  it('размер содержимого берётся из метаданных', () => {
    expect(classify({ TypeNamedId: 'Nonformalized' }, { Content: { Size: 12345 } }).contentSize).toBe(12345);
    expect(classify({ TypeNamedId: 'Nonformalized' }).contentSize).toBeNull();
  });
});

describe('расписание повторов', () => {
  it('1 ч → 6 ч → 24 ч → 72 ч, после пятой неудачи — окончательно', () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelayHours)).toEqual([1, 6, 24, 72, null, null]);
    expect(MAX_EXPORT_ATTEMPTS).toBe(5);
  });
});
