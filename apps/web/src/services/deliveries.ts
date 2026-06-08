import { db, SYSTEM_SITE_ID, type DeliveryRecord, type MutationRecord } from '../lib/db';
import type { Delivery, DeliveryStatusCode, DeliveryUpsert, Status } from '@matcheck/contracts';
import { api } from './api';

const PLACEHOLDER_NOT_FILLED: Status = {
  id: '',
  entityType: 'delivery',
  code: 'not_filled',
  label: 'Не оформлена',
  color: 'orange',
  sortOrder: 10,
};

export async function listLocalDeliveries(): Promise<DeliveryRecord[]> {
  const d = await db();
  return d.getAll('deliveries');
}

export async function getDelivery(id: string): Promise<DeliveryRecord | undefined> {
  const d = await db();
  return d.get('deliveries', id);
}

export function effectiveState(r: DeliveryRecord): Delivery | null {
  if (r.tombstone) return null;
  if (!r.server) {
    // Pure local draft. Compose from local overlay.
    if (!r.local) return null;
    return {
      id: r.id,
      status: PLACEHOLDER_NOT_FILLED,
      siteId: SYSTEM_SITE_ID,
      supplierId: null,
      contractorId: null,
      vehiclePlate: null,
      driverName: null,
      arrivedAt: null,
      inspectorId: null,
      comment: null,
      version: 0,
      sourceDocumentIds: [],
      items: [],
      photos: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...r.local,
    } as Delivery;
  }
  if (!r.local) return r.server;
  return { ...r.server, ...r.local };
}

export async function upsertServerSnapshot(items: Delivery[]): Promise<void> {
  const d = await db();
  const tx = d.transaction('deliveries', 'readwrite');
  for (const item of items) {
    const existing = await tx.store.get(item.id);
    if (existing) {
      await tx.store.put({
        ...existing,
        server: item,
        version: item.version,
        lastSyncedAt: Date.now(),
      });
    } else {
      await tx.store.put({
        id: item.id,
        server: item,
        local: null,
        tombstone: false,
        version: item.version,
        lastSyncedAt: Date.now(),
      });
    }
  }
  await tx.done;
}

export async function applyLocalEdit(id: string, patch: Partial<Delivery>): Promise<void> {
  const d = await db();
  const existing = await d.get('deliveries', id);
  const next: DeliveryRecord = existing
    ? { ...existing, local: { ...(existing.local ?? {}), ...patch } }
    : {
        id,
        server: null,
        local: patch,
        tombstone: false,
        version: 0,
        lastSyncedAt: null,
      };
  await d.put('deliveries', next);
}

export async function markTombstone(id: string): Promise<void> {
  const d = await db();
  const existing = await d.get('deliveries', id);
  if (existing) {
    await d.put('deliveries', { ...existing, tombstone: true });
  }
}

export async function enqueueMutation(
  m: Omit<MutationRecord, 'attempts' | 'createdAt'>,
): Promise<void> {
  const d = await db();
  await d.put('mutations', { ...m, attempts: 0, createdAt: Date.now() });
}

// Soft-delete операции — обращаемся к серверу напрямую и возвращаем свежий DTO.
// Локальное хранилище IndexedDB у помеченных документов не используется: они
// сразу становятся read-only, а после восстановления invalidate перечитает.
export function markDeletion(id: string, reason: string | null = null): Promise<Delivery> {
  return api.post<Delivery>(`/deliveries/${id}/mark-deletion`, { reason });
}

export function unmarkDeletion(id: string): Promise<Delivery> {
  return api.post<Delivery>(`/deliveries/${id}/unmark-deletion`);
}

export function hardDeleteDelivery(id: string): Promise<{ ok: true }> {
  return api.delete<{ ok: true }>(`/deliveries/${id}`);
}

export function buildUpsertPayload(r: DeliveryRecord): DeliveryUpsert {
  const effective = effectiveState(r);
  if (!effective) {
    throw new Error('Cannot build payload for empty delivery');
  }
  return {
    id: r.id,
    statusCode: effective.status.code as DeliveryStatusCode,
    siteId: effective.siteId,
    supplierId: effective.supplierId,
    contractorId: effective.contractorId,
    vehiclePlate: effective.vehiclePlate,
    driverName: effective.driverName,
    arrivedAt: effective.arrivedAt,
    comment: effective.comment,
    inTransit: effective.inTransit ?? false,
    sourceDocumentIds: effective.sourceDocumentIds,
    items: effective.items.map((it) => ({
      id: it.id,
      materialId: it.materialId,
      nameRaw: it.nameRaw,
      qtyPlanned: it.qtyPlanned,
      qtyActual: it.qtyActual,
      unit: it.unit,
      comment: it.comment,
      lineNo: it.lineNo,
      volumeM3: it.volumeM3,
      massKg: it.massKg,
      volumeConfidence: it.volumeConfidence,
      groupName: it.groupName,
    })),
    baseVersion: r.version,
  };
}
