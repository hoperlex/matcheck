/**
 * Поля НДС строки при сохранении карточки документа.
 *
 * Зачем отдельный модуль. PATCH карточки заменяет позиции целиком — удаляет и
 * вставляет заново, — а `vat_rate`/`vat_sum` в новую запись не попадали вовсе.
 * То есть первая же правка документа менеджером обнуляла НДС у всех строк, и
 * дальше карточка не могла ни показать цену с налогом, ни проверить арифметику
 * по ставке. Дефект тихий: суммы остаются на месте, пропадает только разбивка.
 *
 * Почему налог ПЕРЕСЧИТЫВАЕТСЯ, а не переносится из прежней записи. Сумму
 * строки пользователь мог только что исправить — ради этого карточку и
 * открывают. Прежний `vat_sum` к новой сумме уже не относится, и сохранить его
 * значило бы получить строку, где налог не бьётся ни со ставкой, ни с суммой.
 * Ставка при этом остаётся той, что напечатана в бланке: её правка ценой или
 * суммой не меняется.
 */

/** Сумма строки хранится С НАЛОГОМ (графа 9), поэтому налог из неё выделяется. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function toNumber(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Что записать в `vat_rate` и `vat_sum` строки.
 *
 * Ставка не пришла — оба поля пустые, как и было до появления этого кода:
 * старые клиенты и документы без НДС ведут себя по-прежнему.
 *
 * @param vatRate ставка в процентах, как её прислал клиент
 * @param sum стоимость строки С НАЛОГОМ (графа 9)
 */
export function vatFieldsOf(
  vatRate: number | string | null | undefined,
  sum: number | string | null | undefined,
): { vatRate: string | null; vatSum: string | null } {
  const rate = toNumber(vatRate);
  if (rate === null) return { vatRate: null, vatSum: null };

  // Нулевая ставка — законное «Без НДС»: ставку сохраняем, налог нулевой.
  if (rate <= 0) return { vatRate: rate.toString(), vatSum: '0' };

  const total = toNumber(sum);
  // Суммы нет — сохранить ставку всё равно нужно: по ней считается цена с
  // налогом в карточке. А выдумывать налог не из чего.
  if (total === null) return { vatRate: rate.toString(), vatSum: null };

  const base = total / (1 + rate / 100);
  return { vatRate: rate.toString(), vatSum: round2(total - base).toString() };
}
