import { z } from 'zod';
import { DeliveryStatusCodeSchema, StatusSchema } from './statuses.js';

export const DeliveryItemSchema = z.object({
  id: z.string().uuid(),
  materialId: z.string().uuid().nullable(),
  nameRaw: z.string(),
  qtyPlanned: z.string().nullable(),
  qtyActual: z.string().nullable(),
  unit: z.string(),
  comment: z.string().nullable(),
  lineNo: z.number(),
});
export type DeliveryItem = z.infer<typeof DeliveryItemSchema>;

export const DeliveryPhotoSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['document', 'cargo', 'vehicle', 'other']),
  s3Key: z.string(),
  thumbS3Key: z.string().nullable(),
  contentHash: z.string().nullable(),
  takenAt: z.string(),
});
export type DeliveryPhoto = z.infer<typeof DeliveryPhotoSchema>;

export const DeliverySchema = z.object({
  id: z.string().uuid(),
  status: StatusSchema,
  supplierId: z.string().uuid().nullable(),
  vehiclePlate: z.string().nullable(),
  driverName: z.string().nullable(),
  arrivedAt: z.string().nullable(),
  inspectorId: z.string().uuid().nullable(),
  comment: z.string().nullable(),
  version: z.number(),
  sourceDocumentIds: z.array(z.string().uuid()),
  items: z.array(DeliveryItemSchema),
  photos: z.array(DeliveryPhotoSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Delivery = z.infer<typeof DeliverySchema>;

export const DeliveryUpsertItemSchema = z.object({
  id: z.string().uuid().optional(),
  materialId: z.string().uuid().nullable().optional(),
  nameRaw: z.string().min(1),
  qtyPlanned: z.string().nullable().optional(),
  qtyActual: z.string().nullable().optional(),
  unit: z.string().min(1).default('шт'),
  comment: z.string().nullable().optional(),
  lineNo: z.number(),
});

export const DeliveryUpsertSchema = z.object({
  id: z.string().uuid().optional(),
  statusCode: DeliveryStatusCodeSchema,
  supplierId: z.string().uuid().nullable().optional(),
  vehiclePlate: z.string().max(16).nullable().optional(),
  driverName: z.string().max(200).nullable().optional(),
  arrivedAt: z.string().nullable().optional(),
  comment: z.string().nullable().optional(),
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
