import { z } from 'zod';
import { ShipmentStatusCodeSchema, StatusSchema } from './statuses.js';
import { VolumeConfidenceSchema } from './source-documents.js';

export const ShipmentKindSchema = z.enum(['contractor', 'return', 'transfer', 'writeoff']);
export type ShipmentKind = z.infer<typeof ShipmentKindSchema>;

export const ShipmentItemSchema = z.object({
  id: z.string().uuid(),
  materialId: z.string().uuid().nullable(),
  nameRaw: z.string(),
  qtyPlanned: z.string().nullable(),
  qtyActual: z.string().nullable(),
  unit: z.string(),
  comment: z.string().nullable(),
  lineNo: z.number(),
  volumeM3: z.string().nullable(),
  massKg: z.string().nullable(),
  volumeConfidence: VolumeConfidenceSchema.nullable(),
  groupName: z.string().nullable(),
});
export type ShipmentItem = z.infer<typeof ShipmentItemSchema>;

export const ShipmentPhotoSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['document', 'cargo', 'vehicle', 'other']),
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
  siteId: z.string().uuid(),
  receiverCounterpartyId: z.string().uuid().nullable(),
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
  materialId: z.string().uuid().nullable().optional(),
  nameRaw: z.string().min(1),
  qtyPlanned: z.string().nullable().optional(),
  qtyActual: z.string().nullable().optional(),
  unit: z.string().min(1).default('шт'),
  comment: z.string().nullable().optional(),
  lineNo: z.number(),
  volumeM3: z.string().nullable().optional(),
  massKg: z.string().nullable().optional(),
  volumeConfidence: VolumeConfidenceSchema.nullable().optional(),
  groupName: z.string().nullable().optional(),
});

export const ShipmentUpsertSchema = z.object({
  id: z.string().uuid().optional(),
  statusCode: ShipmentStatusCodeSchema,
  kind: ShipmentKindSchema,
  siteId: z.string().uuid(),
  receiverCounterpartyId: z.string().uuid().nullable().optional(),
  destSiteId: z.string().uuid().nullable().optional(),
  vehiclePlate: z.string().max(16).nullable().optional(),
  driverName: z.string().max(200).nullable().optional(),
  shippedAt: z.string().nullable().optional(),
  comment: z.string().nullable().optional(),
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
