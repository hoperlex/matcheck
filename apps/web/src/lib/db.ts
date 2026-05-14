import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  Counterparty,
  Delivery,
  Material,
  Site,
  SourceDocumentDetail,
} from '@matcheck/contracts';

/**
 * Системный объект «Без объекта». Используется при offline-создании приёмки,
 * когда у пользователя ещё нет реальных объектов, и для миграции
 * pending mutations со старой схемы (без siteId).
 */
export const SYSTEM_SITE_ID = '00000000-0000-0000-0000-000000000001';

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
  kind: 'delivery_upsert' | 'delivery_delete';
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
  | (Material & { kind: 'material' })
  | (Site & { kind: 'site' });

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

const DB_VERSION = 2;

export function db(): Promise<IDBPDatabase<MatcheckDB>> {
  if (!dbPromise) {
    dbPromise = openDB<MatcheckDB>('matcheck', DB_VERSION, {
      upgrade(database, oldVersion, _newVersion, tx) {
        if (oldVersion < 1) {
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
        }
        if (oldVersion < 2) {
          // 1) Старые pending-мутации delivery_upsert без siteId зависнут на сервере
          //    с 400 после деплоя. Досыпаем системный siteId и contractorId: null.
          const muts = tx.objectStore('mutations');
          muts.openCursor().then(async function walk(cursor) {
            if (!cursor) return;
            const m = cursor.value;
            if (m.kind === 'delivery_upsert' && m.payload && typeof m.payload === 'object') {
              const payload = m.payload as Record<string, unknown>;
              let dirty = false;
              if (payload.siteId === undefined) {
                payload.siteId = SYSTEM_SITE_ID;
                dirty = true;
              }
              if (payload.contractorId === undefined) {
                payload.contractorId = null;
                dirty = true;
              }
              if (dirty) await cursor.update({ ...m, payload });
            }
            const next = await cursor.continue();
            await walk(next);
          });

          // 2) Локальные правки в deliveries без siteId — заполняем системным.
          const dels = tx.objectStore('deliveries');
          dels.openCursor().then(async function walk(cursor) {
            if (!cursor) return;
            const r = cursor.value;
            if (r.local && r.local.siteId === undefined) {
              await cursor.update({ ...r, local: { ...r.local, siteId: SYSTEM_SITE_ID } });
            }
            const next = await cursor.continue();
            await walk(next);
          });
        }
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
