import { describe, it, expect } from 'vitest';
import { suspectPackPriceScale } from '@matcheck/contracts';
import { validateUpdTotals } from '../src/domain/edo/upd-validation.js';

/**
 * Подозрение «в цене стоимость упаковки, а в количестве — число упаковок».
 *
 * Класс не ловится проверками: перенос множителя не меняет произведение, строка
 * проходит как корректная, и итог документа собран из тех же чисел. На приёмке
 * 13094 «2000 шт × 1,00 ₽» приехало как «2 шт × 1000,00 ₽».
 *
 * Половина тестов — замки «не срабатывает»: признак специально узкий, и каждое
 * условие отсекает свой источник ложных срабатываний. Без них он давал бы 112
 * срабатываний за 90 дней вместо шести.
 */

const DOWEL = {
  qty: 2,
  unit: 'шт',
  price: 1000,
  nameRaw: 'Дюбель фасадный Evofast TD 10x300 гвоздь с термоголовой МЗ 200 шт/уп (ГОСТ Р 58359-2019)',
};

describe('подозрение на цену упаковки', () => {
  it('боевой случай 13094: дюбель по 1000 ₽ при фасовке 200 шт/уп', () => {
    expect(suspectPackPriceScale(DOWEL)).toBe(true);
  });

  it('второй боевой случай: мешки, 6,15 упаковки по 5000 ₽', () => {
    expect(
      suspectPackPriceScale({
        qty: 6.15,
        unit: 'шт',
        price: 5000,
        nameRaw: 'Мешки полипропиленовые белые 55х95 (упак. 1000 шт.)',
      }),
    ).toBe(true);
  });

  it('цена не из одной значащей цифры — обычная цена, не перенос множителя', () => {
    expect(suspectPackPriceScale({ ...DOWEL, price: 1830 })).toBe(false);
    expect(suspectPackPriceScale({ ...DOWEL, price: 526 })).toBe(false);
    expect(suspectPackPriceScale({ ...DOWEL, price: 1000.5 })).toBe(false);
  });

  it('дешёвая позиция подозрений не вызывает', () => {
    expect(suspectPackPriceScale({ ...DOWEL, price: 90 })).toBe(false);
  });

  it('нештучная единица: у метров и килограммов дробное количество нормально', () => {
    expect(suspectPackPriceScale({ ...DOWEL, unit: 'м' })).toBe(false);
    expect(suspectPackPriceScale({ ...DOWEL, unit: 'кг' })).toBe(false);
    expect(suspectPackPriceScale({ ...DOWEL, unit: 'упак' })).toBe(false);
  });

  it('фасовка не объявлена или мелкая — признака нет', () => {
    expect(suspectPackPriceScale({ ...DOWEL, nameRaw: 'Дюбель фасадный 10x300' })).toBe(false);
    expect(suspectPackPriceScale({ ...DOWEL, nameRaw: 'Комплект 5 шт' })).toBe(false);
  });

  it('количество не меньше фасовки — целые упаковки это норма', () => {
    expect(suspectPackPriceScale({ ...DOWEL, qty: 200 })).toBe(false);
    expect(suspectPackPriceScale({ ...DOWEL, qty: 400 })).toBe(false);
  });

  it('пустые числа не ломают предикат', () => {
    expect(suspectPackPriceScale({ ...DOWEL, qty: null })).toBe(false);
    expect(suspectPackPriceScale({ ...DOWEL, price: null })).toBe(false);
    expect(suspectPackPriceScale({ ...DOWEL, nameRaw: null })).toBe(false);
  });
});

describe('подозрение на цену упаковки внутри валидатора', () => {
  /** Строка 13094 целиком: 2 × 1000 = 2000, +22% = 2440. Всё сходится. */
  const parsed = {
    totalSum: 2440,
    vatSum: 440,
    itemsCount: 1,
    items: [
      {
        qty: 2,
        unit: 'шт',
        nameRaw: DOWEL.nameRaw,
        price: 1000,
        sum: 2440,
        vatRate: 22,
        vatSum: 440,
      },
    ],
  };

  it('арифметика сходится — но подозрение предъявлено', () => {
    const v = validateUpdTotals(parsed, {
      detectRecognitionWarnings: true,
      detectPackPriceScale: true,
    });
    expect(v.hasMismatch).toBe(false);
    expect(v.warnings?.map((w) => w.name)).toEqual(['price_is_pack_price']);
    expect(v.warnings?.[0]!.scope).toEqual({ row: 1 });
  });

  it('рубильник выключен — валидатор молчит, всё остальное как было', () => {
    const v = validateUpdTotals(parsed, { detectRecognitionWarnings: true });
    expect(v.hasMismatch).toBe(false);
    expect(v.warnings ?? []).toEqual([]);
  });

  it('подозрение не меняет статус документа: hasMismatch считается по checks', () => {
    const v = validateUpdTotals(parsed, {
      detectRecognitionWarnings: true,
      detectPackPriceScale: true,
    });
    expect(v.checks.every((c) => c.ok)).toBe(true);
    expect(v.hasMismatch).toBe(false);
  });

  it('на красной строке второго ярлыка нет — сигнал получше уже есть', () => {
    const broken = {
      ...parsed,
      items: [{ ...parsed.items[0]!, sum: 99999 }],
    };
    const v = validateUpdTotals(broken, {
      detectRecognitionWarnings: true,
      detectPackPriceScale: true,
    });
    expect(v.hasMismatch).toBe(true);
    expect(v.warnings?.map((w) => w.name) ?? []).not.toContain('price_is_pack_price');
  });

  it('без наименования проверка спит — live-пересчёт не краснеет на пустом месте', () => {
    const noName = {
      ...parsed,
      items: [{ ...parsed.items[0]!, nameRaw: null }],
    };
    const v = validateUpdTotals(noName, {
      detectRecognitionWarnings: true,
      detectPackPriceScale: true,
    });
    expect(v.warnings ?? []).toEqual([]);
  });
});
