// Фильтр вложений письма: что берём в обработку, что откладываем, что
// отбрасываем.
//
// Письма приходят от кого угодно (решение пользователя: отправитель любой),
// поэтому вложения — недоверенный вход. Отсюда три принципа.
//
// 1. Тип определяется СОДЕРЖИМЫМ, а не расширением. Подрядчики переименовывают
//    файлы («скан.pdf», внутри которого JPEG) — это норма, и отбрасывать такое
//    нельзя. А вот исполняемое под видом накладной пройти не должно.
// 2. Фильтр ничего не удаляет молча. Подозрительное помечается и остаётся
//    доступным оператору: признаки подписи по отдельности («меньше 25 КБ»,
//    «имя image001») отбросили бы и настоящий скан УПД.
// 3. xlsx — это ZIP, а значит вектор для zip-бомбы. Проверяем ДО распаковки:
//    число элементов, суммарный распакованный размер и степень сжатия. Ratio
//    ловит то, что первые два пропустят: 50 КБ, разжимающиеся в гигабайт.
//
// Модуль чистый: ни сети, ни БД, ни файловой системы.

/** Состояние вложения — совпадает с `mail_attachments.state`. */
export type AttachmentState = 'kept' | 'suspected_signature' | 'skipped';

export type AttachmentLimits = {
  /** Максимальный размер одного вложения. */
  maxBytes: number;
  /** Максимум элементов внутри xlsx. */
  xlsxMaxEntries: number;
  /** Максимальный суммарный распакованный размер xlsx. */
  xlsxMaxInflatedBytes: number;
  /** Максимальная степень сжатия xlsx. */
  xlsxMaxRatio: number;
  /** Ниже этого размера картинка может быть элементом подписи. */
  signatureMaxBytes: number;
};

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxBytes: 25 * 1024 * 1024,
  xlsxMaxEntries: 512,
  xlsxMaxInflatedBytes: 100 * 1024 * 1024,
  xlsxMaxRatio: 200,
  signatureMaxBytes: 25 * 1024,
};

export type AttachmentInput = {
  filename: string | null;
  declaredMime: string | null;
  buffer: Buffer;
  /** Вложение лежит в multipart/related — типично для картинок вёрстки письма. */
  isRelated?: boolean;
  /** На его Content-ID ссылается html-часть — то есть это картинка вёрстки. */
  cidReferenced?: boolean;
};

export type AttachmentVerdict = {
  state: AttachmentState;
  /** Тип по содержимому; null — не опознан. */
  sniffedMime: string | null;
  /** Заполняется для skipped и suspected_signature. */
  reason?: string;
};

/** Типы, которые умеет разбирать конвейер (см. /upload-documents). */
const SUPPORTED = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);

const ZIP_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function startsWith(buf: Buffer, bytes: readonly number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

/**
 * Определение типа по сигнатуре. Возвращает null, если тип не опознан —
 * такое вложение в обработку не идёт.
 */
export function sniffMime(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;

  // %PDF
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf';
  // JPEG: FF D8 FF
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  // PNG
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // RIFF....WEBP
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  // HEIC/HEIF: ....ftyp + бренд
  if (startsWith(buffer, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = buffer.subarray(8, 12).toString('latin1');
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1', 'heim'].includes(brand)) return 'image/heic';
  }
  // OLE2 — старый .xls
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return 'application/vnd.ms-excel';
  }
  // ZIP — xlsx (а также docx/zip; уточняется по содержимому контейнера)
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) return ZIP_MIME;

  return null;
}

export type ZipInspection =
  | { ok: true; entries: number; compressed: number; inflated: number; ratio: number }
  | { ok: false; reason: string };

const EOCD_SIGNATURE = 0x06054b50;
const CD_ENTRY_SIGNATURE = 0x02014b50;
const ZIP64_MARKER = 0xffffffff;

/**
 * Читает central directory ZIP-контейнера, НЕ распаковывая его.
 *
 * Так лимиты проверяются до того, как распаковка успеет съесть память: у
 * zip-бомбы объявленные размеры уже выдают её с головой.
 */
export function inspectZip(buffer: Buffer): ZipInspection {
  // EOCD лежит в конце и может иметь комментарий до 64 КБ.
  const tailStart = Math.max(0, buffer.length - (22 + 0xffff));
  let eocd = -1;
  for (let i = buffer.length - 22; i >= tailStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { ok: false, reason: 'zip_no_central_directory' };

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (cdOffset === ZIP64_MARKER) return { ok: false, reason: 'zip64_not_supported' };
  if (cdOffset >= buffer.length) return { ok: false, reason: 'zip_bad_offset' };

  let entries = 0;
  let compressed = 0;
  let inflated = 0;
  let p = cdOffset;
  while (p + 46 <= buffer.length && buffer.readUInt32LE(p) === CD_ENTRY_SIGNATURE) {
    const c = buffer.readUInt32LE(p + 20);
    const u = buffer.readUInt32LE(p + 24);
    // ZIP64 прячет реальные размеры в extra-поле; для xlsx из 1С такого не
    // бывает, поэтому считаем это подозрительным, а не разбираем.
    if (c === ZIP64_MARKER || u === ZIP64_MARKER) return { ok: false, reason: 'zip64_not_supported' };
    compressed += c;
    inflated += u;
    entries += 1;
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    p += 46 + nameLen + extraLen + commentLen;
  }

  if (entries === 0) return { ok: false, reason: 'zip_empty' };
  // Расхождение с заголовком EOCD — признак битого или подделанного архива.
  if (totalEntries !== entries && totalEntries !== 0xffff) {
    return { ok: false, reason: 'zip_entry_count_mismatch' };
  }

  const ratio = compressed > 0 ? inflated / compressed : inflated > 0 ? Infinity : 1;
  return { ok: true, entries, compressed, inflated, ratio };
}

/**
 * Решение по одному вложению.
 *
 * `skipped` — файл конвейеру не подходит (не тот тип, слишком большой,
 * подозрительный архив). `suspected_signature` — похоже на картинку из вёрстки
 * письма, но файл сохраняется и возвращается оператором одним действием.
 */
export function classifyAttachment(
  input: AttachmentInput,
  limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS,
): AttachmentVerdict {
  const { buffer } = input;

  if (buffer.length === 0) return { state: 'skipped', sniffedMime: null, reason: 'empty' };
  if (buffer.length > limits.maxBytes) {
    return { state: 'skipped', sniffedMime: sniffMime(buffer), reason: 'too_large' };
  }

  const sniffed = sniffMime(buffer);
  if (!sniffed || !SUPPORTED.has(sniffed)) {
    // Расширение здесь не спасает: содержимое решает. Причина сохраняется,
    // чтобы оператор видел, почему файл не пошёл в обработку.
    return { state: 'skipped', sniffedMime: sniffed, reason: 'unsupported_type' };
  }

  if (sniffed === ZIP_MIME) {
    const zip = inspectZip(buffer);
    if (!zip.ok) return { state: 'skipped', sniffedMime: sniffed, reason: zip.reason };
    if (zip.entries > limits.xlsxMaxEntries) {
      return { state: 'skipped', sniffedMime: sniffed, reason: 'xlsx_too_many_entries' };
    }
    if (zip.inflated > limits.xlsxMaxInflatedBytes) {
      return { state: 'skipped', sniffedMime: sniffed, reason: 'xlsx_inflated_too_large' };
    }
    if (zip.ratio > limits.xlsxMaxRatio) {
      return { state: 'skipped', sniffedMime: sniffed, reason: 'xlsx_ratio_suspicious' };
    }
  }

  // Подпись отсеиваем ТОЛЬКО по совокупности признаков. Каждый по отдельности
  // встречается и у настоящих сканов: скан бывает мелким, а картинка из
  // вёрстки — крупной.
  const looksLikeSignature =
    input.isRelated === true &&
    input.cidReferenced === true &&
    sniffed.startsWith('image/') &&
    buffer.length < limits.signatureMaxBytes;
  if (looksLikeSignature) {
    return { state: 'suspected_signature', sniffedMime: sniffed, reason: 'inline_image_in_html' };
  }

  return { state: 'kept', sniffedMime: sniffed };
}
