/**
 * Адрес пустой строки в сообщении об ошибке.
 *
 * Блоки материалов свёрнуты, поэтому подсветки строки недостаточно: пустая
 * позиция может лежать внутри закрытой панели. Человеку нужно сказать, в каком
 * документе и какая по счёту строка не заполнена.
 */
import { describe, expect, it } from 'vitest';
import type { OperationSourceDocument } from '@matcheck/contracts';
import { describeEmptyNames } from './emptyItemNames';

const DOC = '11111111-1111-4111-8111-111111111111';

function doc(over: Partial<OperationSourceDocument> = {}): OperationSourceDocument {
  return {
    id: DOC,
    kind: 'upd',
    docNumber: '10819',
    docDate: '2026-09-03',
    linked: true,
    itemsCount: null,
    coveredItemsCount: null,
    ...over,
  } as OperationSourceDocument;
}

const item = (nameRaw: string, sourceDocumentId: string | null = null) => ({
  nameRaw,
  sourceDocumentId,
});

describe('describeEmptyNames', () => {
  it('заполненные строки не жалуются', () => {
    expect(describeEmptyNames({ items: [item('Щебень', DOC)], documents: [doc()] })).toEqual([]);
  });

  it('называет документ и номер строки внутри его блока', () => {
    const items = [item('Щебень', DOC), item('   ', DOC), item('Песок', DOC)];
    expect(describeEmptyNames({ items, documents: [doc()] })).toEqual(['УПД № 10819, строка 2']);
  });

  it('строка без документа адресуется своим блоком', () => {
    const items = [item('Щебень', DOC), item('')];
    expect(describeEmptyNames({ items, documents: [doc()] })).toEqual([
      'без привязки к документу, строка 1',
    ]);
  });

  it('документов нет вовсе — блок называется «материалы»', () => {
    expect(describeEmptyNames({ items: [item('')], documents: [] })).toEqual([
      'материалы, строка 1',
    ]);
  });

  it('документ без номера не притворяется номером', () => {
    expect(
      describeEmptyNames({ items: [item('', DOC)], documents: [doc({ docNumber: null })] }),
    ).toEqual(['УПД без номера, строка 1']);
  });

  it('перечисляет все пустые строки, а не только первую', () => {
    const items = [item('', DOC), item('Песок', DOC), item(' ', DOC)];
    expect(describeEmptyNames({ items, documents: [doc()] })).toHaveLength(2);
  });
});
