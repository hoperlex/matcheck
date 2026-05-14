import { z } from 'zod';
import { DeliverySchema } from './deliveries.js';
import { SourceDocumentDetailSchema } from './source-documents.js';
import { CounterpartySchema } from './counterparties.js';
import { MaterialSchema } from './materials.js';
import { SiteSchema } from './sites.js';

export const SyncDeltaResponseSchema = z.object({
  cursor: z.string(),
  deliveries: z.array(DeliverySchema),
  sourceDocuments: z.array(SourceDocumentDetailSchema),
  counterparties: z.array(CounterpartySchema),
  materials: z.array(MaterialSchema),
  sites: z.array(SiteSchema),
  serverNow: z.string(),
});
export type SyncDeltaResponse = z.infer<typeof SyncDeltaResponseSchema>;

export const SseEventSchema = z.object({
  type: z.enum([
    'delivery_updated',
    'delivery_deleted',
    'source_document_updated',
    'counterparty_updated',
    'material_updated',
    'site_updated',
    'ping',
  ]),
  id: z.string().optional(),
  ts: z.string(),
});
export type SseEvent = z.infer<typeof SseEventSchema>;
