/**
 * Картинка ли это по имени файла — и какой у неё mime.
 *
 * Отдельный модуль, потому что цена ошибки высокая и уже оплачена. Пока
 * список расширений жил в worker.ts и состоял из jpg/png/webp, файл `.jfif`
 * (тот же JPEG, так его сохраняют Outlook и Windows) считался НЕ картинкой —
 * и второй проход распознавания отправлял его в pdftoppm как PDF. Итог:
 * «May not be a PDF file», parse_failed, документ потерян. 21.08 так осыпались
 * 8 документов за два часа.
 *
 * Расширение — единственный доступный признак в тех точках, где буфер уже
 * скачан по s3-ключу, а mime вложения рядом не лежит. Там, где mime доступен,
 * он имеет приоритет: см. вызовы с `mime.startsWith('image/')`.
 */

/** Расширение → mime. Порядок не важен, ключи в нижнем регистре. */
const MIME_BY_EXT: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.png$/i, 'image/png'],
  [/\.webp$/i, 'image/webp'],
  [/\.(heic|heif)$/i, 'image/heic'],
  [/\.avif$/i, 'image/avif'],
  [/\.bmp$/i, 'image/bmp'],
  [/\.gif$/i, 'image/gif'],
  // .jfif и .jfi — обычный JPEG под другим именем; .pjpeg — progressive JPEG.
  [/\.(jpe?g|jfif|jfi|pjpeg)$/i, 'image/jpeg'],
];

/**
 * mime картинки по имени/ключу файла, либо null — если это не изображение.
 *
 * @param key имя файла или s3-ключ (расширение берётся с конца строки)
 */
export function imageMimeOfKey(key: string): string | null {
  for (const [re, mime] of MIME_BY_EXT) {
    if (re.test(key)) return mime;
  }
  return null;
}
