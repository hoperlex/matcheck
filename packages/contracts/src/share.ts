import { z } from 'zod';

/**
 * Share-токены: публичные ссылки на просмотр приёмки/отгрузки.
 *
 * Сценарий: менеджер генерирует ссылку, отправляет внешнему получателю
 * (например, поставщику). Получатель открывает /share/{token} без
 * авторизации и видит read-only карточку с фото и материалами.
 * TTL по умолчанию — 10 дней; менеджер может отозвать раньше.
 *
 * Фото отдаются через proxy-endpoint (см. routes/share.ts), S3-URL не
 * раскрывается клиенту.
 */

export const ShareEntityTypeSchema = z.enum(['delivery', 'shipment']);
export type ShareEntityType = z.infer<typeof ShareEntityTypeSchema>;

export const ShareLinkSchema = z.object({
  id: z.string().uuid(),
  entityType: ShareEntityTypeSchema,
  entityId: z.string().uuid(),
  token: z.string(),
  url: z.string(),
  createdByUserId: z.string().uuid(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  accessedCount: z.number(),
  lastAccessedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ShareLink = z.infer<typeof ShareLinkSchema>;

export const ShareLinkListResponseSchema = z.object({
  items: z.array(ShareLinkSchema),
});

/**
 * Публичный view приёмки. Намеренно опускаем чувствительные поля:
 *  - createdByUserId / inspectorId / confirmedByMolUserId — внутренние юзеры;
 *  - email / телефоны — личные данные;
 *  - s3Key / thumbS3Key — путь к S3, заменяется proxy-URL'ом;
 *  - pendingDeletion* — внутренний flow.
 *
 * Цены/НДС возвращаются — это бизнес-данные, которые получатель и должен
 * видеть (поставщик сверяет с тем, что ему оплатили).
 */
export const PublicSharedItemSchema = z.object({
  lineNo: z.number(),
  nameRaw: z.string(),
  unit: z.string(),
  qtyPlanned: z.string().nullable(),
  qtyActual: z.string().nullable(),
  price: z.string().nullable(),
  vatRate: z.string().nullable(),
  vatSum: z.string().nullable(),
});

export const PublicSharedPhotoSchema = z.object({
  id: z.string().uuid(),
  stage: z.string(),
  takenAt: z.string(),
  // URL для <img>: /api/v1/share/{token}/photos/{id} — сервер сам идёт
  // в S3 и стримит байты, S3-URL клиенту не виден.
  url: z.string(),
  thumbUrl: z.string(),
});

export const PublicSharedDeliverySchema = z.object({
  entityType: z.literal('delivery'),
  id: z.string().uuid(),
  status: z.object({ code: z.string(), label: z.string() }),
  siteName: z.string().nullable(),
  supplierName: z.string().nullable(),
  contractorName: z.string().nullable(),
  recipientMolName: z.string().nullable(),
  vehiclePlate: z.string().nullable(),
  driverName: z.string().nullable(),
  arrivedAt: z.string().nullable(),
  comment: z.string().nullable(),
  docNumber: z.string().nullable(),
  docDate: z.string().nullable(),
  expectedDate: z.string().nullable(),
  items: z.array(PublicSharedItemSchema),
  photos: z.array(PublicSharedPhotoSchema),
  shareExpiresAt: z.string(),
});
export type PublicSharedDelivery = z.infer<typeof PublicSharedDeliverySchema>;

export const PublicSharedShipmentSchema = z.object({
  entityType: z.literal('shipment'),
  id: z.string().uuid(),
  status: z.object({ code: z.string(), label: z.string() }),
  kind: z.string(),
  siteName: z.string().nullable(),
  supplierName: z.string().nullable(),
  contractorName: z.string().nullable(),
  recipientMolName: z.string().nullable(),
  vehiclePlate: z.string().nullable(),
  driverName: z.string().nullable(),
  shippedAt: z.string().nullable(),
  comment: z.string().nullable(),
  docNumber: z.string().nullable(),
  docDate: z.string().nullable(),
  items: z.array(PublicSharedItemSchema),
  photos: z.array(PublicSharedPhotoSchema),
  shareExpiresAt: z.string(),
});
export type PublicSharedShipment = z.infer<typeof PublicSharedShipmentSchema>;

export const PublicSharedEntitySchema = z.discriminatedUnion('entityType', [
  PublicSharedDeliverySchema,
  PublicSharedShipmentSchema,
]);
export type PublicSharedEntity = z.infer<typeof PublicSharedEntitySchema>;
