/**
 * Десятичные строки на входе приёмок и отгрузок.
 *
 * Почему набор живёт здесь, а не рядом со схемами: у @matcheck/contracts нет ни
 * Vitest, ни команды test — только typecheck и gen:openapi, так что тест там
 * никто бы не запустил.
 *
 * Главное требование — обратная совместимость: сервер выкатывается без релиза
 * мобильного клиента, поэтому всё, что Postgres принимал раньше, обязано
 * проходить и сейчас, причём без изменения значения.
 */
import { describe, expect, it } from 'vitest';
import {
  decimalString,
  DeliveryUpsertItemSchema,
  ShipmentUpsertItemSchema,
} from '@matcheck/contracts';

// Параметры реальных колонок: qty/price — numeric(18,4), ставка НДС — numeric(5,2).
const qty = decimalString({ precision: 18, scale: 4 });
const vatRate = decimalString({ precision: 5, scale: 2 });

const parse = (schema: typeof qty, raw: unknown) => schema.safeParse(raw);
const ok = (schema: typeof qty, raw: unknown) => {
  const r = schema.safeParse(raw);
  if (!r.success) throw new Error(`ожидался успех, получено: ${r.error.issues[0]?.message}`);
  return r.data;
};

// Разделители групп тысяч ЗАДАЮТСЯ КОДАМИ: глазами обычный пробел, U+00A0 и
// U+202F неразличимы, и молча испорченный тест никто не заметит.
const NBSP = '\u00a0';
const NNBSP = '\u202f';

describe('decimalString: обратная совместимость', () => {
  it('значения, которые Postgres принимал и раньше, проходят без изменения', () => {
    expect(ok(qty, '0')).toBe('0');
    expect(ok(qty, '1')).toBe('1');
    expect(ok(qty, '1.5')).toBe('1.5');
    expect(ok(qty, '2.0000')).toBe('2.0000');
    expect(ok(qty, '-1.5')).toBe('-1.5');
    expect(ok(qty, '+1.5')).toBe('+1.5');
  });

  it('null и отсутствие поля сохраняют прежнюю семантику', () => {
    expect(ok(qty, null)).toBeNull();
    expect(ok(qty, undefined)).toBeUndefined();
  });

  it('дробная часть длиннее 64 символов проходит — её округляет Postgres, не мы', () => {
    const long = `1.${'9'.repeat(120)}`;
    expect(ok(qty, long)).toBe(long);
  });
});

describe('decimalString: починка запятой', () => {
  it('десятичная запятая с планшета становится точкой', () => {
    expect(ok(qty, '1,1')).toBe('1.1');
    expect(ok(qty, '1,')).toBe('1.');
    expect(ok(qty, ',5')).toBe('.5');
  });

  it('пустая строка — это «не заполнено», а не ноль', () => {
    expect(ok(qty, '')).toBeNull();
    expect(ok(qty, '   ')).toBeNull();
  });

  it('разделитель групп тысяч убирается — все три вида пробела', () => {
    expect(ok(qty, '1 200,50')).toBe('1200.50');
    expect(ok(qty, `1${NBSP}200,50`)).toBe('1200.50');
    expect(ok(qty, `1${NNBSP}200,50`)).toBe('1200.50');
    expect(ok(qty, `1${NBSP}200${NBSP}000`)).toBe('1200000');
  });
});

describe('decimalString: отказ вместо тихой порчи', () => {
  it('пробел не в позиции разделителя тысяч — отказ, а не склейка цифр', () => {
    // Безусловное удаление превратило бы это в 12 и 1234.
    expect(parse(qty, '1 2').success).toBe(false);
    expect(parse(qty, '12 34').success).toBe(false);
    expect(parse(qty, '1 20').success).toBe(false);
  });

  it('английский формат отвергается, а не читается в тысячу раз меньше', () => {
    expect(parse(qty, '1,200.50').success).toBe(false);
  });

  it('нечисловое и экспонента', () => {
    for (const raw of ['две штуки', '1.2.3', '1e400', '0x10', '.', '-', '1..2']) {
      expect(parse(qty, raw).success, `должно быть отвергнуто: ${raw}`).toBe(false);
    }
  });
});

describe('decimalString: переполнение считается после округления', () => {
  it('999.994 влезает в numeric(5,2), 999.995 — уже нет', () => {
    // Длины целой части недостаточно: у обоих значений три цифры до точки, но
    // второе Postgres округлит до 1000.00 и вернёт numeric field overflow.
    expect(ok(vatRate, '999.994')).toBe('999.994');
    expect(parse(vatRate, '999.995').success).toBe(false);
  });

  it('округление half away from zero — знак на результат не влияет', () => {
    expect(ok(vatRate, '-999.994')).toBe('-999.994');
    expect(parse(vatRate, '-999.995').success).toBe(false);
  });

  it('слишком длинная целая часть отвергается', () => {
    expect(parse(vatRate, '1000').success).toBe(false);
    expect(parse(qty, '1'.repeat(15)).success).toBe(false);
    expect(ok(qty, '1'.repeat(14))).toBe('1'.repeat(14));
  });

  it('ведущие нули значимыми цифрами не считаются', () => {
    expect(ok(qty, '000000000000001.5')).toBe('000000000000001.5');
    expect(ok(vatRate, '0000020.00')).toBe('0000020.00');
  });
});

describe('обе item-схемы переведены на хелпер', () => {
  const base = { nameRaw: 'Кабель силовой', lineNo: 1 };
  const numericFields = [
    'qtyPlanned',
    'qtyActual',
    'volumeM3',
    'massKg',
    'price',
    'vatRate',
    'vatSum',
  ] as const;

  for (const [name, schema] of [
    ['приёмка', DeliveryUpsertItemSchema],
    ['отгрузка', ShipmentUpsertItemSchema],
  ] as const) {
    it(`${name}: запятая нормализуется во всех семи числовых полях`, () => {
      for (const field of numericFields) {
        const parsed = schema.safeParse({ ...base, [field]: '1,1' });
        expect(parsed.success, `${field} не переведён на decimalString`).toBe(true);
        if (parsed.success) {
          expect(parsed.data[field], `${field}`).toBe('1.1');
        }
      }
    });

    it(`${name}: ставка НДС уважает свою точность numeric(5,2)`, () => {
      expect(schema.safeParse({ ...base, vatRate: '20' }).success).toBe(true);
      expect(schema.safeParse({ ...base, vatRate: '999.995' }).success).toBe(false);
      // А то же значение в qty (numeric(18,4)) — законно.
      expect(schema.safeParse({ ...base, qtyActual: '999.995' }).success).toBe(true);
    });

    it(`${name}: нечисловое значение даёт ошибку валидации, а не падение на numeric`, () => {
      const parsed = schema.safeParse({ ...base, qtyActual: 'две штуки' });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.path).toEqual(['qtyActual']);
      }
    });
  }
});
