// С каким УПД операции сверять таблицу фото (domain/photos/linked-document.ts).
// Данные — приёмка 22246: на 1 этапе номер прочитан верно (1820), на 2 этапе —
// как 00000001682.
import { describe, expect, it } from 'vitest';
import {
  pickLinkedDocument,
  type LinkedDocumentCandidate,
} from '../src/domain/photos/linked-document.js';

const upd1820: LinkedDocumentCandidate = {
  id: '469ac4ba-9b48-48a8-9201-8a32781868f0',
  docNumber: '1820',
  items: [
    { rowNo: 1, nameRaw: 'Швеллер 10П', qty: 204, unit: 'пог.м' },
    { rowNo: 2, nameRaw: 'Швеллер 8П', qty: 300, unit: 'пог.м' },
    { rowNo: 3, nameRaw: 'Автодоставка', qty: 1, unit: 'шт' },
  ],
};
const otherUpd: LinkedDocumentCandidate = {
  id: '1e77a6d4-6a03-481e-b3aa-8008341ac474',
  docNumber: '1790',
  items: [
    { rowNo: 1, nameRaw: 'Труба э/с 133х4', qty: 156, unit: 'пог.м' },
    { rowNo: 2, nameRaw: 'Автодоставка', qty: 1, unit: 'шт' },
  ],
};

const photoItems = [
  { rowNo: 1, nameRaw: 'Швеллер 10П', qty: 3, unit: 'шт' },
  { rowNo: 2, nameRaw: 'Швеллер 8П', qty: 300, unit: 'шт' },
  { rowNo: 3, nameRaw: 'Автодоставка', qty: 1, unit: 'шт' },
];
const photo = (docNumber: string | null, parser: 'upd_vision' | 'photo_v1' = 'upd_vision') => ({
  parser,
  docNumber,
  items: photoItems,
});

describe('pickLinkedDocument', () => {
  it('1 этап 22246: опознан по номеру', () => {
    const got = pickLinkedDocument(photo('1820'), [otherUpd, upd1820]);
    expect(got?.id).toBe(upd1820.id);
    expect(got?.matchedBy).toBe('number');
  });

  it('номер с ведущими знаками и пробелами нормализуется', () => {
    expect(pickLinkedDocument(photo(' № 1820 '), [upd1820])?.matchedBy).toBe('number');
  });

  it('2 этап 22246: номер 00000001682 не совпал — опознан по строкам', () => {
    const got = pickLinkedDocument(photo('00000001682'), [otherUpd, upd1820]);
    expect(got?.id).toBe(upd1820.id);
    expect(got?.matchedBy).toBe('rows');
  });

  it('пустой номер совпадением не считается', () => {
    const blank = { ...upd1820, docNumber: '' };
    const odd = { ...otherUpd, docNumber: null };
    // Ни номера, ни двух общих строк — сверки нет.
    expect(pickLinkedDocument(photo(''), [odd])).toBeNull();
    expect(pickLinkedDocument(photo('—'), [blank])?.matchedBy).toBe('rows');
  });

  it('два УПД с тем же номером — неоднозначно', () => {
    const copy = { ...upd1820, id: '00000000-0000-4000-8000-000000000001' };
    expect(pickLinkedDocument(photo('1820'), [upd1820, copy])).toBeNull();
  });

  it('по строкам подходят два документа — неоднозначно', () => {
    const copy = { ...upd1820, id: '00000000-0000-4000-8000-000000000002', docNumber: '1821' };
    expect(pickLinkedDocument(photo('9999'), [upd1820, copy])).toBeNull();
  });

  it('одна общая строка («Автодоставка») — не опознание', () => {
    expect(pickLinkedDocument(photo('9999'), [otherUpd])).toBeNull();
  });

  it('разбор photo_v1 и документ без позиций не сверяются', () => {
    expect(pickLinkedDocument(photo('1820', 'photo_v1'), [upd1820])).toBeNull();
    expect(pickLinkedDocument(photo('1820'), [{ ...upd1820, items: [] }])).toBeNull();
  });
});
