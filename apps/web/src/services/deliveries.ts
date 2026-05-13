import { db, type DeliveryRecord, type MutationRecord } from '../lib/db';
import type { Delivery, DeliveryUpsert } from '@matcheck/contracts';

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
      status: 'expected',
      supplierId: null,
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

export function buildUpsertPayload(r: DeliveryRecord): DeliveryUpsert {
  const effective = effectiveState(r);
  if (!effective) {
    throw new Error('Cannot build payload for empty delivery');
  }
  return {
    id: r.id,
    status: effective.status,
    supplierId: effective.supplierId,
    vehiclePlate: effective.vehiclePlate,
    driverName: effective.driverName,
    arrivedAt: effective.arrivedAt,
    comment: effective.comment,
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
    })),
    baseVersion: r.version,
  };
}
