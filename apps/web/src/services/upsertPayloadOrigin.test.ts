/**
 * Происхождение позиций доезжает до API.
 *
 * Тест стоит на ПОСЛЕДНЕМ звене цепочки (форма → buildPatch → IDB overlay →
 * effectiveState → buildUpsertPayload → HTTP). Маппинг в buildUpsertPayload
 * перечисляет поля вручную, и раньше по дороге уже терялись recipientMolId и
 * price/vatRate/vatSum: тест на buildPatch был бы зелёным, а сервер получал бы
 * строки без данных. Здесь проверяется именно то, что уходит в запрос.
 */
import { describe, expect, it } from 'vitest';
import { buildUpsertPayload } from './deliveries';
import { buildUpsertPayload as buildShipmentUpsertPayload } from './shipments';
import type { DeliveryRecord, ShipmentRecord } from '../lib/db';
import type { Delivery, Shipment } from '@matcheck/contracts';

const DOC_ID = '11111111-1111-4111-8111-111111111111';
const DOC_ITEM_ID = '22222222-2222-4222-8222-222222222222';
const ITEM_ID = '33333333-3333-4333-8333-333333333333';

const item = {
  id: ITEM_ID,
  sourceDocumentId: DOC_ID,
  sourceDocumentItemId: DOC_ITEM_ID,
  itemKind: 'material' as const,
  materialId: null,
  assetId: null,
  inventoryNumber: null,
  serialNumber: null,
  nameRaw: 'Труба чугунная SML DN 80',
  qtyPlanned: null,
  qtyActual: '252',
  unit: 'шт',
  comment: null,
  lineNo: 1,
  volumeM3: null,
  massKg: null,
  price: '2565.57',
  vatRate: '20',
  vatSum: '142235.41',
  volumeConfidence: null,
  groupName: null,
};

const baseOperation = {
  id: '44444444-4444-4444-8444-444444444444',
  displayId: 12586,
  status: {
    id: 's1',
    entityType: 'delivery' as const,
    code: 'filled',
    label: 'Оформлена',
    color: 'blue',
    sortOrder: 20,
  },
  siteId: '55555555-5555-4555-8555-555555555555',
  supplierId: null,
  contractorId: null,
  recipientMolId: null,
  vehiclePlate: 'O986HX198',
  driverName: null,
  arrivedAt: null,
  inspectorId: null,
  comment: null,
  inTransit: false,
  isAssets: false,
  version: 3,
  sourceDocumentIds: [DOC_ID],
  photos: [],
  createdAt: '2026-08-28T09:00:00.000Z',
  updatedAt: '2026-08-28T09:00:00.000Z',
};

describe('buildUpsertPayload проводит происхождение позиций', () => {
  it('приёмка: sourceDocumentId и sourceDocumentItemId уходят в запрос', () => {
    const record = {
      id: baseOperation.id,
      server: { ...baseOperation, items: [item] } as unknown as Delivery,
      local: null,
      tombstone: false,
      version: 3,
      lastSyncedAt: Date.now(),
    } as DeliveryRecord;

    const payload = buildUpsertPayload(record);

    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({
      id: ITEM_ID,
      sourceDocumentId: DOC_ID,
      sourceDocumentItemId: DOC_ITEM_ID,
    });
  });

  it('приёмка: строка без происхождения уходит с null, а не пропадает', () => {
    const manual = {
      ...item,
      id: null as unknown as string,
      sourceDocumentId: null,
      sourceDocumentItemId: null,
    };
    const record = {
      id: baseOperation.id,
      server: { ...baseOperation, items: [item, manual] } as unknown as Delivery,
      local: null,
      tombstone: false,
      version: 3,
      lastSyncedAt: Date.now(),
    } as DeliveryRecord;

    const payload = buildUpsertPayload(record);

    expect(payload.items).toHaveLength(2);
    expect(payload.items[1]).toMatchObject({ sourceDocumentId: null, sourceDocumentItemId: null });
  });

  it('приёмка: локальная правка формы не теряет происхождение', () => {
    // Так выглядит сохранение из карточки: buildPatch кладёт items в overlay,
    // effectiveState мержит его поверх серверного снимка.
    const record = {
      id: baseOperation.id,
      server: { ...baseOperation, items: [item] } as unknown as Delivery,
      local: { items: [{ ...item, qtyActual: '250' }] } as unknown as Partial<Delivery>,
      tombstone: false,
      version: 3,
      lastSyncedAt: Date.now(),
    } as DeliveryRecord;

    const payload = buildUpsertPayload(record);

    expect(payload.items[0]).toMatchObject({
      qtyActual: '250',
      sourceDocumentId: DOC_ID,
      sourceDocumentItemId: DOC_ITEM_ID,
    });
  });

  it('отгрузка: то же самое', () => {
    const record = {
      id: baseOperation.id,
      server: {
        ...baseOperation,
        kind: 'contractor',
        status: { ...baseOperation.status, entityType: 'shipment' },
        receiverCounterpartyId: null,
        receiverMolId: null,
        destSiteId: null,
        shippedAt: null,
        purpose: null,
        items: [item],
      } as unknown as Shipment,
      local: null,
      tombstone: false,
      version: 3,
      lastSyncedAt: Date.now(),
    } as ShipmentRecord;

    const payload = buildShipmentUpsertPayload(record);

    expect(payload.items[0]).toMatchObject({
      sourceDocumentId: DOC_ID,
      sourceDocumentItemId: DOC_ITEM_ID,
    });
  });
});
