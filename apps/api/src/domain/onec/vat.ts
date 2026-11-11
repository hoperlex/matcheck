/**
 * Ставка НДС строки для 1С — с явной неопределённостью.
 *
 * В 1С «0%» и «Без НДС» — разные значения ставки. В данных портала их не
 * различить:
 *  - XML-разбор превращает «без НДС» в null (upd.parser.ts, num()), а PDF-промпт
 *    прямо велит отдавать null при «Без НДС» или прочерке (upd-pdf.parser.ts) —
 *    то есть null значит и «Без НДС», и «не распознано»;
 *  - ноль, наоборот, vat-fields.ts записывает как «законное Без НДС», а XML и
 *    ручной ввод дают ноль и для «0%».
 * Поэтому наружу идёт не догадка, а вид ставки: percent / zero_or_exempt /
 * unknown. Ставку из XML ЭДО не подставляем: строки приёмки со строками XML в
 * портале не сопоставляются (см. docs/ONEC_API.md).
 */
import { abs, cmp, mul, parseDec, shift, sub, ZERO, type Dec } from './money.js';

export type VatRateKind = 'percent' | 'zero_or_exempt' | 'unknown';

export function vatRateKind(rate: string | null): VatRateKind {
  const d = parseDec(rate);
  if (!d) return 'unknown';
  const c = cmp(d, ZERO);
  if (c > 0) return 'percent';
  if (c === 0) return 'zero_or_exempt';
  // Отрицательная ставка — мусор распознавания, а не ставка.
  return 'unknown';
}

const ONE_RUBLE: Dec = { v: 1n, s: 0 };

/**
 * Расходится ли хранимый НДС строки с «сумма без НДС × ставка» — только
 * предупреждение для 1С, значения не меняет.
 *
 * Допуск — тот же принцип, что у построчной сверки портала (upd-validation.ts,
 * шаг 4): max(1 ₽, 0,1% суммы без НДС). Поставщики считают НДС от неокруглённой
 * цены, а печатают округлённую; допуск в копейку срабатывал бы почти на каждой
 * строке документа, где НДС скопирован из графы 8.
 */
export function vatMismatch(sumExVat: Dec, ratePercent: Dec, vatSum: Dec): boolean {
  const expected = shift(mul(sumExVat, ratePercent), 2);
  const diff = abs(sub(expected, vatSum));
  const relative = shift(abs(sumExVat), 3); // 0,1%
  const tolerance = cmp(relative, ONE_RUBLE) > 0 ? relative : ONE_RUBLE;
  return cmp(diff, tolerance) > 0;
}

