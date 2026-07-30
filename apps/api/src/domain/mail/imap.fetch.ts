// Двухфазный забор писем из IMAP.
//
// Зачем не одной фазой. Существующий `fetchNewMessages` (imap.client.ts) тянет
// письмо целиком через `source: true`, после чего `simpleParser` декодирует его
// в память: письмо одновременно живёт как сырой буфер, как MIME-структура и как
// набор декодированных вложений. Конверт на 300–500 МБ уронит процесс раньше,
// чем сработает любая проверка размера вложений.
//
// Поэтому сначала запрашиваются только метаданные (`envelope`, `size`,
// `bodyStructure`) — это несколько килобайт на письмо, — и лишь письма,
// прошедшие проверку, скачиваются целиком.
//
// Разбор решений вынесен в чистые функции: `decideFetch` и `summarizeStructure`
// проверяются без сети и без IMAP-сервера.

import type { MessageStructureObject } from 'imapflow';

/** Метаданные письма, полученные в первой фазе. */
export type MessageHeadline = {
  uid: number;
  /** Размер письма в байтах по данным сервера (RFC822.SIZE). */
  size: number | null;
  messageId: string | null;
  subject: string | null;
  from: string | null;
  receivedAt: Date | null;
  structure: MessageStructureObject | null;
};

export type FetchLimits = {
  /**
   * Предел размера письма целиком. Берётся с запасом к бюджету памяти воркера:
   * письмо существует в нескольких представлениях одновременно.
   */
  maxLetterBytes: number;
};

export const DEFAULT_FETCH_LIMITS: FetchLimits = {
  maxLetterBytes: 50 * 1024 * 1024,
};

export type FetchDecision =
  | { fetch: true }
  /** Тело не скачиваем; письмо получает терминальный статус с этой причиной. */
  | { fetch: false; reason: 'skipped_by_size' | 'no_attachments' };

/** Типы вложений, которые вообще имеет смысл скачивать. */
const INTERESTING_TYPES = [
  'application/pdf',
  'image/',
  'application/vnd.openxmlformats-officedocument.spreadsheetml',
  'application/vnd.ms-excel',
  'application/octet-stream',
];

export type StructureSummary = {
  /** Есть ли хотя бы одна часть, похожая на документ. */
  hasCandidateAttachment: boolean;
  /** Части внутри multipart/related — кандидаты в картинки вёрстки. */
  relatedParts: number;
  /** Суммарный объявленный размер частей-вложений. */
  attachmentBytes: number;
};

function walk(node: MessageStructureObject, inRelated: boolean, acc: StructureSummary): void {
  const type = (node.type ?? '').toLowerCase();

  if (node.childNodes?.length) {
    const related = inRelated || type === 'multipart/related';
    for (const child of node.childNodes) walk(child, related, acc);
    return;
  }

  const disposition = (node.disposition ?? '').toLowerCase();
  const isBodyText = type === 'text/plain' || type === 'text/html';
  // Текст письма вложением не считается, если он не отправлен как файл.
  if (isBodyText && disposition !== 'attachment') return;

  if (INTERESTING_TYPES.some((t) => type.startsWith(t))) {
    acc.hasCandidateAttachment = true;
    acc.attachmentBytes += node.size ?? 0;
    if (inRelated) acc.relatedParts += 1;
  }
}

/**
 * Что можно сказать о вложениях, ещё не скачав письмо.
 *
 * Нужна, чтобы не тратить трафик и память на письма, где документов заведомо
 * нет (переписка, автоответы, уведомления).
 */
export function summarizeStructure(structure: MessageStructureObject | null): StructureSummary {
  const acc: StructureSummary = {
    hasCandidateAttachment: false,
    relatedParts: 0,
    attachmentBytes: 0,
  };
  if (structure) walk(structure, false, acc);
  return acc;
}

/**
 * Решение: скачивать тело письма или нет.
 *
 * Размер проверяется ДО скачивания — в этом весь смысл двухфазности. Письмо
 * без единого подходящего вложения тоже не скачиваем: оно всё равно не создаст
 * документов, а строка о нём в журнале останется.
 */
export function decideFetch(
  headline: MessageHeadline,
  limits: FetchLimits = DEFAULT_FETCH_LIMITS,
): FetchDecision {
  if (headline.size !== null && headline.size > limits.maxLetterBytes) {
    return { fetch: false, reason: 'skipped_by_size' };
  }
  // Структура может не прийти (редкие серверы) — тогда решаем по телу, иначе
  // рискуем пропустить письмо с документами.
  if (headline.structure && !summarizeStructure(headline.structure).hasCandidateAttachment) {
    return { fetch: false, reason: 'no_attachments' };
  }
  return { fetch: true };
}

/** Минимум от IMAP-клиента, нужный для забора: позволяет подменить его в тестах. */
export type ImapLike = {
  fetch: (
    range: string,
    query: Record<string, boolean>,
    options?: { uid?: boolean },
  ) => AsyncIterable<{
    uid: number;
    size?: number;
    envelope?: {
      messageId?: string;
      subject?: string;
      date?: Date;
      from?: { address?: string; name?: string }[];
    };
    bodyStructure?: MessageStructureObject;
    internalDate?: Date;
  }>;
  fetchOne: (
    seq: string,
    query: Record<string, boolean>,
    options?: { uid?: boolean },
  ) => Promise<{ source?: Buffer } | false>;
};

/**
 * Фаза 1: только метаданные писем с UID больше watermark.
 *
 * `source` здесь намеренно не запрашивается — иначе двухфазность теряет смысл.
 */
export async function fetchHeadlines(
  client: ImapLike,
  fromUid: number,
  maxMessages: number,
): Promise<MessageHeadline[]> {
  const out: MessageHeadline[] = [];
  for await (const msg of client.fetch(
    `${fromUid}:*`,
    { uid: true, envelope: true, size: true, bodyStructure: true, internalDate: true },
    { uid: true },
  )) {
    // Сервер может вернуть письмо с UID ниже запрошенного, если ящик пуст.
    if (msg.uid < fromUid) continue;
    out.push({
      uid: msg.uid,
      size: typeof msg.size === 'number' ? msg.size : null,
      messageId: msg.envelope?.messageId ?? null,
      subject: msg.envelope?.subject ?? null,
      from: msg.envelope?.from?.[0]?.address ?? null,
      receivedAt: msg.internalDate instanceof Date ? msg.internalDate : (msg.envelope?.date ?? null),
      structure: msg.bodyStructure ?? null,
    });
    if (out.length >= maxMessages) break;
  }
  // По возрастанию UID: watermark двигается по непрерывному префиксу, и от
  // порядка зависит, какое письмо потеряется при сбое.
  return out.sort((a, b) => a.uid - b.uid);
}

/**
 * Фаза 2: сырое письмо целиком. Вызывать только после `decideFetch`.
 *
 * Возвращает `null`, если письмо исчезло из папки между фазами (удалено или
 * перемещено) — это штатная ситуация, а не ошибка.
 */
export async function fetchSource(client: ImapLike, uid: number): Promise<Buffer | null> {
  const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
  if (!msg || !msg.source) return null;
  return msg.source;
}
