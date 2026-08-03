/**
 * Габариты JPEG из заголовка, без декодирования пикселей.
 *
 * Нужно, чтобы понять разрешение снимка, скачав из S3 только первые килобайты
 * (см. scripts/audit-photo-dims.ts). Разбор идёт по сегментам верхнего уровня:
 * каждый пропускается по своей длине, поэтому вложенный EXIF-thumbnail внутри
 * APP1 (у него собственные SOI/SOF) не подменяет размеры основного кадра.
 */

/** SOF-маркеры всех режимов. Исключены C4 (DHT), C8 (JPG), CC (DAC) — это не SOF. */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

export type JpegSize = { w: number; h: number };

/**
 * `truncated` — данных не хватило, имеет смысл дочитать больший диапазон.
 * `not-jpeg` — это не JPEG либо структура не даёт габаритов; дочитывать бесполезно.
 */
export type JpegSizeResult = JpegSize | 'truncated' | 'not-jpeg';

export function readJpegSize(buf: Buffer): JpegSizeResult {
  if (buf.length < 2) return 'truncated';
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return 'not-jpeg';

  let i = 2;
  for (;;) {
    if (i >= buf.length) return 'truncated';
    // Между сегментами допустимы fill-байты 0xFF; всё остальное — не наш формат.
    if (buf[i] !== 0xff) return 'not-jpeg';
    while (i < buf.length && buf[i] === 0xff) i++;
    if (i >= buf.length) return 'truncated';

    const marker = buf[i]!;
    i++;

    // Маркеры без полезной нагрузки: SOI, TEM, RST0..RST7.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // EOI или начало сжатых данных раньше SOF — габаритов в файле не будет.
    if (marker === 0xd9) return 'not-jpeg';

    if (i + 1 >= buf.length) return 'truncated';
    const segmentLength = buf.readUInt16BE(i);
    // Длина включает свои же два байта; меньше двух — битый заголовок.
    if (segmentLength < 2) return 'not-jpeg';

    if (SOF_MARKERS.has(marker)) {
      // Тело SOF: length(2) precision(1) height(2) width(2).
      if (i + 7 > buf.length) return 'truncated';
      const h = buf.readUInt16BE(i + 3);
      const w = buf.readUInt16BE(i + 5);
      if (w === 0 || h === 0) return 'not-jpeg';
      return { w, h };
    }
    if (marker === 0xda) return 'not-jpeg';

    i += segmentLength;
    // Ровное попадание в конец буфера — сегмент дочитан, но следующего ещё нет.
    if (i > buf.length) return 'truncated';
  }
}
