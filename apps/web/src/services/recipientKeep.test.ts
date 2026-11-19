/**
 * Получатель сохраняется отдельным PATCH, а «Сохранить» его не трогает.
 *
 * Последнее звено цепочки (локальная правка → buildUpsertPayload → HTTP):
 * keepRecipient / keepReceiver уходят, только когда получателя в неотправленной
 * правке нет. Поля получателя при этом всё равно в теле — серверный снимок: старый
 * API флаг отбросит и запишет их, а не null (порядок отката «портал → API»).
 *
 * Старая очередь: правка «до Сохранить» с получателем А лежит в IDB (офлайн или
 * conflictPending), человек выбирает Б — PATCH. dropLocalRecipient убирает А из
 * правки, и следующая отправка очереди идёт с keepRecipient, а не возвращает А.
 * Локальная база настоящая (fake-indexeddb): проверяется содержимое хранилища.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type { Delivery, Shipment } from '@matcheck/contracts';
import type { DeliveryRecord, ShipmentRecord } from '../lib/db';

vi.mock('../stores/auth', () => ({
  useAuthStore: { getState: () => ({ user: { role: 'manager' }, accessToken: 'token' }) },
}));

const { buildUpsertPayload, dropLocalRecipient, getDelivery } = await import('./deliveries');
const {
  buildUpsertPayload: buildShipmentUpsertPayload,
  dropLocalReceiver,
  getShipment,
} = await import('./shipments');
const { withDb } = await import('../lib/db');

const CONTRACTOR_A = '11111111-1111-4111-8111-111111111111';
const CONTRACTOR_B = '22222222-2222-4222-8222-222222222222';
const MOL = '33333333-3333-4333-8333-333333333333';

const baseOperation = {
  displayId: 25946,
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
  vehiclePlate: 'А243МХ550',
  driverName: null,
  arrivedAt: null,
  inspectorId: null,
  comment: null,
  inTransit: false,
  isAssets: false,
  version: 3,
  sourceDocumentIds: [],
  items: [],
  photos: [],
  createdAt: '2026-11-18T09:00:00.000Z',
  updatedAt: '2026-11-18T09:00:00.000Z',
};

function deliveryRecord(
  id: string,
  server: Partial<Delivery> | null,
  local: Partial<Delivery> | null,
): DeliveryRecord {
  return {
    id,
    server: server
      ? ({ ...baseOperation, id, contractorId: null, recipientMolId: null, ...server } as Delivery)
      : null,
    local,
    tombstone: false,
    version: 3,
    lastSyncedAt: null,
  };
}

function shipmentRecord(
  id: string,
  server: Partial<Shipment> | null,
  local: Partial<Shipment> | null,
): ShipmentRecord {
  return {
    id,
    server: server
      ? ({
          ...baseOperation,
          id,
          kind: 'contractor',
          shippedAt: null,
          destSiteId: null,
          purpose: null,
          receiverCounterpartyId: null,
          receiverMolId: null,
          ...server,
        } as unknown as Shipment)
      : null,
    local,
    tombstone: false,
    version: 3,
    lastSyncedAt: null,
  };
}

describe('приёмка: keepRecipient в теле upsert', () => {
  it('получателя в правке нет → keepRecipient, а поля получателя — снимок сервера', () => {
    const payload = buildUpsertPayload(
      deliveryRecord('d-1', { contractorId: CONTRACTOR_A }, { comment: 'правка' }),
      3,
    );
    expect(payload.keepRecipient).toBe(true);
    expect(payload).toMatchObject({ contractorId: CONTRACTOR_A, recipientMolId: null });
    expect(payload.comment).toBe('правка');
  });

  it('получателя правили в форме (режим «до Сохранить») → без флага', () => {
    const payload = buildUpsertPayload(
      deliveryRecord(
        'd-2',
        { contractorId: CONTRACTOR_A },
        { contractorId: null, recipientMolId: MOL },
      ),
      3,
    );
    expect(payload.keepRecipient).toBeUndefined();
    expect(payload).toMatchObject({ contractorId: null, recipientMolId: MOL });
  });

  it('у записи, которой ещё нет на сервере, флага нет — получатель из правки', () => {
    const payload = buildUpsertPayload(deliveryRecord('d-3', null, { contractorId: CONTRACTOR_A }), 0);
    expect(payload.keepRecipient).toBeUndefined();
    expect(payload.contractorId).toBe(CONTRACTOR_A);
  });

  it('старая правка с получателем А → dropLocalRecipient → отправка с keepRecipient, без А', async () => {
    const id = 'd-queue';
    await withDb((dbi) =>
      dbi.put(
        'deliveries',
        deliveryRecord(
          id,
          // Сервер уже знает Б — PATCH прошёл.
          { contractorId: CONTRACTOR_B },
          // Неотправленное «Сохранить» с получателем А и признаком к нему.
          {
            contractorId: CONTRACTOR_A,
            recipientMolId: null,
            purpose: 'tolling_act',
            comment: 'набрано до PATCH',
          },
        ),
      ),
    );
    expect(buildUpsertPayload((await getDelivery(id))!, 3)).toMatchObject({
      contractorId: CONTRACTOR_A,
    });

    await dropLocalRecipient(id);

    const record = (await getDelivery(id))!;
    expect(record.local).toEqual({ comment: 'набрано до PATCH' });
    const payload = buildUpsertPayload(record, 3);
    expect(payload.keepRecipient).toBe(true);
    expect(payload.contractorId).toBe(CONTRACTOR_B);
    expect(payload.purpose).toBeUndefined();
    expect(payload.comment).toBe('набрано до PATCH');
  });

  it('dropLocalRecipient без правки получателя ничего не меняет', async () => {
    const id = 'd-clean';
    const record = deliveryRecord(id, { contractorId: CONTRACTOR_B }, { comment: 'x' });
    await withDb((dbi) => dbi.put('deliveries', record));
    await dropLocalRecipient(id);
    expect((await getDelivery(id))!.local).toEqual({ comment: 'x' });
    await dropLocalRecipient('нет-такой');
    expect(await getDelivery('нет-такой')).toBeUndefined();
  });
});

describe('отгрузка: keepReceiver в теле upsert', () => {
  it('получателя в правке нет → keepReceiver, поля — снимок сервера', () => {
    const payload = buildShipmentUpsertPayload(
      shipmentRecord('s-1', { receiverCounterpartyId: CONTRACTOR_A }, { comment: 'правка' }),
      3,
    );
    expect(payload.keepReceiver).toBe(true);
    expect(payload).toMatchObject({ receiverCounterpartyId: CONTRACTOR_A, receiverMolId: null });
  });

  it('получателя правили в форме → без флага', () => {
    const payload = buildShipmentUpsertPayload(
      shipmentRecord(
        's-2',
        { receiverCounterpartyId: CONTRACTOR_A },
        { receiverCounterpartyId: null, receiverMolId: MOL },
      ),
      3,
    );
    expect(payload.keepReceiver).toBeUndefined();
    expect(payload.receiverMolId).toBe(MOL);
  });

  it('старая правка с получателем А → dropLocalReceiver → отправка с keepReceiver, «Тип» остаётся', async () => {
    const id = 's-queue';
    await withDb((dbi) =>
      dbi.put(
        'shipments',
        shipmentRecord(
          id,
          { receiverCounterpartyId: CONTRACTOR_B },
          { receiverCounterpartyId: CONTRACTOR_A, receiverMolId: null, purpose: 'Материалы' },
        ),
      ),
    );
    await dropLocalReceiver(id);
    const record = (await getShipment(id))!;
    expect(record.local).toEqual({ purpose: 'Материалы' });
    const payload = buildShipmentUpsertPayload(record, 3);
    expect(payload.keepReceiver).toBe(true);
    expect(payload.receiverCounterpartyId).toBe(CONTRACTOR_B);
    expect(payload.purpose).toBe('Материалы');
  });
});
