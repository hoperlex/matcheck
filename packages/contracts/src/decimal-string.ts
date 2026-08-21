import { z } from 'zod';

/**
 * Числовые поля операций, приходящие строкой.
 *
 * Зачем. Приёмки и отгрузки принимают qty/цену/объём как `z.string()` без
 * формата, и строка уходит в `numeric` как есть. Планшет открывает поле
 * количества десятичной клавиатурой, на русской раскладке разделитель —
 * запятая, и «1,1» валит запрос: `invalid input syntax for type numeric`.
 * Пятисотка здесь дороже, чем кажется: мобильный клиент считает 5xx
 * транзиентной ошибкой и повторяет мутацию бесконечно, а заодно блокирует все
 * последующие правки той же операции — правка инспектора не доезжает никогда.
 *
 * Отсюда правило: то, что клиент реально может набрать, принимаем и
 * нормализуем; всё прочее отвергаем ЧЕТЫРЁХСОТЫМ, а не пятисотым.
 *
 * Обратная совместимость обязательна: значения, которые Postgres принимал до
 * этого модуля, обязаны проходить без изменений — сервер выкатывается без
 * релиза мобильного клиента.
 */

/** Пробелы, которыми разделяют группы тысяч: обычный, NBSP, узкий NBSP. */
const SEP_CLASS = '[ \\u00a0\\u202f]';
const HAS_SEP = new RegExp(SEP_CLASS);
const SEP_GLOBAL = new RegExp(SEP_CLASS, 'g');

/**
 * Целая часть, разбитая на группы по три: «1 200», «1 200 000».
 * Проверяем ИМЕННО группировку, а не просто наличие пробелов: безусловное
 * удаление превратило бы «1 2» в «12», а «12 34» — в «1234», то есть тихо
 * испортило бы число вместо отказа.
 */
const GROUPED = new RegExp(`^\\d{1,3}(?:${SEP_CLASS}\\d{3})+$`);

/**
 * Число после нормализации. Экспоненциальной записи здесь нет намеренно: ни
 * портал, ни планшет её не шлют, а «1e400» прошёл бы любую проверку длины.
 */
const PLAIN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

type Rejection = { ok: false; reason: 'format' | 'overflow' };
type Normalized = { ok: true; value: string | null } | Rejection;

export type DecimalStringOptions = {
  /** precision колонки numeric(p, s). */
  precision: number;
  /** scale колонки numeric(p, s). */
  scale: number;
};

function normalize(raw: string, precision: number, scale: number, limit: bigint): Normalized {
  const trimmed = raw.trim();
  // Пустое значение — это «не заполнено», а не ноль. До сих пор пустая строка
  // тоже доходила до numeric и давала 500.
  if (trimmed === '') return { ok: true, value: null };

  // Все запятые, не первую: «1,200.50» (английский формат) станет «1.200.50» и
  // будет отвергнут проверкой формы. Отказ здесь лучше молчаливой ошибки в
  // тысячу раз.
  let s = trimmed.replace(/,/g, '.');

  if (HAS_SEP.test(s)) {
    const dot = s.indexOf('.');
    const intRaw = dot === -1 ? s : s.slice(0, dot);
    const frac = dot === -1 ? '' : s.slice(dot + 1);
    // В дробной части разделителей групп не бывает.
    if (HAS_SEP.test(frac)) return { ok: false, reason: 'format' };
    const sign = intRaw.startsWith('+') || intRaw.startsWith('-') ? intRaw[0]! : '';
    const digits = sign ? intRaw.slice(1) : intRaw;
    if (!GROUPED.test(digits)) return { ok: false, reason: 'format' };
    s = sign + digits.replace(SEP_GLOBAL, '') + (dot === -1 ? '' : `.${frac}`);
  }

  if (!PLAIN.test(s)) return { ok: false, reason: 'format' };

  // Переполнение считаем ПОСЛЕ округления и целыми числами.
  //
  // Длины целой части недостаточно: 999.999 в numeric(5, 2) — это три цифры до
  // точки, но Postgres округлит его до 1000.00 и вернёт numeric field overflow,
  // то есть снова 500. Округление у numeric — half away from zero, поэтому знак
  // на результат не влияет и сравнивается модуль.
  //
  // BigInt, а не Number: на 18 значащих цифрах double уже врёт. В конструктор
  // уходит короткая строка — целая часть, отсечённая по precision, плюс первые
  // scale цифр дроби, — сколь бы длинной ни была исходная дробная часть.
  const body = s.replace(/^[+-]/, '');
  const dot = body.indexOf('.');
  const intPart = dot === -1 ? body : body.slice(0, dot);
  const frac = dot === -1 ? '' : body.slice(dot + 1);
  const int = intPart.replace(/^0+/, '') || '0';
  if (int.length > precision) return { ok: false, reason: 'overflow' };
  const units = BigInt(int + frac.padEnd(scale, '0').slice(0, scale));
  const rounded = frac.length > scale && frac[scale]! >= '5' ? units + 1n : units;
  if (rounded >= limit) return { ok: false, reason: 'overflow' };

  // Дробную часть не режем: Postgres округляет по scale сам, и это давно
  // работающее поведение, которое менять незачем.
  return { ok: true, value: s };
}

/**
 * Схема для decimal-поля, приходящего строкой: `'1,1'` → `'1.1'`, `'1 200,50'`
 * → `'1200.50'`, пустая строка → `null`. Значения с точкой проходят как есть.
 *
 * Модуль без побочных эффектов и без `.openapi()`: `@matcheck/contracts`
 * импортируется всем API ещё до регистрации auth-роутов, и ошибка на уровне
 * загрузки обрушила бы весь сервис, а не только приёмки.
 */
export function decimalString({ precision, scale }: DecimalStringOptions) {
  // Считается один раз при создании схемы, не на каждый запрос.
  const limit = 10n ** BigInt(precision);
  const maxInt = precision - scale;
  return z
    .string()
    .transform((raw, ctx) => {
      const result = normalize(raw, precision, scale, limit);
      if (!result.ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            result.reason === 'overflow'
              ? `Значение слишком велико: не больше ${maxInt} знаков до запятой`
              : 'Некорректное число: допустимы цифры, знак и один разделитель дробной части',
        });
        return z.NEVER;
      }
      return result.value;
    })
    .nullable()
    .optional();
}
