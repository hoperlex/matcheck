/**
 * Разбор строк-сторон УПД из текстового представления документа.
 *
 * Функция вынесена из upd-xlsx.parser.ts БЕЗ изменений: XLSX-путь ею
 * пользуется давно и regression-тестами закрыт, а PDF-путь имел собственную
 * регулярку графы 4, которая на формате с двоеточием захватывала сам ярлык
 * («Грузополучатель и его адрес:» → в поле попадало «и его адрес:»). Общий
 * модуль вместо второй реализации — чтобы обе формы разбирались одним и тем
 * же кодом и расхождение больше не могло возникнуть.
 */

/**
 * Достаёт значение стороны из строки вида «<подпись> <значение> <терминатор>».
 *
 * @param line          строка документа
 * @param prefixRe      подпись графы; двоеточие описывается как `:?`
 * @param terminatorAlt альтернация того, чем значение заканчивается —
 *                      номер графы, следующая подпись, «ИНН», «Валюта:»
 * @returns значение без хвостового тега графы, либо null — если подпись не
 *          найдена или после неё пусто. Возврат null вместо подписи —
 *          principial: пустая графа не должна выглядеть заполненной.
 */
export function matchParty(
  line: string,
  prefixRe: RegExp,
  terminatorAlt: RegExp,
): string | null {
  const startMatch = prefixRe.exec(line);
  if (!startMatch) return null;
  const tail = line.slice(startMatch.index + startMatch[0].length);
  const endMatch = terminatorAlt.exec(tail);
  const raw = (endMatch ? tail.slice(0, endMatch.index) : tail).trim();
  if (!raw) return null;
  return raw.replace(/\s*\(\d+[а-я]?\)\s*$/u, '').trim() || null;
}
