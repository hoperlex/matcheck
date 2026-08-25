/**
 * Необязательные числовые поля позиции не роняют разбор.
 *
 * 19.08 промпт v13 попросил номер позиции, модель вернула `"rowNo": "1"`
 * строкой — и строгий `z.number()` отверг ВЕСЬ ответ. Корректно распознанная
 * ТТН «Стис» № 1200-3843 (номер из графы «№», дата, стороны с ИНН, позиция
 * 4.83 м² × 10 420.83) превратилась в «не распознано» из-за формата одного
 * диагностического поля. Тест держит правило: непонятное значение → null,
 * документ живёт.
 */
import { describe, expect, it } from 'vitest';
import { UpdPdfItemSchema, UpdPdfParsedSchema } from '@matcheck/contracts';

function parseRowNo(value: unknown): number | null | undefined {
  const parsed = UpdPdfItemSchema.parse({ nameRaw: 'Товар', rowNo: value }) as {
    rowNo?: number | null;
  };
  return parsed.rowNo;
}

describe('UpdPdfItemSchema — rowNo', () => {
  it.each([
    [1, 1],
    ['1', 1],
    [' 2 ', 2],
    ['3.', 3],
    ['', null],
    [null, null],
    ['abc', null],
    ['1а', null],
    [0, null],
    [-1, null],
    [2.7, null],
    [{}, null],
    [true, null],
  ])('rowNo=%p → %p', (input, expected) => {
    expect(parseRowNo(input)).toBe(expected);
  });

  it('строковый номер не мешает документу пройти валидацию целиком', () => {
    // Ровно тот ответ, что упал на бою 19.08 в 17:49.
    const parsed = UpdPdfParsedSchema.parse({
      docNumber: '1200-3843',
      docDate: '2026-08-20',
      totalSum: 50332.61,
      vatSum: null,
      supplier: { inn: '7720774346', kpp: null, name: 'Группа компаний "СтиС"' },
      recipient: { inn: '7736255508', kpp: null, name: 'СУ-10' },
      items: [
        {
          rowNo: '1',
          nameRaw: 'Стеклопакеты двухкамерные',
          qty: 4.83,
          unit: 'м2',
          price: 10420.83,
          sum: 50332.61,
          volumeM3: '0.045',
          massKg: '32,0',
        },
      ],
      confidence: 0.9,
    });
    expect(parsed.items[0]?.rowNo).toBe(1);
    expect(parsed.docNumber).toBe('1200-3843');
    // Довески тоже приводятся, а не роняют разбор.
    expect(parsed.items[0]?.volumeM3).toBeCloseTo(0.045, 3);
    expect(parsed.items[0]?.massKg).toBeCloseTo(32, 3);
  });
});

/**
 * Тот же принцип для счётчика наименований из шапки бланка.
 *
 * До правки поле было строгим (`z.number().int().nonnegative()`), и любая
 * причуда формата уронила бы ВЕСЬ ответ в `parse_failed` — как уже случилось с
 * rowNo. Пока промпт про счётчик не спрашивал, риск был теоретическим; просить
 * его в v14 без этой правки нельзя: чем настойчивее просишь поле, тем выше шанс
 * получить «12 наименований» вместо 12.
 */
describe('UpdPdfParsedSchema — itemsCount', () => {
  function parseItemsCount(value: unknown): number | null | undefined {
    const parsed = UpdPdfParsedSchema.parse({
      docNumber: '1',
      items: [],
      confidence: 0.9,
      itemsCount: value,
    }) as { itemsCount?: number | null };
    return parsed.itemsCount;
  }

  it.each([
    // Валидные значения проходят как раньше — правка поведенчески нейтральна.
    [12, 12],
    ['12', 12],
    [' 7 ', 7],
    [0, 0],
    // Ноль остаётся валидным: прежний контракт его допускал (nonnegative), и
    // менять это заодно с ослаблением типа нельзя.
    ['0', 0],
    // Всё непонятное — null, а не падение разбора.
    ['12 наименований', null],
    ['двенадцать', null],
    [12.5, null],
    [-3, null],
    ['', null],
    [null, null],
    [{}, null],
    [true, null],
    [[], null],
  ])('itemsCount %p → %p', (input, expected) => {
    expect(parseItemsCount(input)).toBe(expected);
  });

  it('отсутствующее поле остаётся undefined — старые промпты его не возвращают', () => {
    const parsed = UpdPdfParsedSchema.parse({ docNumber: '1', items: [], confidence: 0.9 }) as {
      itemsCount?: number | null;
    };
    expect(parsed.itemsCount).toBeUndefined();
  });

  it('мусор в счётчике не мешает разобрать остальной документ', () => {
    // Главное свойство: документ живёт. Номер, стороны и позиции на месте,
    // потеряна только диагностическая цифра.
    const parsed = UpdPdfParsedSchema.parse({
      docNumber: 'ЦБ-641',
      docDate: '2026-03-13',
      totalSum: 65104.55,
      itemsCount: 'Всего наименований 3',
      supplier: { inn: '7716794678', kpp: null, name: 'ООО «РЕГУЛ»' },
      recipient: { inn: '7736255508', kpp: null, name: 'СУ-10' },
      items: [{ rowNo: 1, nameRaw: 'Кабель', qty: 30, unit: 'м', price: 173, sum: 6331.8 }],
      confidence: 0.95,
    });
    expect(parsed.itemsCount).toBeNull();
    expect(parsed.docNumber).toBe('ЦБ-641');
    expect(parsed.items[0]?.sum).toBe(6331.8);
  });
});
