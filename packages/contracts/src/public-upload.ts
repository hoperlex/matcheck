import { z } from 'zod';

// ─── Публичная загрузка документов поставщиком (страница /uploads) ─────────
//
// Страница открыта без авторизации: поставщик выбирает объект и дату поставки,
// прикладывает документы, они уходят в тот же router-разбор, что и загрузка
// менеджера. Всё, что здесь описано, приходит от НЕДОВЕРЕННОГО клиента и
// уходит НЕДОВЕРЕННОМУ клиенту — поэтому наружу отдаётся минимум: тикет
// обращения и судьба файлов по входному фильтру, без внутренних id, типов
// документов и вердиктов парсеров.

/** Объект строительства в публичном справочнике: только то, что нужно выбрать. */
export const PublicSiteSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});
export type PublicSite = z.infer<typeof PublicSiteSchema>;

export const PublicSiteListResponseSchema = z.object({
  items: z.array(PublicSiteSchema),
});
export type PublicSiteListResponse = z.infer<typeof PublicSiteListResponseSchema>;

/**
 * Дата в формате YYYY-MM-DD, существующая в календаре.
 *
 * Одного regex мало: `2026-02-30` ему соответствует, но такой даты нет —
 * `new Date('2026-02-30')` молча даст 2 марта, и поставка уехала бы на другой
 * день. Сравниваем разбор с исходной строкой.
 */
export const CalendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД')
  .refine((v) => {
    const [y, m, d] = v.split('-').map(Number) as [number, number, number];
    const dt = new Date(Date.UTC(y, m - 1, d));
    return (
      dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
    );
  }, 'Такой даты не существует');

/** Максимальная длина комментария поставщика. */
export const PUBLIC_COMMENT_MAX = 500;

/**
 * Поля ОДНОЙ поставки. Multipart всегда приходит строками, поэтому числа
 * и булевы здесь не используются.
 *
 * Несколько поставок — это несколько отдельных запросов с такими полями:
 * пакет документов в модели данных и есть «объект + дата + комплект файлов».
 */
export const PublicUploadRequestSchema = z.object({
  siteId: z.string().uuid('Выберите объект'),
  expectedDate: CalendarDateSchema,
  // Свободный комментарий к поставке. Пустая строка после trim — это «нет
  // комментария», а не пустой текст: иначе в карточке документа у менеджера
  // появился бы тег без содержимого.
  comment: z
    .string()
    .max(PUBLIC_COMMENT_MAX * 4, 'Комментарий слишком длинный')
    .transform((v) => {
      const trimmed = v.trim();
      return trimmed === '' ? null : trimmed;
    })
    .refine(
      (v) => v === null || v.length <= PUBLIC_COMMENT_MAX,
      `Комментарий длиннее ${PUBLIC_COMMENT_MAX} символов`,
    )
    .nullable()
    .optional(),
  // Honeypot: поле скрыто от людей и не заполняется браузером. Непустое
  // значение = бот. Валидация здесь только фиксирует ожидание «пусто»;
  // решение принимает роут (тихо принимает и ничего не пишет).
  website: z.string().max(200).optional(),
});
export type PublicUploadRequest = z.infer<typeof PublicUploadRequestSchema>;

/** Почему файл не принят входным фильтром. Формулировки уходят поставщику. */
export const PublicRejectReasonSchema = z.enum([
  'unsupported_type',
  'empty',
  'too_large',
  'signature_image',
  'archive_suspicious',
  // Фото с айфона в формате HEIC. Распознать его конвейер не может, поэтому
  // отказ идёт сразу, с инструкцией переснять в «Наиболее совместимом».
  'heic_unsupported',
]);
export type PublicRejectReason = z.infer<typeof PublicRejectReasonSchema>;

export const PublicUploadResponseSchema = z.object({
  ticket: z.string(),
  filesAccepted: z.number().int(),
  filesRejected: z.array(
    z.object({ filename: z.string(), reason: PublicRejectReasonSchema }),
  ),
});
export type PublicUploadResponse = z.infer<typeof PublicUploadResponseSchema>;

/**
 * Статус обращения.
 *
 * `processing` — файлы разложены не полностью; `done` — переданы в обработку;
 * `failed` — пакет не удалось разобрать. Итог РАСПОЗНАВАНИЯ по каждому файлу
 * наружу не отдаётся вовсе: документ, ушедший в needs_review, для поставщика
 * принят, а публиковать вердикты внутренних парсеров незачем.
 *
 * files[] строится из манифеста ЭТОЙ отправки (ingest_events.submission_manifest),
 * а не из журнала пакета: пакет мог быть переиспользован, и имена файлов в нём
 * могут быть чужими.
 */
export const PublicUploadStatusSchema = z.object({
  ticket: z.string(),
  status: z.enum(['processing', 'done', 'failed']),
  filesTotal: z.number().int(),
  filesAccepted: z.number().int(),
  files: z.array(
    z.object({
      filename: z.string(),
      accepted: z.boolean(),
      reason: PublicRejectReasonSchema.nullable().optional(),
    }),
  ),
  submittedAt: z.string(),
});
export type PublicUploadStatus = z.infer<typeof PublicUploadStatusSchema>;
