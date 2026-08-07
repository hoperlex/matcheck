/**
 * Лимиты одной поставки на публичной странице загрузки.
 *
 * Живут отдельным модулем, потому что обе зоны формы («УПД и накладные» и
 * «Дополнительные документы») уезжают ОДНИМ запросом, а сервер считает лимиты
 * по запросу целиком. Проверка, размазанная по компоненту, неминуемо разошлась
 * бы с серверной: одна зона прошла бы, а вместе они дали бы 413.
 */
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
// Держим ниже nginx client_max_body_size: иначе он оборвёт запрос сам и
// ответит HTML-страницей, которую наша обработка ошибок увидит как «сервис
// недоступен» вместо понятного «слишком большой объём».
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** Что мешает отправить этот набор файлов; null — всё в порядке. */
export function filesProblem(files: ReadonlyArray<{ name: string; size: number }>): string | null {
  if (files.length === 0) return 'Приложите хотя бы один документ';
  if (files.length > MAX_FILES) return `Не больше ${MAX_FILES} файлов в одной поставке`;
  const big = files.find((f) => f.size > MAX_FILE_BYTES);
  if (big) return `Файл «${big.name}» больше 10 МБ`;
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_TOTAL_BYTES) return 'Суммарный объём поставки больше 20 МБ';
  return null;
}
