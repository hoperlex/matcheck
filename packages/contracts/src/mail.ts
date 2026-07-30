import { z } from 'zod';

export const MailAccountDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  host: z.string(),
  port: z.number(),
  useTls: z.boolean(),
  username: z.string(),
  folder: z.string(),
  lastUid: z.number().nullable(),
  isActive: z.boolean(),
  createdAt: z.string(),
});
export type MailAccountDto = z.infer<typeof MailAccountDtoSchema>;

// ─── Состояния почтового канала ───────────────────────────────────────────
// Единый источник истины для воркера, API и фронта. Значения совпадают с
// колонками, заведёнными миграцией 0074; DTO списков и карточки разбора
// появятся вместе с маршрутами.

/**
 * Назначение ящика.
 * `request` — исторический канал заявок: письмо сразу разбирается LLM.
 * `document` — ящик подрядчиков: письмо попадает в карантин и ждёт оператора.
 */
export const MailAccountPurposeSchema = z.enum(['request', 'document']);
export type MailAccountPurpose = z.infer<typeof MailAccountPurposeSchema>;

/**
 * Транспортное состояние письма (`mail_receipts`) — что удалось забрать из
 * IMAP. Терминальные состояния двигают watermark; `fetch_failed` и
 * `parse_failed` становятся терминальными только после исчерпания попыток.
 */
export const MailReceiptStatusSchema = z.enum([
  'fetching',
  'parsed',
  'skipped_by_size',
  'fetch_failed',
  'parse_failed',
  'vanished',
]);
export type MailReceiptStatus = z.infer<typeof MailReceiptStatusSchema>;

/** Повторить скачивание можно только там, где это осмысленно. */
export const REPLAYABLE_RECEIPT_STATUSES: readonly MailReceiptStatus[] = [
  'skipped_by_size',
  'fetch_failed',
  'parse_failed',
];

/**
 * Бизнес-состояние письма (`mail_messages`). Строка заводится для КАЖДОГО
 * разобранного письма, включая `ignored`/`no_attachments`/`rejected_sender` —
 * иначе эти исходы негде хранить и письмо пропадает из наблюдаемости.
 */
export const MailMessageStatusSchema = z.enum([
  'quarantined',
  'resolving',
  'ingested',
  'rejected',
  'ignored',
  'no_attachments',
  'rejected_sender',
]);
export type MailMessageStatus = z.infer<typeof MailMessageStatusSchema>;

/**
 * Состояние вложения (`mail_attachments`). Фильтр подписей ничего не удаляет:
 * подозрительное помечается `suspected_signature` и возвращается оператором.
 */
export const MailAttachmentStateSchema = z.enum([
  'kept',
  'suspected_signature',
  'skipped',
  'restored',
]);
export type MailAttachmentState = z.infer<typeof MailAttachmentStateSchema>;

/** Правило маршрутизации: по отправителю или по теме (substring, не regex). */
export const MailRouteMatchTypeSchema = z.enum(['from', 'subject']);
export type MailRouteMatchType = z.infer<typeof MailRouteMatchTypeSchema>;

/** Канал происхождения пакета — для `ingest_events` и метки в списке. */
export const IngestChannelSchema = z.enum(['manual', 'mail']);
export type IngestChannel = z.infer<typeof IngestChannelSchema>;

export const MailAccountUpsertSchema = z.object({
  name: z.string().min(1).max(100),
  host: z.string().min(1).max(255),
  port: z.number().int().positive().max(65535).default(993),
  useTls: z.boolean().default(true),
  username: z.string().min(1),
  password: z.string().min(1).optional(),
  folder: z.string().default('INBOX'),
  isActive: z.boolean().default(true),
});
export type MailAccountUpsert = z.infer<typeof MailAccountUpsertSchema>;
