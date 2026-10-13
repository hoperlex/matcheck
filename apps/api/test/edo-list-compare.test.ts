/**
 * Сверка документа из списка Диадока со строкой реестра.
 *
 * Деньги сравниваются в копейках точно: исходный вопрос — «реестр не
 * совпадает с Диадоком», и допуск спрятал бы ровно ту копейку, ради которой
 * сверяем. Отсутствие значения с одной стороны — «нет данных», а не совпадение.
 */
import { describe, expect, it } from 'vitest';
import type { DiadocListedDocument } from '../src/domain/edo/diadoc.types.js';
import {
  compareWithRegistry,
  isInbound,
  listedDocumentState,
  moneyToKopecks,
  type RegistrySide,
} from '../src/domain/edo/list-compare.js';

function listed(meta: Record<string, string>, extra: Partial<DiadocListedDocument> = {}): DiadocListedDocument {
  return {
    MessageId: 'm',
    EntityId: 'e',
    Function: 'СЧФДОП',
    Metadata: Object.entries(meta).map(([Key, Value]) => ({ Key, Value })),
    ...extra,
  } as DiadocListedDocument;
}

const ROW: RegistrySide = {
  documentNumber: 'УТ-4308',
  documentDate: '2026-09-30',
  documentFunction: 'СЧФДОП',
  totalSum: '40700.18',
  vatSum: '7339.38',
  sellerInns: ['7842224734'],
};

const META = {
  DocumentNumber: 'ут-4308 ',
  DocumentDate: '30.09.2026',
  TotalSum: '40700.18',
  TotalVat: '7339.38',
  SellerInn: '7842224734',
};

const verdicts = (doc: DiadocListedDocument, row: RegistrySide = ROW) =>
  Object.fromEntries(compareWithRegistry(doc, row).map((c) => [c.field, c.verdict]));

describe('сумма в копейках', () => {
  it.each([
    ['1234.5', 123450n],
    ['1 234,50', 123450n],
    ['1 234.05', 123405n],
    ['-12', -1200n],
    [980, 98000n],
  ])('%s → %s', (raw, expected) => {
    expect(moneyToKopecks(raw)).toBe(expected);
  });

  it.each(['', 'abc', '1.234', '1,2,3'])('«%s» не становится нулём', (raw) => {
    expect(moneyToKopecks(raw)).toBeNull();
  });
});

describe('сверка реквизитов', () => {
  it('совпадение по всем полям — номер без регистра и пробелов, дата из ДД.ММ.ГГГГ', () => {
    expect(verdicts(listed(META))).toEqual({
      number: 'equal',
      date: 'equal',
      function: 'equal',
      total: 'equal',
      vat: 'equal',
      sellerInn: 'equal',
    });
  });

  it('копейка — это расхождение', () => {
    const checks = compareWithRegistry(listed({ ...META, TotalSum: '40700.19' }), ROW);
    const total = checks.find((c) => c.field === 'total')!;
    expect(total).toEqual({ field: 'total', diadoc: '40700.19', registry: '40700.18', verdict: 'diff' });
  });

  it('нет суммы в карточке Диадока — «нет данных», а не совпадение', () => {
    const { TotalSum: _drop, ...rest } = META;
    expect(verdicts(listed(rest)).total).toBe('no_data');
  });

  it('нет суммы в реестре — тоже «нет данных»', () => {
    expect(verdicts(listed(META), { ...ROW, vatSum: null }).vat).toBe('no_data');
  });

  it('ИНН продавца сверяется со всеми продавцами из XML', () => {
    expect(verdicts(listed(META), { ...ROW, sellerInns: ['7700000000', '7842224734'] }).sellerInn).toBe('equal');
    expect(verdicts(listed(META), { ...ROW, sellerInns: ['7700000000'] }).sellerInn).toBe('diff');
    expect(verdicts(listed(META), { ...ROW, sellerInns: [] }).sellerInn).toBe('no_data');
  });

  it('другая дата и другая функция — расхождения', () => {
    const v = verdicts(listed({ ...META, DocumentDate: '01.10.2026' }, { Function: 'ДОП' }));
    expect(v.date).toBe('diff');
    expect(v.function).toBe('diff');
  });

  it('устаревшие прямые поля читаются, если Metadata пуста', () => {
    const v = verdicts(listed({}, { DocumentNumber: 'УТ-4308', DocumentDate: '30.09.2026' }));
    expect(v.number).toBe('equal');
    expect(v.date).toBe('equal');
  });
});

describe('состояние документа', () => {
  it('статусы и текст документооборота', () => {
    const state = listedDocumentState(
      listed(META, {
        DocumentDirection: 'Inbound',
        RecipientResponseStatus: 'RecipientSignatureRequestRejected',
        RevocationStatus: 'RevocationStatusNone',
        DocflowStatus: { PrimaryStatus: { StatusText: 'Отказано в подписи' } },
        IsDeleted: false,
      }),
    );
    expect(state).toEqual({
      direction: 'Inbound',
      recipientResponse: 'RecipientSignatureRequestRejected',
      revocation: 'RevocationStatusNone',
      docflowText: 'Отказано в подписи',
      isDeleted: false,
      isTest: false,
    });
  });

  it('число вместо строки в перечислении не теряется', () => {
    expect(listedDocumentState(listed(META, { RevocationStatus: 4 })).revocation).toBe('4');
  });

  it('направление: входящий / исходящий / неизвестно', () => {
    expect(isInbound({ DocumentDirection: 'Inbound' })).toBe(true);
    expect(isInbound({ DocumentDirection: 'Outbound' })).toBe(false);
    expect(isInbound({})).toBe(false);
  });
});
