// Сбор multipart-запроса загрузки документов.
//
// Почему один проход. Поля формы становятся доступны только ПО ХОДУ чтения
// потока: до того, как тело прочитано, ни honeypot, ни siteId ещё не известны.
// Поэтому коллектор возвращает и поля, и файлы разом, а решения (бот? объект
// существует?) принимает вызывающий — уже после чтения, но ДО записи в БД, S3
// и очередь. Бот в итоге не порождает ни строк, ни объектов: его тело просто
// безопасно читается и отбрасывается.

import type { FastifyRequest } from 'fastify';
import {
  classifyAttachment,
  isXlsxContainer,
  sniffMime,
} from '../mail/attachment-filter.js';
import { safeName } from './bundle-key.js';
import type { IngestFile } from './ingest-bundle.js';

export type UploadLimits = {
  maxFiles: number;
  maxFileBytes: number;
  /** Суммарный потолок файлов. Держим ниже nginx client_max_body_size. */
  maxTotalBytes: number;
  maxFields: number;
  maxFieldBytes: number;
  maxParts: number;
};

/** Почему файл не принят. Совпадает с PublicRejectReasonSchema. */
export type RejectReason =
  | 'unsupported_type'
  | 'empty'
  | 'too_large'
  | 'signature_image'
  | 'archive_suspicious'
  | 'heic_unsupported';

export type RejectedFile = { filename: string; reason: RejectReason };

export type CollectError =
  | 'too_many_files'
  | 'file_too_large'
  | 'total_too_large'
  | 'too_many_fields'
  | 'malformed';

export type CollectResult =
  | { ok: true; fields: Record<string, string>; accepted: IngestFile[]; rejected: RejectedFile[] }
  | { ok: false; error: CollectError };

/** Человеческий текст отказа по лимитам — уходит и менеджеру, и поставщику. */
export function uploadLimitMessage(error: CollectError): string {
  switch (error) {
    case 'too_many_files':
      return 'Слишком много файлов в одной загрузке. Отправьте их в несколько приёмов.';
    case 'file_too_large':
      return 'Один из файлов больше 10 МБ. Уменьшите размер или отправьте его отдельно.';
    case 'total_too_large':
      return 'Суммарный объём файлов слишком большой. Отправьте их в два приёма.';
    case 'too_many_fields':
      return 'Некорректная форма загрузки.';
    default:
      return 'Не удалось прочитать загруженные файлы. Попробуйте ещё раз.';
  }
}

/**
 * `strict` — вход от неизвестного отправителя: тип определяется по содержимому,
 * причина отказа сохраняется и показывается человеку.
 * `legacy` — прежнее поведение внутреннего входа: проверка по mime/расширению,
 * неподдерживаемое отбрасывается молча.
 */
export type CollectMode = 'strict' | 'legacy';

type MultipartPart =
  | {
      type: 'file';
      fieldname: string;
      filename: string;
      mimetype: string;
      toBuffer: () => Promise<Buffer>;
    }
  | { type: 'field'; fieldname: string; value: unknown };

/**
 * Имя multipart-части для зоны «Дополнительные документы».
 *
 * Режим едет именем части, а не отдельным полем формы: текстовые поля читаются
 * до файлов (сервер разбирает поток по частям), поэтому сказать «а вот этот
 * файл — дополнительный» отдельным полем невозможно.
 */
export const EXTRA_FILES_FIELD = 'extraFiles';

/**
 * Любое имя, кроме `extraFiles`, — обычная зона распознавания. Умолчание
 * важно: мобильное приложение и прежние сборки веба шлют одно поле `files` и
 * про вторую зону не знают.
 */
function processingModeOf(fieldname: string): IngestFile['processingMode'] {
  return fieldname === EXTRA_FILES_FIELD ? 'store_only' : 'auto';
}

type MultipartRequest = {
  parts: (opts?: {
    limits?: {
      files?: number;
      fileSize?: number;
      fields?: number;
      fieldSize?: number;
      parts?: number;
    };
  }) => AsyncIterable<MultipartPart>;
};

/**
 * Ошибки лимитов @fastify/multipart несут statusCode 413, но общий
 * error-handler намеренно его игнорирует и отдаёт 500 — поэтому ловим здесь
 * и возвращаем типизированный отказ, из которого роут строит человеческий 413.
 */
function limitErrorOf(err: unknown): CollectError {
  const code = (err as { code?: string } | null)?.code ?? '';
  switch (code) {
    case 'FST_FILES_LIMIT':
      return 'too_many_files';
    case 'FST_REQ_FILE_TOO_LARGE':
      return 'file_too_large';
    case 'FST_FIELDS_LIMIT':
      return 'too_many_fields';
    case 'FST_PARTS_LIMIT':
      return 'too_many_files';
    default:
      return 'malformed';
  }
}

/** Прежняя проверка внутреннего входа: image/*, pdf, xls/xlsx по mime или имени. */
function isSupportedLegacy(mime: string, filename: string): boolean {
  const m = (mime ?? '').toLowerCase();
  const isImage = m.startsWith('image/') || /\.(jpg|jpeg|png|webp|heic|heif)$/i.test(filename);
  const isPdf = m.includes('pdf') || /\.pdf$/i.test(filename);
  const isExcel =
    m.includes('spreadsheetml') ||
    m === 'application/vnd.ms-excel' ||
    /\.(xlsx|xls)$/i.test(filename);
  return isImage || isPdf || isExcel;
}

/** Тип по содержимому + два ужесточения, нужные только публичному входу. */
function classifyStrict(
  buffer: Buffer,
  filename: string,
  declaredMime: string,
  maxFileBytes: number,
): { ok: true; mimeType: string } | { ok: false; reason: RejectReason } {
  const verdict = classifyAttachment(
    { buffer, filename, declaredMime },
    {
      maxBytes: maxFileBytes,
      signatureMaxBytes: 25 * 1024,
      xlsxMaxEntries: 512,
      xlsxMaxInflatedBytes: 64 * 1024 * 1024,
      xlsxMaxRatio: 200,
    },
  );

  if (verdict.state === 'suspected_signature') return { ok: false, reason: 'signature_image' };
  if (verdict.state === 'skipped') {
    switch (verdict.reason) {
      case 'empty':
        return { ok: false, reason: 'empty' };
      case 'too_large':
        return { ok: false, reason: 'too_large' };
      case 'unsupported_type':
        return { ok: false, reason: 'unsupported_type' };
      default:
        // Все остальные причины у classifyAttachment — про подозрительный zip.
        return { ok: false, reason: 'archive_suspicious' };
    }
  }

  const sniffed = verdict.sniffedMime ?? sniffMime(buffer);
  // HEIC с айфона конвейер принимает, но распознать не может НИКОГДА: vision
  // работает с jpeg/png/webp/pdf, а по расширению файл уходит в PDF-ветку и
  // падает на pdftoppm. Честный отказ на входе с понятной инструкцией лучше
  // тихого parse_failed через минуту. Отказ только в strict-режиме: почта и
  // внутренняя загрузка ведут себя как прежде.
  if (sniffed === 'image/heic') {
    return { ok: false, reason: 'heic_unsupported' };
  }
  // OLE2-сигнатура одинакова у .xls, .doc и .ppt — публично не принимаем
  // ничего из этого семейства: ради редкого .xls разбирать Workbook-стрим
  // не окупается, а пропустить .doc как «таблицу» нельзя.
  if (sniffed === 'application/vnd.ms-excel') {
    return { ok: false, reason: 'unsupported_type' };
  }
  // Любой zip выглядит как xlsx: убеждаемся, что внутри действительно книга.
  if (
    sniffed === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' &&
    !isXlsxContainer(buffer)
  ) {
    return { ok: false, reason: 'unsupported_type' };
  }
  return { ok: true, mimeType: sniffed ?? 'application/octet-stream' };
}

export async function collectUploadParts(
  req: FastifyRequest,
  limits: UploadLimits,
  mode: CollectMode,
): Promise<CollectResult> {
  const mp = req as unknown as MultipartRequest;
  const fields: Record<string, string> = {};
  const accepted: IngestFile[] = [];
  const rejected: RejectedFile[] = [];
  let totalBytes = 0;

  try {
    for await (const part of mp.parts({
      limits: {
        files: limits.maxFiles,
        fileSize: limits.maxFileBytes,
        fields: limits.maxFields,
        fieldSize: limits.maxFieldBytes,
        parts: limits.maxParts,
      },
    })) {
      if (part.type === 'field') {
        if (typeof part.value === 'string') fields[part.fieldname] = part.value;
        continue;
      }

      const buffer = await part.toBuffer();
      const filename = safeName(part.filename, accepted.length + rejected.length);
      const processingMode = processingModeOf(part.fieldname);

      totalBytes += buffer.length;
      if (totalBytes > limits.maxTotalBytes) return { ok: false, error: 'total_too_large' };

      if (mode === 'legacy') {
        // Прежнее поведение внутреннего входа: пустые и неподдерживаемые
        // молча пропускаются, в rejected не попадают.
        if (buffer.length === 0) continue;
        if (!isSupportedLegacy(part.mimetype, part.filename)) continue;
        accepted.push({ filename: part.filename, mimeType: part.mimetype, buffer, processingMode });
        continue;
      }

      const verdict = classifyStrict(buffer, filename, part.mimetype ?? '', limits.maxFileBytes);
      if (!verdict.ok) {
        rejected.push({ filename, reason: verdict.reason });
        continue;
      }
      accepted.push({ filename, mimeType: verdict.mimeType, buffer, processingMode });
    }
  } catch (err) {
    return { ok: false, error: limitErrorOf(err) };
  }

  return { ok: true, fields, accepted, rejected };
}
