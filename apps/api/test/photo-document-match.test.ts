// Сопоставление строк таблицы с фото и строк УПД операции
// (packages/contracts/src/photo-document-match.ts). Данные — приёмка 22246:
// УПД № 1820 разобран верно, фото того же бланка — с ошибками в количестве.
import { describe, expect, it } from 'vitest';
import { itemNameKey, matchPhotoRows, unitKey } from '@matcheck/contracts';

const doc1820 = [
  { rowNo: 1, nameRaw: 'Швеллер 10П', qty: 204, unit: 'пог.м' },
  { rowNo: 2, nameRaw: 'Швеллер 8П', qty: 300, unit: 'пог.м' },
  { rowNo: 3, nameRaw: 'Автодоставка', qty: 1, unit: 'шт' },
];
// 1 этап: в строке 1 прочитана разметка граф «1б» → 16.
const stage1 = [
  { rowNo: 1, nameRaw: 'Швеллер 10П', qty: 16, unit: 'пог. м' },
  { rowNo: 2, nameRaw: 'Швеллер 8П', qty: 300, unit: 'пог. м' },
  { rowNo: 3, nameRaw: 'Автодоставка', qty: 1, unit: 'шт' },
];
// 2 этап: номер графы «3» в количестве, «шт» вместо «пог.м».
const stage2 = [
  { rowNo: 1, nameRaw: 'Швеллер 10П', qty: 3, unit: 'шт' },
  { rowNo: 2, nameRaw: 'Швеллер 8П', qty: 300, unit: 'шт' },
  { rowNo: 3, nameRaw: 'Автодоставка', qty: 1, unit: 'шт' },
];

const pairsOf = (r: ReturnType<typeof matchPhotoRows>) =>
  r.map((p) => [p.photoIndex, p.docIndex, p.by]);

describe('matchPhotoRows', () => {
  it('22246, 1 этап: три пары по номеру и имени', () => {
    expect(pairsOf(matchPhotoRows(stage1, doc1820, { byNumber: true }))).toEqual([
      [0, 0, 'row_and_name'],
      [1, 1, 'row_and_name'],
      [2, 2, 'row_and_name'],
    ]);
  });

  it('22246, 2 этап: номер документа не опознан, пары те же', () => {
    expect(matchPhotoRows(stage2, doc1820, { byNumber: false })).toHaveLength(3);
  });

  it('у строк УПД нет номера позиции — пары по единственному имени', () => {
    const noRowNo = doc1820.map((r) => ({ ...r, rowNo: null }));
    expect(pairsOf(matchPhotoRows(stage1, noRowNo, { byNumber: false }))).toEqual([
      [0, 0, 'name'],
      [1, 1, 'name'],
      [2, 2, 'name'],
    ]);
  });

  it('опечатка в имени: пара по номеру позиции только при документе, опознанном по номеру', () => {
    const typo = [{ rowNo: 1, nameRaw: 'Швелер 10 П', qty: 16, unit: 'пог.м' }];
    expect(pairsOf(matchPhotoRows(typo, doc1820, { byNumber: true }))).toEqual([[0, 0, 'row']]);
    expect(matchPhotoRows(typo, doc1820, { byNumber: false })).toEqual([]);
  });

  it('номер позиции совпал, а цифры в имени другие — не пара', () => {
    const other = [{ rowNo: 1, nameRaw: 'Швеллер 12П', qty: 16, unit: 'пог.м' }];
    expect(matchPhotoRows(other, doc1820, { byNumber: true })).toEqual([]);
  });

  it('два одинаковых имени без номеров — неоднозначно, пар нет', () => {
    const twice = [
      { rowNo: null, nameRaw: 'Швеллер 10П' },
      { rowNo: null, nameRaw: 'Швеллер 10П' },
    ];
    const docTwice = [
      { rowNo: null, nameRaw: 'Швеллер 10П' },
      { rowNo: null, nameRaw: 'Швеллер 10П' },
    ];
    expect(matchPhotoRows(twice, docTwice, { byNumber: true })).toEqual([]);
  });

  it('строка УПД участвует не больше одного раза', () => {
    const dup = [
      { rowNo: 1, nameRaw: 'Швеллер 10П' },
      { rowNo: 1, nameRaw: 'Швеллер 10П' },
    ];
    const pairs = matchPhotoRows(dup, doc1820, { byNumber: true });
    expect(new Set(pairs.map((p) => p.docIndex)).size).toBe(pairs.length);
    expect(pairs).toHaveLength(1);
  });
});

describe('ключи сравнения', () => {
  it('имя: регистр, пробелы, ё и латинские двойники', () => {
    expect(itemNameKey('Швеллер 10П')).toBe(itemNameKey('ШВЕЛЛЕР 10 п'));
    expect(itemNameKey('Автодоставк а')).toBe(itemNameKey('Автодоставка'));
    expect(itemNameKey('Труба ВГП 32x3,2')).toBe(itemNameKey('Труба ВГП 32х3.2'));
  });

  it('единица: «пог. м» = «пог.м», «шт» ≠ «пог.м»', () => {
    expect(unitKey('пог. м')).toBe(unitKey('Пог.м'));
    expect(unitKey('шт')).not.toBe(unitKey('пог.м'));
  });
});
