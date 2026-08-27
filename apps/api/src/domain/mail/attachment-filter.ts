// Фильтр вложений письма: что берём в обработку, что откладываем, что
// отбрасываем.
//
// Письма приходят от кого угодно (решение пользователя: отправитель любой),
// поэтому вложения — недоверенный вход. Отсюда три принципа.
//
// 1. Тип определяется СОДЕРЖИМЫМ, а не расширением. Подрядчики переименовывают
//    файлы («скан.pdf», внутри которого JPEG) — это норма, и отбрасывать такое
//    нельзя. А вот исполняемое под видом накладной пройти не должно.
// 2. Фильтр ничего не удаляет. Подозрительное помечается и остаётся доступным
//    оператору — безопасность держится на ОБРАТИМОСТИ решения, а не на
//    строгости условия. Ошиблись — оператор возвращает файл одной кнопкой, и
//    он идёт в пакет наравне с остальными.
// 3. xlsx — это ZIP, а значит вектор для zip-бомбы. Проверяем ДО распаковки:
//    число элементов, суммарный распакованный размер и степень сжатия. Ratio
//    ловит то, что первые два пропустят: 50 КБ, разжимающиеся в гигабайт.
//
// Модуль чистый: ни сети, ни БД, ни файловой системы.

// CFB — часть SheetJS, читающая контейнер OLE2 (он же Compound File Binary),
// в котором лежит старый .xls. Импорт ИМЕННО default-ом: при
// `import * as XLSX from 'xlsx'` в namespace попадают только read/write/utils
// и подобные, а `XLSX.CFB` оказывается undefined — проверка ниже молча
// возвращала бы false для каждой настоящей книги.
import XLSX from 'xlsx';

/** Состояние вложения — совпадает с `mail_attachments.state`. */
export type AttachmentState = 'kept' | 'suspected_signature' | 'skipped';

/**
 * Состояния, при которых вложение остаётся видимым оператору.
 *
 * Письмо, где есть хоть одно такое, идёт в разбор. Считать только по `kept`
 * нельзя: письмо, целиком состоящее из картинок подписи, получило бы статус
 * `no_attachments` — а он не показывается в разборе и удаляется уборкой вместе
 * с файлами. То есть письмо исчезло бы молча.
 */
export const REVIEWABLE_ATTACHMENT_STATES = ['kept', 'suspected_signature'] as const;

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

/**
 * Имена картинок, которые генерирует почтовый клиент, а не отправитель.
 * Регулярка якорная и без ветвлений: вход недоверенный, ReDoS исключён.
 */
const MAIL_CLIENT_STAMP_RE = /^(?:outlookemoji-|mailrusigimg[-_])/i;

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
 * Действительно ли ZIP-контейнер — это книга Excel.
 *
 * `sniffMime` отдаёт xlsx-MIME ЛЮБОМУ zip (сигнатура `PK\x03\x04` общая для
 * xlsx, docx, pptx, jar и обычного архива), а `inspectZip` смотрит только на
 * размеры. Для почты этого достаточно — там отправитель известен. Для
 * публичной загрузки от неизвестного отправителя нет: переименованный docx или
 * архив с чем угодно внутри дошёл бы до парсера как «таблица».
 *
 * Проверяем по именам записей central directory: у OOXML обязателен
 * `[Content_Types].xml`, а книгу Excel от документа Word отличает `xl/`.
 */
export function isXlsxContainer(buffer: Buffer): boolean {
  const tailStart = Math.max(0, buffer.length - (22 + 0xffff));
  let eocd = -1;
  for (let i = buffer.length - 22; i >= tailStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return false;

  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (cdOffset === ZIP64_MARKER || cdOffset >= buffer.length) return false;

  let hasContentTypes = false;
  let hasWorkbook = false;
  let p = cdOffset;
  while (p + 46 <= buffer.length && buffer.readUInt32LE(p) === CD_ENTRY_SIGNATURE) {
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const name = buffer.subarray(p + 46, p + 46 + nameLen).toString('latin1');
    if (name === '[Content_Types].xml') hasContentTypes = true;
    // xl/workbook.xml — обычная книга; xl/workbook.bin — формат xlsb, который
    // тоже приходит от 1С.
    if (name === 'xl/workbook.xml' || name === 'xl/workbook.bin') hasWorkbook = true;
    if (hasContentTypes && hasWorkbook) return true;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return false;
}

/**
 * Действительно ли OLE2-контейнер — это книга Excel.
 *
 * Пара к `isXlsxContainer`, только для старого формата. `sniffMime` отдаёт
 * `application/vnd.ms-excel` ЛЮБОМУ файлу с сигнатурой D0 CF 11 E0, а она общая
 * у .xls, .doc и .ppt — это один контейнер Microsoft. Для почты различать их не
 * требуется (отправитель известен), для публичной загрузки от неизвестного
 * отправителя — обязательно: иначе вордовский документ дошёл бы до парсера как
 * «таблица».
 *
 * Смотрим КОРНЕВОЙ поток: у книги это `Workbook` (BIFF8) или `Book` (BIFF5), у
 * Word — `WordDocument`, у PowerPoint — `PowerPoint Document`. Искать имя среди
 * всех путей контейнера нельзя: .doc с внедрённой таблицей несёт
 * `ObjectPool/_1234567890/Workbook` и прошёл бы как книга.
 */
export function isXlsWorkbook(buffer: Buffer): boolean {
  try {
    const cfb = XLSX.CFB.read(buffer, { type: 'buffer' });
    if (XLSX.CFB.find(cfb, '/WordDocument')) return false;
    if (XLSX.CFB.find(cfb, '/PowerPoint Document')) return false;
    return Boolean(XLSX.CFB.find(cfb, '/Workbook') || XLSX.CFB.find(cfb, '/Book'));
  } catch {
    // Обрезанный или битый контейнер: CFB.read бросает. Книгой это не является,
    // и разбирать такой файл всё равно нечем.
    return false;
  }
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

  // ─── Картинки подписи и вёрстки письма ───────────────────────────────────
  //
  // Признаки MIME-структуры (multipart/related плюс ссылка из html по
  // Content-ID) на реальной почте не работают: Outlook и mail.ru кладут иконки
  // подписи в multipart/mixed без Content-ID, а html-части у письма может не
  // быть вовсе. На боевом ящике прежнее условие не сработало НИ РАЗУ — 43
  // иконки от 121 байта ушли бы в распознавание как документы.
  //
  // Поэтому решает размер, а не структура. Настоящий документ так не выглядит:
  // самое лёгкое изображение корпуса docs/debug-upd — 139 КБ, самый лёгкий PDF
  // на проде — 48 КБ. Скан А4 в 25 КБ нечитаем, и распознавание вернуло бы по
  // нему мусор, даже будь это действительно документ.
  //
  // Порог применяется ТОЛЬКО к изображениям: самый лёгкий реальный документ —
  // xlsx-подтверждение отгрузки на 10 КБ, и оно обязано остаться документом.
  const isImage = sniffed.startsWith('image/');
  if (isImage && buffer.length < limits.signatureMaxBytes) {
    return { state: 'suspected_signature', sniffedMime: sniffed, reason: 'small_image' };
  }

  // Штамп, который вставляет в тело письма сам почтовый клиент: Outlook —
  // `OutlookEmoji-<время><uuid>`, mail.ru — `mailrusigimg_<id>`. Имя генерирует
  // клиент, у скана его быть не может, поэтому размер здесь не важен: на проде
  // такие «эмодзи» весят 174 КБ и приходят по восемь штук на письмо.
  if (isImage && MAIL_CLIENT_STAMP_RE.test(input.filename ?? '')) {
    return { state: 'suspected_signature', sniffedMime: sniffed, reason: 'mail_client_stamp' };
  }

  return { state: 'kept', sniffedMime: sniffed };
}
