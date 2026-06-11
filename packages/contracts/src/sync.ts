import { z } from 'zod';
import { DeliverySchema } from './deliveries.js';
import { ShipmentSchema } from './shipments.js';
import { SourceDocumentDetailSchema } from './source-documents.js';
import { CounterpartySchema } from './counterparties.js';
import { MaterialSchema } from './materials.js';
import { ResponsiblePersonSchema } from './responsible-persons.js';
import { AssetSchema } from './assets.js';
import { SiteSchema } from './sites.js';
import { StatusSchema } from './statuses.js';
import { UnitSchema } from './units.js';

// Журнал hard-delete операций. Возвращается /sync с фильтром `deleted_at >= since`
// (для initial-sync без since — пустые массивы; полная история не нужна).
// Клиент при обработке /sync должен удалить локальные записи с этими id.
export const SyncDeletedIdsSchema = z.object({
  deliveries: z.array(z.string().uuid()),
  shipments: z.array(z.string().uuid()),
  sourceDocuments: z.array(z.string().uuid()),
  responsiblePersons: z.array(z.string().uuid()),
  assets: z.array(z.string().uuid()),
});
export type SyncDeletedIds = z.infer<typeof SyncDeletedIdsSchema>;

export const SyncDeltaResponseSchema = z.object({
  cursor: z.string(),
  deliveries: z.array(DeliverySchema),
  shipments: z.array(ShipmentSchema),
  sourceDocuments: z.array(SourceDocumentDetailSchema),
  counterparties: z.array(CounterpartySchema),
  materials: z.array(MaterialSchema),
  responsiblePersons: z.array(ResponsiblePersonSchema),
  assets: z.array(AssetSchema),
  sites: z.array(SiteSchema),
  // Лейблы и цвета статусов (entity_type='delivery'|'shipment'|…) — клиент
  // использует их вместо хардкода. Меняются редко, отдаются всегда без фильтра.
  statuses: z.array(StatusSchema),
  // Единицы измерения — справочник для дропдауна «Ед.» в модалке материалов
  // на мобиле. Меняются редко. На клиенте сохраняются в Room, далее
  // используются как whitelist при добавлении строк материалов.
  units: z.array(UnitSchema),
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
    // user_updated публикуется при PATCH /users/:id. На мобиле обычно
    // влияет только смена user.siteId (см. SyncRepository.syncOnce →
    // refreshSiteIdFromServer); клиент тригерит requestImmediateSync,
    // получает свежий siteId через /me и переписывает tokenStorage.
    'user_updated',
    'ping',
  ]),
  // ID сущности для событий *_updated / *_deleted. Для ping — отсутствует.
  // Клиент при `*_deleted` удаляет локальную запись без вызова /sync.
  entityId: z.string().uuid().optional(),
  ts: z.string(),
});
export type SseEvent = z.infer<typeof SseEventSchema>;
