import { z } from 'zod';
import { ShipmentStatusCodeSchema, StatusSchema } from './statuses.js';
import { VolumeConfidenceSchema } from './source-documents.js';
import { ItemKindSchema } from './deliveries.js';

export const ShipmentKindSchema = z.enum(['contractor', 'return', 'transfer', 'writeoff']);
export type ShipmentKind = z.infer<typeof ShipmentKindSchema>;

export const ShipmentItemSchema = z.object({
  id: z.string().uuid(),
  itemKind: ItemKindSchema,
  materialId: z.string().uuid().nullable(),
  assetId: z.string().uuid().nullable(),
  inventoryNumber: z.string().nullable(),
  serialNumber: z.string().nullable(),
  nameRaw: z.string(),
  qtyPlanned: z.string().nullable(),
  qtyActual: z.string().nullable(),
  unit: z.string(),
  comment: z.string().nullable(),
  lineNo: z.number(),
  volumeM3: z.string().nullable(),
  massKg: z.string().nullable(),
  // Финансовый снимок позиции из УПД — см. DeliveryItemSchema.
  price: z.string().nullable(),
  vatRate: z.string().nullable(),
  vatSum: z.string().nullable(),
  volumeConfidence: VolumeConfidenceSchema.nullable(),
  groupName: z.string().nullable(),
});
export type ShipmentItem = z.infer<typeof ShipmentItemSchema>;

// Этап у фото отгрузки — зеркало DeliveryPhotoStageSchema. 'before' — снято
// на 1-м этапе (mobile «Выезд → 1 Этап»), 'after' — после подтверждения
// МОЛ (Stage2). Default 'before' для совместимости со старыми клиентами,
// не присылающими поле — фото попадает в 1-й этап.
export const ShipmentPhotoStageSchema = z.enum(['before', 'after']);
export type ShipmentPhotoStage = z.infer<typeof ShipmentPhotoStageSchema>;

export const ShipmentPhotoSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['document', 'cargo', 'vehicle', 'other']),
  stage: ShipmentPhotoStageSchema.default('before'),
  s3Key: z.string(),
  thumbS3Key: z.string().nullable(),
  contentHash: z.string().nullable(),
  takenAt: z.string(),
  // null = orphan-запись (PUT в S3 не подтверждён); см. DeliveryPhotoSchema.
  uploadedAt: z.string().nullable(),
});
export type ShipmentPhoto = z.infer<typeof ShipmentPhotoSchema>;

export const ShipmentSchema = z.object({
  id: z.string().uuid(),
  status: StatusSchema,
  kind: ShipmentKindSchema,
  /**
   * «Тип отгрузки» — семантическая категория, отдельная от kind.
   * Заполняется инспектором с мобилы в dropdown'е на форме «Новая
   * отгрузка». 4 значения: «Вывоз материала», «Перемещение на объект»,
   * «Вывоз мусора», «Другое». На веб-портале — чип «Тип отгрузки: …»
   * в шапке карточки. NULL для legacy и для отгрузок с УПД.
   * См. миграцию 0050.
   */
  purpose: z.string().nullable(),
  /**
   * Транзит — отгрузка является частью транзитного рейса (машина
   * отгрузилась и поехала с другим грузом). Чекбокс на 1 этапе мобилы.
   * Default false. См. миграцию 0051.
   */
  inTransit: z.boolean(),
  siteId: z.string().uuid(),
  receiverCounterpartyId: z.string().uuid().nullable(),
  receiverMolId: z.string().uuid().nullable(),
  destSiteId: z.string().uuid().nullable(),
  vehiclePlate: z.string().nullable(),
  driverName: z.string().nullable(),
  shippedAt: z.string().nullable(),
  inspectorId: z.string().uuid().nullable(),
  comment: z.string().nullable(),
  confirmedByMolUserId: z.string().uuid().nullable(),
  confirmedByMolUserEmail: z.string().nullable(),
  confirmedByMolAt: z.string().nullable(),
  pendingDeletionAt: z.string().nullable(),
  pendingDeletionByUserId: z.string().uuid().nullable(),
  pendingDeletionByUserEmail: z.string().nullable(),
  pendingDeletionReason: z.string().nullable(),
  version: z.number(),
  sourceDocumentIds: z.array(z.string().uuid()),
  items: z.array(ShipmentItemSchema),
  photos: z.array(ShipmentPhotoSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Shipment = z.infer<typeof ShipmentSchema>;

export const ShipmentMarkDeletionSchema = z.object({
  reason: z.string().max(500).nullable().optional(),
});
export type ShipmentMarkDeletion = z.infer<typeof ShipmentMarkDeletionSchema>;

export const ShipmentUpsertItemSchema = z.object({
  id: z.string().uuid().optional(),
  itemKind: ItemKindSchema.default('material'),
  materialId: z.string().uuid().nullable().optional(),
  assetId: z.string().uuid().nullable().optional(),
  inventoryNumber: z.string().max(200).nullable().optional(),
  serialNumber: z.string().max(200).nullable().optional(),
  nameRaw: z.string().min(1),
  qtyPlanned: z.string().nullable().optional(),
  qtyActual: z.string().nullable().optional(),
  unit: z.string().min(1).default('шт'),
  comment: z.string().nullable().optional(),
  lineNo: z.number(),
  volumeM3: z.string().nullable().optional(),
  massKg: z.string().nullable().optional(),
  price: z.string().nullable().optional(),
  vatRate: z.string().nullable().optional(),
  vatSum: z.string().nullable().optional(),
  volumeConfidence: VolumeConfidenceSchema.nullable().optional(),
  groupName: z.string().nullable().optional(),
});

export const ShipmentUpsertSchema = z.object({
  id: z.string().uuid().optional(),
  statusCode: ShipmentStatusCodeSchema,
  kind: ShipmentKindSchema,
  siteId: z.string().uuid(),
  receiverCounterpartyId: z.string().uuid().nullable().optional(),
  receiverMolId: z.string().uuid().nullable().optional(),
  destSiteId: z.string().uuid().nullable().optional(),
  vehiclePlate: z.string().max(16).nullable().optional(),
  driverName: z.string().max(200).nullable().optional(),
  shippedAt: z.string().nullable().optional(),
  comment: z.string().nullable().optional(),
  /** «Тип отгрузки» — см. ShipmentSchema.purpose. */
  purpose: z.string().max(200).nullable().optional(),
  /** Транзит — см. ShipmentSchema.inTransit. Default false. */
  inTransit: z.boolean().default(false),
  sourceDocumentIds: z.array(z.string().uuid()).default([]),
  items: z.array(ShipmentUpsertItemSchema).default([]),
  baseVersion: z.number().int().nonnegative().optional(),
});
export type ShipmentUpsert = z.infer<typeof ShipmentUpsertSchema>;

export const ShipmentListResponseSchema = z.object({
  items: z.array(ShipmentSchema),
  total: z.number(),
});

export const ShipmentConflictResponseSchema = z.object({
  error: z.literal('conflict'),
  serverVersion: z.number(),
  server: ShipmentSchema,
});
