/**
 * Имя поставщика из УПД для чипа в шапке операции.
 *
 * Карточка держит загруженный документ в local state и не сбрасывает его при
 * отвязке, поэтому главное, что стережёт тест, — имя отвязанного документа
 * в чип не попадает.
 */
import { describe, expect, it } from 'vitest';
import { pickUpdSupplierName } from './updSupplierName';

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
