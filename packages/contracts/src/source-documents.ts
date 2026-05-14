import { z } from 'zod';

export const SourceKindSchema = z.enum(['upd', 'request']);
export const SourceOriginSchema = z.enum(['edo_diadoc', 'manual_xml', 'manual_pdf', 'mail']);
export const SourceStatusSchema = z.enum(['parsed', 'parse_failed', 'archived']);
export const SourceDirectionSchema = z.enum(['inbound', 'outbound']);
export type SourceDirection = z.infer<typeof SourceDirectionSchema>;

export const VolumeConfidenceSchema = z.enum(['low', 'medium', 'high']);
export type VolumeConfidence = z.infer<typeof VolumeConfidenceSchema>;

export const SourceItemSchema = z.object({
  id: z.string().uuid(),
  materialId: z.string().uuid().nullable(),
  nameRaw: z.string(),
  qty: z.string(),
  unit: z.string(),
  price: z.string().nullable(),
  sum: z.string().nullable(),
  vatRate: z.string().nullable(),
  vatSum: z.string().nullable(),
  expectedDate: z.string().nullable(),
  lineNo: z.number(),
  volumeM3: z.string().nullable(),
  massKg: z.string().nullable(),
  volumeConfidence: VolumeConfidenceSchema.nullable(),
  groupName: z.string().nullable(),
});
export type SourceItem = z.infer<typeof SourceItemSchema>;

export const SourceAttachmentSchema = z.object({
  id: z.string().uuid(),
  s3Key: z.string(),
  filename: z.string(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  role: z.enum(['original', 'extracted_text']),
});
export type SourceAttachment = z.infer<typeof SourceAttachmentSchema>;

// ──────────── Авто-сверка арифметики (см. apps/api/src/domain/edo/upd-validation.ts) ───────

export const UpdCheckNameSchema = z.enum([
  'sum_total',
  'vat_total',
  'items_count',
  'row_qty_price',
  'row_vat_rate',
]);
export type UpdCheckName = z.infer<typeof UpdCheckNameSchema>;

export const UpdCheckScopeSchema = z.union([
  z.literal('document'),
  z.object({ row: z.number().int().positive() }),
]);
export type UpdCheckScope = z.infer<typeof UpdCheckScopeSchema>;

export const UpdCheckSchema = z.object({
  name: UpdCheckNameSchema,
  scope: UpdCheckScopeSchema,
  expected: z.number().nullable(),
  actual: z.number().nullable(),
  diff: z.number().nullable(),
  tolerance: z.number(),
  ok: z.boolean(),
  skipReason: z.enum(['no_expected', 'no_actual']).optional(),
});
export type UpdCheck = z.infer<typeof UpdCheckSchema>;

export const UpdValidationSchema = z.object({
  hasMismatch: z.boolean(),
  checkedAt: z.string(),
  checks: z.array(UpdCheckSchema),
});
export type UpdValidation = z.infer<typeof UpdValidationSchema>;

export const SourceDocumentSchema = z.object({
  id: z.string().uuid(),
  kind: SourceKindSchema,
  direction: SourceDirectionSchema,
  status: SourceStatusSchema,
  supplierId: z.string().uuid().nullable(),
  recipientId: z.string().uuid().nullable(),
  docNumber: z.string().nullable(),
  docDate: z.string().nullable(),
  totalSum: z.string().nullable(),
  vatSum: z.string().nullable(),
  expectedDate: z.string().nullable(),
  origin: SourceOriginSchema,
  llmProviderId: z.string().uuid().nullable(),
  llmConfidence: z.string().nullable(),
  parsedAt: z.string(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  validation: UpdValidationSchema.nullable(),
});
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

export const SourceDocumentDetailSchema = SourceDocumentSchema.extend({
  items: z.array(SourceItemSchema),
  attachments: z.array(SourceAttachmentSchema),
});
export type SourceDocumentDetail = z.infer<typeof SourceDocumentDetailSchema>;

export const SourceDocumentListResponseSchema = z.object({
  items: z.array(SourceDocumentSchema),
  total: z.number(),
});

export const ManualUpdUploadRequestSchema = z.object({
  xml: z.string().min(1).max(10_000_000),
  direction: SourceDirectionSchema,
});
export type ManualUpdUploadRequest = z.infer<typeof ManualUpdUploadRequestSchema>;

export const ManualUpdUploadResponseSchema = z.object({
  id: z.string().uuid(),
  itemsCount: z.number(),
});

export const SourceDocumentDirectionUpdateSchema = z.object({
  direction: SourceDirectionSchema,
});
export type SourceDocumentDirectionUpdate = z.infer<typeof SourceDocumentDirectionUpdateSchema>;

// ──────────── PDF УПД (двухшаговый flow: parse → confirm) ────────────

export const UpdPdfPartySchema = z.object({
  inn: z.string().nullable().optional(),
  kpp: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
});

export const UpdPdfItemSchema = z.object({
  nameRaw: z.string().min(1),
  qty: z.number(),
  unit: z.string().default('шт'),
  price: z.number().nullable().optional(),
  sum: z.number().nullable().optional(),
  vatRate: z.number().nullable().optional(),
  vatSum: z.number().nullable().optional(),
  volumeM3: z.number().nullable().optional(),
  massKg: z.number().nullable().optional(),
  volumeConfidence: VolumeConfidenceSchema.nullable().optional(),
  groupName: z.string().nullable().optional(),
});
export type UpdPdfItem = z.infer<typeof UpdPdfItemSchema>;

export const UpdPdfParsedSchema = z.object({
  docNumber: z.string().nullable().optional(),
  docDate: z.string().nullable().optional(),
  totalSum: z.number().nullable().optional(),
  vatSum: z.number().nullable().optional(),
  // Значение из строки УПД «Всего наименований N»; null/undefined, если парсер
  // не смог его извлечь — тогда сверка по кол-ву позиций пропускается.
  itemsCount: z.number().int().nonnegative().nullable().optional(),
  supplier: UpdPdfPartySchema.nullable().optional(),
  recipient: UpdPdfPartySchema.nullable().optional(),
  items: z.array(UpdPdfItemSchema),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type UpdPdfParsed = z.infer<typeof UpdPdfParsedSchema>;

export const UpdPdfParseResponseSchema = z.object({
  draftS3Key: z.string(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  parsed: UpdPdfParsedSchema,
  llmProviderId: z.string().uuid().nullable(),
  llmConfidence: z.number().min(0).max(1),
  textLength: z.number(),
  parseSource: z.enum(['llm', 'local']),
});
export type UpdPdfParseResponse = z.infer<typeof UpdPdfParseResponseSchema>;

export const UpdPdfConfirmRequestSchema = z.object({
  draftS3Key: z.string().min(1),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  parsed: UpdPdfParsedSchema,
  direction: SourceDirectionSchema,
});
export type UpdPdfConfirmRequest = z.infer<typeof UpdPdfConfirmRequestSchema>;

export const SourceDocumentFileResponseSchema = z.object({
  url: z.string().url(),
  filename: z.string(),
  mimeType: z.string().nullable(),
});
export type SourceDocumentFileResponse = z.infer<typeof SourceDocumentFileResponseSchema>;
