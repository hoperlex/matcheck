import { z } from 'zod';
import { DeliveryStatusCodeSchema, StatusSchema } from './statuses.js';
import { VolumeConfidenceSchema } from './source-documents.js';
import { ReviewFieldsShape } from './review.js';

export const ItemKindSchema = z.enum(['material', 'asset']);
export type ItemKind = z.infer<typeof ItemKindSchema>;

export const DeliveryItemSchema = z.object({
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
  // Финансовый снимок позиции из УПД: цена за единицу, ставка НДС (%),
  // сумма НДС. price/vatRate подтягиваются один раз при создании
  // приёмки из УПД; vatSum пересчитывается клиентом из qtyActual×price×vatRate
  // и приходит на сервер уже пересчитанным.
  price: z.string().nullable(),
  vatRate: z.string().nullable(),
  vatSum: z.string().nullable(),
  volumeConfidence: VolumeConfidenceSchema.nullable(),
  groupName: z.string().nullable(),
});
export type DeliveryItem = z.infer<typeof DeliveryItemSchema>;

// Этап приёмки, к которому относится фото. Проставляет мобильный клиент
// при загрузке: 'before' — фото 1-го этапа (КПП/осмотр), 'after' — фото
// 2-го этапа (после выгрузки и подтверждения МОЛ). Default 'before'
// для совместимости с клиентами, не присылающими поле.
export const DeliveryPhotoStageSchema = z.enum(['before', 'after']);
export type DeliveryPhotoStage = z.infer<typeof DeliveryPhotoStageSchema>;

export const DeliveryPhotoSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['document', 'cargo', 'vehicle', 'other']),
  stage: DeliveryPhotoStageSchema.default('before'),
  s3Key: z.string(),
  thumbS3Key: z.string().nullable(),
  contentHash: z.string().nullable(),
  takenAt: z.string(),
  // null = orphan-запись (PUT в S3 не подтверждён). Клиент не должен пытаться
  // открыть такое фото — через час оно либо подтвердится cleanup-job'ом, либо
  // удалится.
  uploadedAt: z.string().nullable(),
});
export type DeliveryPhoto = z.infer<typeof DeliveryPhotoSchema>;

export const DeliverySchema = z.object({
  id: z.string().uuid(),
  // Короткий человекочитаемый id для столбца «id» в Принятых и
  // заголовка модалки «Приёмка #N». Авто-возрастающий, уникальный.
  displayId: z.number().int().positive(),
  status: StatusSchema,
  siteId: z.string().uuid(),
  supplierId: z.string().uuid().nullable(),
  contractorId: z.string().uuid().nullable(),
  recipientMolId: z.string().uuid().nullable(),
  // Имена объекта/поставщика/подрядчика — резолвятся сервером в DTO, чтобы
  // роль contractor не ходила в закрытые для неё справочники. optional —
  // мобильный клиент их не шлёт при upsert и может не знать (обратная совместимость).
  siteName: z.string().nullable().optional(),
  supplierName: z.string().nullable().optional(),
  contractorName: z.string().nullable().optional(),
  vehiclePlate: z.string().nullable(),
  driverName: z.string().nullable(),
  arrivedAt: z.string().nullable(),
  inspectorId: z.string().uuid().nullable(),
  comment: z.string().nullable(),
  /**
   * Транзит — приёмка является частью транзитного рейса (машина
   * разгрузилась и поехала с другим грузом). Чекбокс на 1 этапе мобилы.
   * Default false. См. миграцию 0051.
   */
  inTransit: z.boolean(),
  /**
   * ОС — флаг «основные средства»: накладная относится к движению
   * объектов ОС, а не материалов. Чекбокс на 1 этапе мобилы. Default
   * false. Веб-портал показывает бейдж рядом с «Транзит». См. миграцию 0065.
   */
  isAssets: z.boolean(),
  confirmedByMolUserId: z.string().uuid().nullable(),
  confirmedByMolUserEmail: z.string().nullable(),
  confirmedByMolAt: z.string().nullable(),
  // Отметка проверки (роль «Мониторинг»). Ортогональна статусу. Видна только
  // admin/manager/monitor — для прочих ролей сервер отдаёт их null (см. buildDeliveryDto).
  ...ReviewFieldsShape,
  pendingDeletionAt: z.string().nullable(),
  pendingDeletionByUserId: z.string().uuid().nullable(),
  pendingDeletionByUserEmail: z.string().nullable(),
  pendingDeletionReason: z.string().nullable(),
  version: z.number(),
  sourceDocumentIds: z.array(z.string().uuid()),
  // Для парных приёмок, созданных из shipment.kind='transfer': указывает
  // на исходный shipment и подтягивает плоские поля исходного объекта/даты
  // отгрузки. Read-only, заполняется сервером.
  sourceShipmentId: z.string().uuid().nullable(),
  sourceShipmentShippedAt: z.string().nullable(),
  sourceShipmentSiteId: z.string().uuid().nullable(),
  sourceShipmentSiteCode: z.string().nullable(),
  items: z.array(DeliveryItemSchema),
  photos: z.array(DeliveryPhotoSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Delivery = z.infer<typeof DeliverySchema>;

export const DeliveryMarkDeletionSchema = z.object({
  reason: z.string().max(500).nullable().optional(),
});
export type DeliveryMarkDeletion = z.infer<typeof DeliveryMarkDeletionSchema>;

export const DeliveryUpsertItemSchema = z.object({
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

export const DeliveryUpsertSchema = z.object({
  id: z.string().uuid().optional(),
  statusCode: DeliveryStatusCodeSchema,
  siteId: z.string().uuid(),
  supplierId: z.string().uuid().nullable().optional(),
  contractorId: z.string().uuid().nullable().optional(),
  recipientMolId: z.string().uuid().nullable().optional(),
  vehiclePlate: z.string().max(16).nullable().optional(),
  driverName: z.string().max(200).nullable().optional(),
  arrivedAt: z.string().nullable().optional(),
  comment: z.string().nullable().optional(),
  /** Транзит — см. DeliverySchema.inTransit. Default false. */
  inTransit: z.boolean().default(false),
  /** ОС — см. DeliverySchema.isAssets. Default false. */
  isAssets: z.boolean().default(false),
  sourceDocumentIds: z.array(z.string().uuid()).default([]),
  items: z.array(DeliveryUpsertItemSchema).default([]),
  baseVersion: z.number().int().nonnegative().optional(),
});
export type DeliveryUpsert = z.infer<typeof DeliveryUpsertSchema>;

export const DeliveryListResponseSchema = z.object({
  items: z.array(DeliverySchema),
  total: z.number(),
});

export const ConflictResponseSchema = z.object({
  error: z.literal('conflict'),
  serverVersion: z.number(),
  server: DeliverySchema,
});
