/**
 * Точечная правка query-параметров URL: патч поверх текущих, а не замена всего
 * набора.
 *
 * Три значения — три разных смысла, и путать их нельзя:
 *   `undefined` — параметр в патче не участвует, остаётся как был;
 *   `null` / `''` — параметр снимается;
 *   строка — параметр ставится.
 *
 * Разница между первым и вторым — не формальность. Панель фильтров шлёт
 * ЧАСТИЧНЫЙ патч (`onChange({ q })`), а недостающие ключи родитель заполняет
 * `undefined` в значении «не трогать». Пока эту ветку не отделяли, ввод номера
 * документа снимал выбранные объект, подрядчика и поставщика: `Object.entries`
 * отдаёт и ключи со значением `undefined`, и они уходили в `delete`.
 *
 * Пустой массив id превращается в `null` (см. toCsvIds) — это «снять фильтр»,
 * и такой патч по-прежнему удаляет параметр.
 */
export type SearchParamsPatch = Record<string, string | null | undefined>;

export function patchSearchParams(
  current: URLSearchParams,
  patch: SearchParamsPatch,
): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value) next.set(key, value);
    else next.delete(key);
  }
  return next;
}
