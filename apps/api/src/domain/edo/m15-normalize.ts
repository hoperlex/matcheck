import type { UpdPdfParsed } from '@matcheck/contracts';

/**
 * Толлинг-М-15 (накладная на отпуск давальческого сырья/материалов) часто идёт
 * БЕЗ стоимостной части: графы Цена/Сумма/НДС пустые, а итог в шапке прописан
 * прописью «Ноль руб. 00 коп.». Это легитимно — передача материала в переработку,
 * а не купля-продажа.
 *
 * Vision недетерминирован на такой пустой стоимости: для одного документа
 * возвращает totalSum=0, для другого — null. В null-случае общий UPD save-path
 * трактует пустой totalSum как неполное распознавание (isIncomplete) и уводит
 * документ в partial_parse («распознано частично»), хотя распознан он полностью.
 *
 * Функция доопределяет итог в 0 СТРОГО когда стоимость отсутствует ПОЛНОСТЬЮ
 * (ни в шапке totalSum/vatSum, ни в одной строке price/sum/vatSum) и при этом
 * есть позиции — тогда это точно толлинг-накладная, а не недораспознанный УПД.
 * Во всех прочих случаях (не М-15; М-15 с любой стоимостью; М-15 без позиций)
 * возвращает исходный объект БЕЗ изменений — документ идёт прежним путём.
 *
 * Immutable: вход не мутируется, при срабатывании возвращается поверхностная
 * копия с totalSum/vatSum = 0.
 */
export function normalizeM15ZeroTotals(
  parsed: UpdPdfParsed,
  docKind: string | undefined,
): UpdPdfParsed {
  if (docKind !== 'm15') return parsed;
  // Есть хоть какая-то стоимость в шапке — не толлинг-кейс, не трогаем.
  if (parsed.totalSum != null || parsed.vatSum != null) return parsed;
  // Нет позиций — реально недораспознанный документ, оставляем partial_parse.
  if (parsed.items.length === 0) return parsed;
  // Хоть у одной строки есть стоимость — итог не распознан частично, на проверку.
  const noValuation = parsed.items.every(
    (i) => i.price == null && i.sum == null && i.vatSum == null,
  );
  if (!noValuation) return parsed;
  return { ...parsed, totalSum: 0, vatSum: 0 };
}
