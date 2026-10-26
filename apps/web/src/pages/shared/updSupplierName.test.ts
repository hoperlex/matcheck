/**
 * Имя поставщика из УПД для чипа в шапке операции.
 *
 * Карточка держит загруженный документ в local state и не сбрасывает его при
 * отвязке, поэтому главное, что стережёт тест, — имя отвязанного документа
 * в чип не попадает.
 */
import { describe, expect, it } from 'vitest';
import { documentSupplierInn, pickUpdSupplierName, updSupplierEditTarget } from './updSupplierName';

const DOC = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('pickUpdSupplierName', () => {
  it('документ привязан — имя поставщика из него', () => {
    expect(pickUpdSupplierName({ id: DOC, supplierName: 'ООО «ТД ЛИДЕР-СНАБ»' }, [DOC])).toBe(
      'ООО «ТД ЛИДЕР-СНАБ»',
    );
  });

  it('документ привязан вторым из нескольких — имя всё равно берётся', () => {
    expect(pickUpdSupplierName({ id: DOC, supplierName: 'ООО «Альфа»' }, [OTHER, DOC])).toBe(
      'ООО «Альфа»',
    );
  });

  it('документ отвязан — имени нет', () => {
    // После unlink-source карточка ещё держит прежний документ в state.
    expect(pickUpdSupplierName({ id: DOC, supplierName: 'ООО «Альфа»' }, [OTHER])).toBeNull();
    expect(pickUpdSupplierName({ id: DOC, supplierName: 'ООО «Альфа»' }, [])).toBeNull();
  });

  it('документ не загружен — имени нет', () => {
    expect(pickUpdSupplierName(null, [DOC])).toBeNull();
    expect(pickUpdSupplierName(undefined, [DOC])).toBeNull();
  });

  it('поставщик в документе не определён — имени нет', () => {
    expect(pickUpdSupplierName({ id: DOC, supplierName: null }, [DOC])).toBeNull();
    expect(pickUpdSupplierName({ id: DOC }, [DOC])).toBeNull();
    expect(pickUpdSupplierName({ id: DOC, supplierName: '   ' }, [DOC])).toBeNull();
  });
});

describe('updSupplierEditTarget', () => {
  const upd = { id: DOC, docNumber: '240627', docDate: '2026-10-13' };

  it('основной документ и право есть — правится он', () => {
    expect(
      updSupplierEditTarget({
        sourceDocumentIds: [DOC],
        ownSupplierId: null,
        selectedUpd: upd,
        canEdit: true,
      }),
    ).toEqual({
      docId: DOC,
      docNumber: '240627',
      docDate: '2026-10-13',
      linkedCount: 1,
      docInn: null,
    });
  });

  it('несколько документов — правится основной, число документов передаётся', () => {
    expect(
      updSupplierEditTarget({
        sourceDocumentIds: [DOC, OTHER],
        ownSupplierId: null,
        selectedUpd: upd,
        canEdit: true,
      }),
    ).toMatchObject({ docId: DOC, linkedCount: 2 });
  });

  it('в state не основной документ — править нечего', () => {
    // Отвязали основной: карточка ещё держит его, а первым стал другой.
    expect(
      updSupplierEditTarget({
        sourceDocumentIds: [OTHER, DOC],
        ownSupplierId: null,
        selectedUpd: upd,
        canEdit: true,
      }),
    ).toBeNull();
    expect(
      updSupplierEditTarget({
        sourceDocumentIds: [OTHER],
        ownSupplierId: null,
        selectedUpd: upd,
        canEdit: true,
      }),
    ).toBeNull();
  });

  it('документ ещё не загружен — править нечего', () => {
    expect(
      updSupplierEditTarget({
        sourceDocumentIds: [DOC],
        ownSupplierId: null,
        selectedUpd: null,
        canEdit: true,
      }),
    ).toBeNull();
  });

  it('у операции свой поставщик — правка документа не была бы видна', () => {
    expect(
      updSupplierEditTarget({
        sourceDocumentIds: [DOC],
        ownSupplierId: '33333333-3333-4333-8333-333333333333',
        selectedUpd: upd,
        canEdit: true,
      }),
    ).toBeNull();
  });

  it('нет права — править нечего', () => {
    expect(
      updSupplierEditTarget({
        sourceDocumentIds: [DOC],
        ownSupplierId: null,
        selectedUpd: upd,
        canEdit: false,
      }),
    ).toBeNull();
  });
});

describe('documentSupplierInn — ИНН из бумаги, а не из текущей привязки', () => {
  it('проверенный ИНН из следа', () => {
    expect(documentSupplierInn({ decision: 'valid', inn: '5028021698' })).toBe('5028021698');
    expect(documentSupplierInn({ decision: 'normalized', inn: '50 28-021698' })).toBe('5028021698');
    expect(documentSupplierInn({ decision: 'corrected', inn: '5028021698' })).toBe('5028021698');
  });

  it('ИНН не проверен или отсутствует — неизвестен', () => {
    expect(documentSupplierInn({ decision: 'unverified', inn: null })).toBeNull();
    expect(documentSupplierInn({ decision: 'absent', inn: null })).toBeNull();
    expect(documentSupplierInn(null)).toBeNull();
    expect(documentSupplierInn(undefined)).toBeNull();
  });

  it('после ручной перепривязки (21713) ИНН берётся из следа, а не из supplierInn', () => {
    // supplierInn документа после правки — ИНН выбранного дубля; окно на него не смотрит.
    const doc = {
      id: DOC,
      docNumber: '00EP-005791',
      docDate: '2026-10-23',
      supplierInn: '5028024698',
      supplierInnCheck: { decision: 'valid', inn: '5028021698' },
    };
    expect(
      updSupplierEditTarget({
        sourceDocumentIds: [DOC],
        ownSupplierId: null,
        selectedUpd: doc,
        canEdit: true,
      })?.docInn,
    ).toBe('5028021698');
  });

  it('следа нет — ИНН документа неизвестен, даже если supplierInn заполнен', () => {
    expect(
      updSupplierEditTarget({
        sourceDocumentIds: [DOC],
        ownSupplierId: null,
        selectedUpd: { id: DOC, supplierInn: '5028024698' } as {
          id: string;
          supplierInn: string;
        },
        canEdit: true,
      })?.docInn,
    ).toBeNull();
  });
});
