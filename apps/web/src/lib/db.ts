import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Counterparty, Delivery, Material, SourceDocumentDetail } from '@matcheck/contracts';

export type DeliveryRecord = {
  id: string;
  server: Delivery | null;
  local: Partial<Delivery> | null;
  tombstone: boolean;
  version: number;
  lastSyncedAt: number | null;
};

export type MutationRecord = {
  id: string;
  kind: 'delivery_upsert' | 'delivery_delete' | 'photo_upload';
  entityId: string;
  baseVersion: number;
  payload: unknown;
  attempts: number;
  createdAt: number;
  conflictPending?: boolean;
};

export type PhotoRecord = {
  id: string;
  deliveryId: string;
  origin: 'local' | 'remote';
  kind: 'document' | 'cargo' | 'vehicle' | 'other';
  contentHash: string;
  idempotencyKey: string;
  blob?: Blob;
  thumbBlob?: Blob;
  s3Key?: string;
  thumbS3Key?: string;
  takenAt: number;
  uploaded: boolean;
};

export type ReferenceRecord =
  | (Counterparty & { kind: 'counterparty' })
  | (Material & { kind: 'material' });

export type SettingsRecord = {
  key: string;
  value: unknown;
};

interface MatcheckDB extends DBSchema {
  deliveries: { key: string; value: DeliveryRecord; indexes: { byTombstone: 'tombstone' } };
  mutations: { key: string; value: MutationRecord; indexes: { byEntity: 'entityId' } };
  photos: {
    key: string;
    value: PhotoRecord;
    indexes: { byDelivery: 'deliveryId'; byHash: 'contentHash' };
  };
  source_documents: { key: string; value: SourceDocumentDetail };
  references: { key: string; value: ReferenceRecord; indexes: { byKind: 'kind' } };
  settings: { key: string; value: SettingsRecord };
}

let dbPromise: Promise<IDBPDatabase<MatcheckDB>> | null = null;

export function db(): Promise<IDBPDatabase<MatcheckDB>> {
  if (!dbPromise) {
    dbPromise = openDB<MatcheckDB>('matcheck', 1, {
      upgrade(database) {
        const dels = database.createObjectStore('deliveries', { keyPath: 'id' });
        dels.createIndex('byTombstone', 'tombstone');
        const muts = database.createObjectStore('mutations', { keyPath: 'id' });
        muts.createIndex('byEntity', 'entityId');
        const photos = database.createObjectStore('photos', { keyPath: 'id' });
        photos.createIndex('byDelivery', 'deliveryId');
        photos.createIndex('byHash', 'contentHash');
        database.createObjectStore('source_documents', { keyPath: 'id' });
        const refs = database.createObjectStore('references', { keyPath: 'id' });
        refs.createIndex('byKind', 'kind');
        database.createObjectStore('settings', { keyPath: 'key' });
      },
    });
  }
  return dbPromise;
}

export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  const d = await db();
  const row = await d.get('settings', key);
  return (row?.value as T) ?? null;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const d = await db();
  await d.put('settings', { key, value });
}
