import { z } from 'zod';
import { DeliverySchema } from './deliveries.js';
import { ShipmentSchema } from './shipments.js';
import { SourceDocumentDetailSchema } from './source-documents.js';
import { CounterpartySchema } from './counterparties.js';
import { MaterialSchema } from './materials.js';
import { SiteSchema } from './sites.js';
import { StatusSchema } from './statuses.js';

// Журнал hard-delete операций. Возвращается /sync с фильтром `deleted_at >= since`
// (для initial-sync без since — пустые массивы; полная история не нужна).
// Клиент при обработке /sync должен удалить локальные записи с этими id.
export const SyncDeletedIdsSchema = z.object({
  deliveries: z.array(z.string().uuid()),
  shipments: z.array(z.string().uuid()),
  sourceDocuments: z.array(z.string().uuid()),
});
export type SyncDeletedIds = z.infer<typeof SyncDeletedIdsSchema>;

export const SyncDeltaResponseSchema = z.object({
  cursor: z.string(),
  deliveries: z.array(DeliverySchema),
  shipments: z.array(ShipmentSchema),
  sourceDocuments: z.array(SourceDocumentDetailSchema),
  counterparties: z.array(CounterpartySchema),
  materials: z.array(MaterialSchema),
  sites: z.array(SiteSchema),
  // Лейблы и цвета статусов (entity_type='delivery'|'shipment'|…) — клиент
  // использует их вместо хардкода. Меняются редко, отдаются всегда без фильтра.
  statuses: z.array(StatusSchema),
  deletedIds: SyncDeletedIdsSchema,
  serverNow: z.string(),
});
export type SyncDeltaResponse = z.infer<typeof SyncDeltaResponseSchema>;

export const SseEventSchema = z.object({
  type: z.enum([
    'delivery_updated',
    'delivery_deleted',
    'shipment_updated',
    'shipment_deleted',
    'source_document_updated',
    'source_document_deleted',
    'counterparty_updated',
    'material_updated',
    'site_updated',
    'ping',
  ]),
  // ID сущности для событий *_updated / *_deleted. Для ping — отсутствует.
  // Клиент при `*_deleted` удаляет локальную запись без вызова /sync.
  entityId: z.string().uuid().optional(),
  ts: z.string(),
});
export type SseEvent = z.infer<typeof SseEventSchema>;
