import { z } from 'zod';
import { DeliveryPhotoStageSchema } from './deliveries.js';
import { UpdValidationSchema } from './source-documents.js';

export const PhotoKindSchema = z.enum(['document', 'cargo', 'vehicle', 'other']);

/**
 * К чему относится фото — приёмка или отгрузка.
 * Используется в presign-/get-/delete- эндпоинтах для диспатча по таблицам.
 */
export const OperationKindSchema = z.enum(['delivery', 'shipment']);
export type OperationKind = z.infer<typeof OperationKindSchema>;

export const PhotoPresignRequestSchema = z.object({
  operationKind: OperationKindSchema.default('delivery'),
  operationId: z.string().uuid().optional(),
  // Старое поле для совместимости с уже задеплоенным фронтом приёмки.
  deliveryId: z.string().uuid().optional(),
  kind: PhotoKindSchema,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  idempotencyKey: z.string().uuid(),
  // Реальный MIME загружаемого файла: image/jpeg, image/png, image/heic,
  // image/heif, image/webp. Сервер использует его для расширения файла в S3
  // и параметра Content-Type в presigned URL. Default — image/jpeg для
  // обратной совместимости со старым веб-фронтом, но мобильный клиент должен
  // присылать реальный MIME.
  contentType: z.string().default('image/jpeg'),
  /**
   * Момент съёмки по часам планшета (ISO-8601). Раньше `taken_at` ставил
   * сервер в момент presign — при офлайне это давало время синхронизации, и на
   * портале оба этапа показывали один час (04.08, ЖК ВАРШАВСКАЯ LIFE: съёмка
   * 12:24–12:30, в карточке 12:31). Опционально: сборки до 1.0.33 и веб-фронт
   * поля не шлют, для них остаётся серверное время. Длину ограничиваем —
   * строка приходит с устройства. Разбор и клампы — domain/operations/confirmed-at.ts.
   */
  takenAt: z.string().max(64).optional(),
  thumbContentHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  // Этап для фото delivery/shipment: 'before' (1-й этап) или 'after'
  // (2-й этап, после подтверждения МОЛ). Default 'before' — старые
  // клиенты, не присылающие поле, продолжают грузить фото в раздел «До».
  // Тип ShipmentPhotoStageSchema совпадает с DeliveryPhotoStageSchema по
  // значениям, поэтому общую схему презайна не дробим.
  stage: DeliveryPhotoStageSchema.optional(),
});
export type PhotoPresignRequest = z.infer<typeof PhotoPresignRequestSchema>;

export const PhotoPresignResponseSchema = z.object({
  photoId: z.string().uuid(),
  s3Key: z.string(),
  thumbS3Key: z.string().nullable(),
  uploadUrl: z.string(),
  thumbUploadUrl: z.string().nullable(),
  expiresIn: z.number(),
  alreadyExists: z.boolean(),
});
export type PhotoPresignResponse = z.infer<typeof PhotoPresignResponseSchema>;

export const PhotoGetUrlResponseSchema = z.object({
  url: z.string(),
  expiresIn: z.number(),
});
export type PhotoGetUrlResponse = z.infer<typeof PhotoGetUrlResponseSchema>;

export const PhotoDeleteResponseSchema = z.object({ ok: z.literal(true) });
export type PhotoDeleteResponse = z.infer<typeof PhotoDeleteResponseSchema>;

// PATCH /api/v1/photos/:id — изменение только метаданных фото
// (сейчас — только kind). НЕ трогает stage, s3Key, файл, uploadedBy,
// takenAt, attachment к delivery/shipment. Используется на веб-портале,
// чтобы менеджер мог исправить тип фото, если инспектор на мобиле
// выбрал не ту кнопку («Груз» вместо «Документ» и т.п.). Мобильный
// клиент это поле не пишет, только читает.
export const PhotoPatchRequestSchema = z.object({
  kind: PhotoKindSchema,
});
export type PhotoPatchRequest = z.infer<typeof PhotoPatchRequestSchema>;

export const PhotoPatchResponseSchema = z.object({
  ok: z.literal(true),
  kind: PhotoKindSchema,
});
export type PhotoPatchResponse = z.infer<typeof PhotoPatchResponseSchema>;

// Подтверждение фото после успешного PUT в S3: сервер делает S3.HEAD и,
// если объект существует, проставляет uploaded_at = now(). Иначе 404 —
// клиент должен повторить PUT.
export const PhotoConfirmResponseSchema = z.object({
  ok: z.literal(true),
  uploadedAt: z.string(),
});
export type PhotoConfirmResponse = z.infer<typeof PhotoConfirmResponseSchema>;

// ─── Распознавание позиций из фото-документа ──────────────────────────────
// Используется split-view модалкой в портале (раздел Принятые → клик на
// фото с kind='document'). Результат кэшируется в БД (миграции 0058 и 0122)
// и повторно отдаётся без LLM-вызова.

/**
 * Каким путём разобрано фото.
 *
 *  `photo_v1`   — терпимый промпт под накладные, ОС-2, М-15 и рукописные
 *                 бумаги (`domain/photos/recognize.ts`). `sum` позиции —
 *                 стоимость БЕЗ налога (графа 5 формы УПД), НДС не
 *                 извлекается вовсе.
 *  `upd_vision` — основной УПД-парсер с активным промптом из БД
 *                 (`domain/photos/recognize-upd.ts`). `sum` — стоимость
 *                 С налогом (графа 9), есть построчный НДС и номер позиции
 *                 из графы 1.
 *
 * Признак хранится, а не выводится: базы у `sum` разные, и показать их в одной
 * колонке как одно и то же — значит соврать на величину налога. Записи,
 * сделанные до появления поля, читаются как `photo_v1`.
 */
export const PhotoRecognitionParserSchema = z.enum(['photo_v1', 'upd_vision']);
export type PhotoRecognitionParser = z.infer<typeof PhotoRecognitionParserSchema>;

// Одна строка таблицы материалов.
export const PhotoRecognitionItemSchema = z.object({
  nameRaw: z.string(),
  qty: z.number().nullable().optional(),
  unit: z.string().nullable().optional(),
  invNumber: z.string().nullable().optional(),
  price: z.number().nullable().optional(),
  sum: z.number().nullable().optional(),
  // Ниже — поля УПД-ветки. У `photo_v1` их нет: тот промпт не читает ни НДС,
  // ни номер позиции, и подставлять сюда нули значило бы выдумать данные.
  /** Номер позиции, НАПЕЧАТАННЫЙ в графе 1 бланка. По нему сверяется целостность списка. */
  rowNo: z.number().int().nullable().optional(),
  vatRate: z.number().nullable().optional(),
  vatSum: z.number().nullable().optional(),
});
export type PhotoRecognitionItem = z.infer<typeof PhotoRecognitionItemSchema>;

export const PhotoRecognitionSchema = z.object({
  // Статус кэша: done — есть распознанные items; failed — LLM упал
  // (errorMessage заполнен); processing зарезервирован под асинхронный
  // режим, но сейчас бэк делает синхронный POST и сразу отдаёт done/failed.
  status: z.enum(['done', 'failed']),
  items: z.array(PhotoRecognitionItemSchema),
  // Метаданные документа.
  docForm: z.string().nullable(),
  docNumber: z.string().nullable(),
  docDate: z.string().nullable(),
  totalSum: z.number().nullable(),
  confidence: z.number().nullable(),
  model: z.string().nullable(),
  errorMessage: z.string().nullable(),
  recognizedAt: z.string(),
  // Путь разбора. У записей, сделанных до миграции 0122, — `photo_v1`.
  parser: PhotoRecognitionParserSchema,
  // Шапочные поля УПД-ветки: общий НДС документа и «Всего наименований».
  vatSum: z.number().nullable(),
  itemsCount: z.number().int().nullable(),
  /**
   * Сверка сумм по этому же результату — целиком, обе группы.
   *
   * `checks` держат доказанные расхождения (`sum_total`, `row_qty_price`,
   * `items_sequence`), `warnings` — подозрения на съехавшие колонки
   * (`unit_code_as_qty`, `sum_equals_qty`, `price_includes_vat`). Хранить
   * только вторые нельзя: расхождение строки с итогом попадает в первые.
   *
   * `null` — сверки не было: ветка `photo_v1` не извлекает НДС и номера
   * позиций, и посчитанная по её данным сверка была бы неверной.
   */
  validation: UpdValidationSchema.nullable(),
});
export type PhotoRecognition = z.infer<typeof PhotoRecognitionSchema>;
