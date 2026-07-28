import { db, SYSTEM_SITE_ID, type MutationRecord, type ShipmentRecord } from '../lib/db';
import type {
  Shipment,
  ShipmentKind,
  ShipmentStatusCode,
  ShipmentUpsert,
  Status,
} from '@matcheck/contracts';
import { api } from './api';

const PLACEHOLDER_NOT_FILLED: Status = {
  id: '',
  entityType: 'shipment',
  code: 'not_filled',
  label: 'Не оформлена',
  color: 'orange',
  sortOrder: 10,
};

export async function listLocalShipments(): Promise<ShipmentRecord[]> {
  const d = await db();
  return d.getAll('shipments');
}

export async function getShipment(id: string): Promise<ShipmentRecord | undefined> {
  const d = await db();
  return d.get('shipments', id);
}

export function effectiveState(r: ShipmentRecord): Shipment | null {
  if (r.tombstone) return null;
  if (!r.server) {
    if (!r.local) return null;
    return {
      id: r.id,
      // displayId назначается БД через sequence (миграция 0059); у
      // pure-local-черновика ставим 0.
      displayId: 0,
      status: PLACEHOLDER_NOT_FILLED,
      kind: 'contractor' satisfies ShipmentKind,
      siteId: SYSTEM_SITE_ID,
      receiverCounterpartyId: null,
      destSiteId: null,
      vehiclePlate: null,
      driverName: null,
      shippedAt: null,
      inspectorId: null,
      comment: null,
      version: 0,
      sourceDocumentIds: [],
      items: [],
      photos: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...r.local,
    } as Shipment;
  }
  if (!r.local) return r.server;
  return { ...r.server, ...r.local };
}

export async function upsertServerSnapshot(items: Shipment[]): Promise<void> {
  const d = await db();
  const tx = d.transaction('shipments', 'readwrite');
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

export async function applyLocalEdit(id: string, patch: Partial<Shipment>): Promise<void> {
  const d = await db();
  const existing = await d.get('shipments', id);
  const next: ShipmentRecord = existing
    ? { ...existing, local: { ...(existing.local ?? {}), ...patch } }
    : {
        id,
        server: null,
        local: patch,
        tombstone: false,
        version: 0,
        lastSyncedAt: null,
      };
  await d.put('shipments', next);
}

export async function markTombstone(id: string): Promise<void> {
  const d = await db();
  const existing = await d.get('shipments', id);
  if (existing) {
    await d.put('shipments', { ...existing, tombstone: true });
  }
}

export async function enqueueMutation(
  m: Omit<MutationRecord, 'attempts' | 'createdAt'>,
): Promise<void> {
  const d = await db();
  await d.put('mutations', { ...m, attempts: 0, createdAt: Date.now() });
}

// Soft-delete операции — см. одноимённые функции в services/deliveries.ts.
export function markDeletion(id: string, reason: string | null = null): Promise<Shipment> {
  return api.post<Shipment>(`/shipments/${id}/mark-deletion`, { reason });
}

export function unmarkDeletion(id: string): Promise<Shipment> {
  return api.post<Shipment>(`/shipments/${id}/unmark-deletion`);
}

export function hardDeleteShipment(id: string): Promise<{ ok: true }> {
  return api.delete<{ ok: true }>(`/shipments/${id}`);
}

export function buildUpsertPayload(r: ShipmentRecord): ShipmentUpsert {
  const effective = effectiveState(r);
  if (!effective) {
    throw new Error('Cannot build payload for empty shipment');
  }
  return {
    id: r.id,
    statusCode: effective.status.code as ShipmentStatusCode,
    kind: effective.kind,
    siteId: effective.siteId,
    // Все три «получателя/поставщика/тип отгрузки» — UI их обновляет
    // через InlineEditChip, но без этих строк save через offline-очередь
    // отбрасывал значения, и при повторном открытии Принятой отгрузки
    // поля возвращались к исходному состоянию.
    receiverCounterpartyId: effective.receiverCounterpartyId,
    receiverMolId: effective.receiverMolId,
    supplierId: effective.supplierId,
    destSiteId: effective.destSiteId,
    purpose: effective.purpose,
    vehiclePlate: effective.vehiclePlate,
    driverName: effective.driverName,
    shippedAt: effective.shippedAt,
    comment: effective.comment,
    inTransit: effective.inTransit ?? false,
    isAssets: effective.isAssets ?? false,
    sourceDocumentIds: effective.sourceDocumentIds,
    items: effective.items.map((it) => ({
      id: it.id,
      itemKind: it.itemKind,
      materialId: it.materialId,
      assetId: it.assetId,
      inventoryNumber: it.inventoryNumber,
      serialNumber: it.serialNumber,
      nameRaw: it.nameRaw,
      qtyPlanned: it.qtyPlanned,
      qtyActual: it.qtyActual,
      unit: it.unit,
      comment: it.comment,
      lineNo: it.lineNo,
      volumeM3: it.volumeM3,
      massKg: it.massKg,
      // Цена / ставка НДС / сумма НДС материалов теперь доезжают до
      // сервера и не теряются на пути IDB → API.
      price: it.price,
      vatRate: it.vatRate,
      vatSum: it.vatSum,
      volumeConfidence: it.volumeConfidence,
      groupName: it.groupName,
    })),
    baseVersion: r.version,
  };
}
