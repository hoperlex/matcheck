/**
 * Что за файл пришёл из Диадока: тип и расширение для хранилища.
 *
 * Прежде любое вложение сохранялось как `upd-<номер>.xml` с типом
 * application/xml — и формализованный УПД, и PDF, и скан. Для XML это было
 * верно случайно, для остального — нет: PDF под именем `.xml` нельзя ни
 * распознать, ни открыть, а тип из хранилища уверенно врёт.
 *
 * Тип определяется по содержимому, имя файла — только запасной источник: имя
 * задаёт отправитель, а содержимое не соврёт. Сигнатуры берутся из почтового
 * фильтра вложений, чтобы правила опознания не разъезжались между каналами.
 */
import { sniffMime } from '../mail/attachment-filter.js';

export type EdoFileKind = { mimeType: string; ext: string };

const OCTET = 'application/octet-stream';

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/xml': 'xml',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/zip': 'zip',
  [OCTET]: 'bin',
};

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  xml: 'application/xml',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  zip: 'application/zip',
};

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function extensionOf(fileName: string | null): string | null {
  if (!fileName) return null;
  const m = /\.([a-z0-9]{1,5})$/i.exec(fileName.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * XML у сигнатурного фильтра не распознаётся: там разбирают вложения писем, и
 * XML для них не документ. Для ЭДО это главный формат, поэтому проверяется
 * отдельно — с учётом BOM и кодировки windows-1251, в которой приходят УПД.
 */
function looksLikeXml(buffer: Buffer): boolean {
  let start = 0;
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) start = 3;
  const head = buffer.subarray(start, start + 64).toString('latin1').trimStart();
  if (head.startsWith('<?xml')) return true;
  // Без декларации: корневой элемент сразу. Кириллическое имя в windows-1251
  // даёт байты выше 0x7F — латиница их не покажет буквами. HTML и `<!DOCTYPE`
  // за XML не считаем.
  if (!head.startsWith('<') || head.startsWith('<!') || /^<html/i.test(head)) return false;
  const code = head.charCodeAt(1);
  return /[A-Za-z_]/.test(head.charAt(1)) || code >= 0x80;
}

export function detectEdoFile(buffer: Buffer, fileName: string | null): EdoFileKind {
  const byName = extensionOf(fileName);
  const sniffed = sniffMime(buffer);

  if (sniffed) {
    // ZIP-контейнер — это и xlsx, и docx, и просто архив. Сигнатура их не
    // различает, а имя обычно различает; без имени остаётся xlsx, как у почты.
    if (sniffed === XLSX_MIME && byName && (byName === 'zip' || byName === 'docx')) {
      const mimeType = MIME_BY_EXT[byName]!;
      return { mimeType, ext: byName };
    }
    return { mimeType: sniffed, ext: EXT_BY_MIME[sniffed] ?? 'bin' };
  }

  if (looksLikeXml(buffer)) return { mimeType: 'application/xml', ext: 'xml' };

  if (byName && MIME_BY_EXT[byName]) {
    const mimeType = MIME_BY_EXT[byName]!;
    return { mimeType, ext: EXT_BY_MIME[mimeType] ?? byName };
  }

  return { mimeType: OCTET, ext: 'bin' };
}
