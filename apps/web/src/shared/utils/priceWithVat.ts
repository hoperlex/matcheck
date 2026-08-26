/**
 * Цена за единицу С НАЛОГОМ — величина вычисляемая.
 *
 * В бланке УПД такой графы нет вовсе: форма 1137 содержит цену за единицу
 * только БЕЗ налога (графа 4), а с налогом там лишь стоимость всей строки
 * (графа 9). Поэтому цена с НДС нигде не хранится и не может храниться — она
 * считается на лету для показа.
 *
 * Зачем это понадобилось. В карточке документа рядом стоят цена из графы 4 и
 * сумма из графы 9, и арифметика на экране не сходится: 15 × 240 = 3 600 при
 * показанной сумме 4 392. Для менеджера это выглядит ошибкой распознавания,
 * хотя оба числа прочитаны верно.
 *
 * Почему нельзя просто поделить сумму на количество. Такой способ даёт верный
 * ответ, только если сумма прочитана правильно, — а именно суммы и страдают
 * при ошибках распознавания. Пересчёт по ставке от цены остаётся корректным
 * даже на документе, где сумма съехала.
 */

/**
 * Ставка НДС документа целиком, выведенная из шапки.
 *
 * Нужна для строк, где модель не извлекла ставку (179 позиций за месяц из 5288).
 * Формула повторяет боевую валидацию (upd-validation.ts, effectiveDocVatRate) —
 * две реализации одного правила разъехались бы, и карточка показывала бы не то,
 * что проверяет сервер.
 */
function effectiveDocVatRate(
  totalSum: string | null | undefined,
  vatSum: string | null | undefined,
): number | null {
  if (totalSum == null || totalSum === '' || vatSum == null || vatSum === '') return null;
  const total = Number(totalSum);
  const vat = Number(vatSum);
  if (!Number.isFinite(total) || !Number.isFinite(vat)) return null;
  // Налога нет — ставка нулевая, а не «неизвестная»: цена и есть цена с НДС.
  if (vat <= 0) return 0;
  const base = total - vat;
  // Бессмысленная шапка (налог больше суммы) — лучше не знать ставку, чем
  // выдумать её и показать неверное число.
  if (base <= 0) return null;
  return (vat / base) * 100;
}

/**
 * Цена за единицу с налогом, строкой — в том же виде, в каком приходят деньги
 * из API (numeric отдаётся строкой), чтобы результат можно было передать в
 * formatMoneyRu без преобразований.
 *
 * Возвращает исходную цену, когда пересчитать нечем: ставки нет ни в строке, ни
 * в шапке, либо налог нулевой. Это законный случай — 172 позиции за месяц
 * приходят из документов вовсе без НДС, и там цена с налогом равна цене.
 *
 * @param price цена за единицу без налога (графа 4), как хранится в базе
 * @param vatRate ставка строки в процентах; null — не распозналась
 * @param docTotalSum «Всего к оплате» документа, с налогом
 * @param docVatSum сумма налога по документу
 */
export function priceWithVat(
  price: string | null | undefined,
  vatRate: string | null | undefined,
  docTotalSum: string | null | undefined,
  docVatSum: string | null | undefined,
): string | null {
  if (price == null || price === '') return null;
  const base = Number(price);
  if (!Number.isFinite(base)) return null;

  const rate = vatRateOf(vatRate, docTotalSum, docVatSum);
  if (rate == null || rate <= 0) return price;

  return round4(base * (1 + rate / 100)).toString();
}

/**
 * Обратный пересчёт: пользователь ввёл цену с налогом, в базу уходит без него.
 *
 * Применять ТОЛЬКО к значению, которое человек действительно ввёл. Нетронутая
 * строка обязана сохраняться как есть: пересчёт туда-обратно расходится
 * примерно у одной позиции из тысячи (проверено на 4498 боевых позициях —
 * разошлись 5, максимум на 0,0073 ₽). Прогонять через него весь список при
 * сохранении значило бы тихо править цены, которых никто не касался.
 */
export function priceWithoutVat(
  priceWithTax: number | null,
  vatRate: string | null | undefined,
  docTotalSum: string | null | undefined,
  docVatSum: string | null | undefined,
): string | null {
  if (priceWithTax == null || !Number.isFinite(priceWithTax)) return null;

  const rate = vatRateOf(vatRate, docTotalSum, docVatSum);
  if (rate == null || rate <= 0) return String(priceWithTax);

  return round4(priceWithTax / (1 + rate / 100)).toString();
}

/**
 * Ставка строки, а при её отсутствии — ставка документа из шапки.
 *
 * Ставка вне 0..100 отбрасывается: при битом разборе в графе 7 оказывается
 * что угодно, и «2200 %» превратили бы цену 240 ₽ в 5 520 ₽ на экране. Лучше
 * показать цену как есть, чем правдоподобное, но выдуманное число.
 */
function vatRateOf(
  vatRate: string | null | undefined,
  docTotalSum: string | null | undefined,
  docVatSum: string | null | undefined,
): number | null {
  if (vatRate != null && vatRate !== '') {
    const rate = Number(vatRate);
    if (Number.isFinite(rate) && rate >= 0 && rate <= 100) return rate;
    // Ставка есть, но бессмысленная — на шапку не переходим: она относится ко
    // всему документу и к этой конкретной строке отношения может не иметь.
    return null;
  }
  return effectiveDocVatRate(docTotalSum, docVatSum);
}

/**
 * Округление до четырёх знаков — столько хранит колонка `price` (numeric(18,4)).
 *
 * До копеек округлять нельзя: цена «66,294» превратилась бы при паре
 * пересчётов в «66,3», то есть правка карточки молча портила бы цену. До
 * двух знаков доводит уже formatMoneyRu при выводе на экран.
 */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
