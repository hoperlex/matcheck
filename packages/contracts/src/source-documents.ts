import { z } from 'zod';

export const SourceKindSchema = z.enum(['upd', 'request']);
export const SourceOriginSchema = z.enum(['edo_diadoc', 'manual_xml', 'mail']);
export const SourceStatusSchema = z.enum(['parsed', 'parse_failed', 'archived']);

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

export const SourceDocumentSchema = z.object({
  id: z.string().uuid(),
  kind: SourceKindSchema,
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

export const ManualUpdUploadResponseSchema = z.object({
  id: z.string().uuid(),
  itemsCount: z.number(),
});
