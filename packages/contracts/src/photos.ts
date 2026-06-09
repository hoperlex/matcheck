import { z } from 'zod';
import { DeliveryPhotoStageSchema } from './deliveries.js';

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
// фото с kind='document'). LLM-парсер тот же, что у накладных
// (domain/edo/waybill-batch.parser.ts); результат кэшируется в БД
// (миграция 0058) и повторно отдаётся без LLM-вызова.

// Одна строка таблицы материалов. Цена/сумма/количество — числа, но
// храним как string|null, чтобы избежать потери точности у numeric:
// фронт всё равно форматирует как валюту.
export const PhotoRecognitionItemSchema = z.object({
  nameRaw: z.string(),
  qty: z.number().nullable().optional(),
  unit: z.string().nullable().optional(),
  invNumber: z.string().nullable().optional(),
  price: z.number().nullable().optional(),
  sum: z.number().nullable().optional(),
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
});
export type PhotoRecognition = z.infer<typeof PhotoRecognitionSchema>;
