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
  /** 'request' — заявки, 'document' — УПД от подрядчиков (карантин). */
  purpose: z.string(),
  /** Автоопрос ящика. Включается отдельно от isActive и осознанно. */
  pollEnabled: z.boolean(),
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
  purpose: MailAccountPurposeSchema.default('request'),
  // Автоопрос по умолчанию выключен: ящик сначала заводят и проверяют
  // доступы кнопкой, и только потом включают постоянный опрос.
  pollEnabled: z.boolean().default(false),
});
export type MailAccountUpsert = z.infer<typeof MailAccountUpsertSchema>;

/** Частичное обновление: пароль передаётся только если его меняют. */
export const MailAccountPatchSchema = MailAccountUpsertSchema.partial();
export type MailAccountPatch = z.infer<typeof MailAccountPatchSchema>;

/**
 * Ответ на «проверить сейчас»: опрос выполняется отдельным процессом, поэтому
 * запрос лишь ставит задачу в очередь.
 */
export const MailPollQueuedSchema = z.object({
  queued: z.literal(true),
  jobId: z.string(),
});
export type MailPollQueued = z.infer<typeof MailPollQueuedSchema>;

// ─── Разбор почты ─────────────────────────────────────────────────────────
// Экран для писем, которые НЕ прошли автоматически: объект не указан, кодов
// несколько, код неизвестен или тот же комплект уже лежит на другой площадке.
// Письмо с явным маркером сюда не попадает — оно становится документом само.

/** Вложение письма в карточке разбора. */
export const MailAttachmentDtoSchema = z.object({
  id: z.string().uuid(),
  idx: z.number(),
  filename: z.string().nullable(),
  /** Тип по сигнатуре файла, а не по заявленному в письме. */
  mimeType: z.string().nullable(),
  sizeBytes: z.number(),
  state: MailAttachmentStateSchema,
  /** Почему отброшено — показывается оператору рядом с кнопкой «Вернуть». */
  skipReason: z.string().nullable(),
  /** Пойдёт ли вложение в пакет при подтверждении. */
  willBeIngested: z.boolean(),
});
export type MailAttachmentDto = z.infer<typeof MailAttachmentDtoSchema>;

/** Строка списка «Разбор почты». */
export const MailMessageDtoSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  accountName: z.string(),
  fromAddress: z.string().nullable(),
  subject: z.string().nullable(),
  receivedAt: z.string().nullable(),
  status: MailMessageStatusSchema,
  /** `cross_scope_conflict` и прочие причины остановки. */
  rejectReason: z.string().nullable(),
  /** Подсказка матчера: код в теме, название объекта, имя файла. */
  suggestedSiteId: z.string().uuid().nullable(),
  suggestedSiteCode: z.string().nullable(),
  suggestedSiteName: z.string().nullable(),
  /** Сколько вложений уйдёт в пакет (без отброшенных и подозрительных). */
  attachmentsCount: z.number(),
  /** Всего вложений, включая отброшенные. */
  attachmentsTotal: z.number(),
  bundleId: z.string().uuid().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
});
export type MailMessageDto = z.infer<typeof MailMessageDtoSchema>;

export const MailMessageDetailSchema = MailMessageDtoSchema.extend({
  attachments: z.array(MailAttachmentDtoSchema),
});
export type MailMessageDetail = z.infer<typeof MailMessageDetailSchema>;

export const MailMessageListResponseSchema = z.object({
  items: z.array(MailMessageDtoSchema),
  total: z.number(),
});
export type MailMessageListResponse = z.infer<typeof MailMessageListResponseSchema>;

/**
 * Фильтр списка. `pending` — то, что ждёт человека; остальное для истории.
 */
export const MailReviewFilterSchema = z.enum(['pending', 'ingested', 'rejected', 'all']);
export type MailReviewFilter = z.infer<typeof MailReviewFilterSchema>;

/**
 * Сводка для вкладки. `configured = false` (ни одного активного ящика с
 * документами) прячет вкладку целиком: пока почта не заведена, интерфейс
 * «Документов» остаётся прежним.
 */
export const MailReviewSummarySchema = z.object({
  pending: z.number(),
  configured: z.boolean(),
});
export type MailReviewSummary = z.infer<typeof MailReviewSummarySchema>;

/** Подтверждение письма оператором: объект обязателен, остальное — как в УПД. */
export const MailResolveRequestSchema = z.object({
  siteId: z.string().uuid(),
  direction: z.enum(['inbound', 'outbound']).default('inbound'),
  contractorId: z.string().uuid().nullable().optional(),
  /** `null` — документ уйдёт инспектору в группу «остальные». */
  expectedDate: z.string().nullable().optional(),
});
export type MailResolveRequest = z.infer<typeof MailResolveRequestSchema>;

export const MailResolveResponseSchema = z.object({
  /** `ingested` — создан пакет, `reused` — тот же комплект уже загружен. */
  outcome: z.enum(['ingested', 'reused']),
  bundleId: z.string().uuid(),
  documentId: z.string().uuid().nullable(),
});
export type MailResolveResponse = z.infer<typeof MailResolveResponseSchema>;

export const MailRejectRequestSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type MailRejectRequest = z.infer<typeof MailRejectRequestSchema>;

// ─── Проблемные заборы ────────────────────────────────────────────────────
// Письма, которые не удалось скачать: слишком большое, обрыв связи, битый
// MIME. После исчерпания попыток такая запись терминальна и граница ящика её
// перешагивает — без повторного забора письмо не вернуть.

/** Строка списка проблемных заборов. */
export const MailReceiptDtoSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  accountName: z.string(),
  uid: z.number(),
  status: MailReceiptStatusSchema,
  /** Размер письма в байтах — по нему видно, поднимать ли лимит. */
  sizeBytes: z.number().nullable(),
  attempts: z.number(),
  lastError: z.string().nullable(),
  /** Повтор уже запрошен и ждёт ближайшего прохода. */
  replayRequested: z.boolean(),
  /** Можно ли запросить повтор: успешные и исчезнувшие письма не повторяют. */
  canReplay: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MailReceiptDto = z.infer<typeof MailReceiptDtoSchema>;

export const MailReceiptListResponseSchema = z.object({
  items: z.array(MailReceiptDtoSchema),
  total: z.number(),
});
export type MailReceiptListResponse = z.infer<typeof MailReceiptListResponseSchema>;

export const MailReplayResponseSchema = z.object({
  requested: z.literal(true),
  uid: z.number(),
});
export type MailReplayResponse = z.infer<typeof MailReplayResponseSchema>;
