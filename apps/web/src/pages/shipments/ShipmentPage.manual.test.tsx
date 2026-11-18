// @vitest-environment jsdom
/**
 * «Ручной вынос» в карточке отгрузки — зеркало KppPage.manual.test.tsx.
 *
 *  - Машины нет: госномер не требуется. Получатель не требуется, пока к
 *    отгрузке не привязан документ — так же решает сервер (isEmptyDraft в
 *    validateKindLinks); с документом без получателя сервер ответил бы 422.
 *  - Новый ручной вынос — один этап, время отгрузки и подтверждения — момент
 *    первого «Сохранить», повторное «Сохранить» офлайн его не сдвигает.
 */
import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Shipment } from '@matcheck/contracts';
import type * as ApiModuleNs from '../../services/api';
import type * as ShipmentsModuleNs from '../../services/shipments';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  enqueueMutation: vi.fn(),
  flushMutation: vi.fn(),
}));

vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof ApiModuleNs>('../../services/api');
  return {
    ...actual,
    api: { get: mocks.apiGet, post: mocks.apiPost, patch: vi.fn(), delete: vi.fn() },
    apiDownload: vi.fn(),
  };
});
vi.mock('../../services/shipments', async () => {
  const actual = await vi.importActual<typeof ShipmentsModuleNs>('../../services/shipments');
  // applyLocalEdit — настоящий: проверяем, что второе сохранение не затирает время.
  return { ...actual, enqueueMutation: mocks.enqueueMutation };
});
vi.mock('../../services/mutationQueue', () => ({ flushMutation: mocks.flushMutation }));
vi.mock('../../services/sync', () => ({ runSync: vi.fn(async () => undefined) }));
vi.mock('../../services/photoPipeline', () => ({
  capturePhoto: vi.fn(),
  onPhotoUploadSettled: () => () => undefined,
}));
vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({
    can: () => true,
    canView: () => true,
    canViewGroup: () => true,
    hasCapability: () => true,
    enforced: true,
    loading: false,
  }),
}));
const SITE = '55555555-5555-4555-8555-555555555555';
const authUser = { id: 'u-1', email: 'kpp@test.com', role: 'inspector_kpp', siteId: SITE };
vi.mock('../../stores/auth', () => ({
  useAuthStore: Object.assign((selector: (s: unknown) => unknown) => selector({ user: authUser }), {
    getState: () => ({ user: authUser, accessToken: 'token' }),
    // Отметки «просмотрено» у фото подписываются на смену пользователя.
    subscribe: () => () => {},
  }),
}));

const { default: ShipmentPage } = await import('./ShipmentPage');
const { buildUpsertPayload } = await import('../../services/shipments');
const { db } = await import('../../lib/db');

const ID = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';

function shipment(over: Partial<Shipment>): Shipment {
  return {
    id: ID,
    displayId: 1972,
    status: {
      id: 's',
      entityType: 'shipment',
      code: 'confirmed_mol',
      label: 'Подтверждено МОЛ',
      color: 'green',
      sortOrder: 40,
    },
    kind: 'contractor',
    purpose: null,
    inTransit: false,
    isAssets: false,
    siteId: SITE,
    receiverCounterpartyId: null,
    receiverMolId: null,
    destSiteId: null,
    supplierId: null,
    siteName: 'Объект',
    supplierName: null,
    receiverName: null,
    vehiclePlate: null,
    driverName: null,
    shippedAt: '2026-11-16T09:00:00.000Z',
    inspectorId: null,
    comment: 'Ручной вынос',
    confirmedByMolUserId: null,
    confirmedByMolUserEmail: null,
    confirmedByMolAt: '2026-11-16T09:00:00.000Z',
    reviewState: null,
    reviewNote: null,
    reviewedByUserId: null,
    reviewedByUserEmail: null,
    reviewedAt: null,
    pendingDeletionAt: null,
    pendingDeletionByUserId: null,
    pendingDeletionByUserEmail: null,
    pendingDeletionReason: null,
    version: 1,
    sourceDocumentIds: [],
    items: [],
    photos: [
      {
        id: '66666666-6666-4666-8666-666666666666',
        kind: 'cargo',
        stage: 'before',
        s3Key: 'k',
        thumbS3Key: null,
        contentHash: null,
        takenAt: '2026-11-16T09:00:00.000Z',
        uploadedAt: '2026-11-16T09:00:00.000Z',
      },
    ],
    sourceDocuments: [],
    createdAt: '2026-11-16T09:00:00.000Z',
    updatedAt: '2026-11-16T09:00:00.000Z',
    ...over,
  } as unknown as Shipment;
}

let current: Shipment;

function route(url: string): unknown {
  if (url === `/shipments/${ID}`) return current;
  if (url.startsWith('/source-documents/')) {
    return {
      id: DOC,
      kind: 'upd',
      docNumber: 'УПД-1',
      items: [],
      supplierName: null,
      siteId: SITE,
    };
  }
  return { items: [], total: 0 };
}

function renderAt(url: string) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[url]}>
        <ShipmentPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const saveButton = async () =>
  (await screen.findByRole('button', { name: /Сохранить/ })) as HTMLButtonElement;

beforeEach(async () => {
  mocks.apiGet.mockImplementation(async (url: string) => route(url));
  mocks.enqueueMutation.mockResolvedValue(undefined);
  const dbi = await db();
  await dbi.clear('shipments');
  await dbi.clear('photos');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ручной вынос: что требует «Сохранить»', () => {
  it('без госномера и без получателя (документов нет) — кнопка активна', async () => {
    current = shipment({ isManual: true });
    renderAt(`/operations?type=shipment&shipment=${ID}`);

    await screen.findByText('Ручной вынос');
    await waitFor(async () => expect((await saveButton()).disabled).toBe(false), { timeout: 4000 });
    expect(screen.queryByText(/Заполните госномер/)).toBeNull();
    expect(screen.queryByText(/Выберите получателя/)).toBeNull();
  });

  it('после привязки УПД получатель снова обязателен (иначе сервер даст 422)', async () => {
    current = shipment({
      isManual: true,
      sourceDocumentIds: [DOC],
      items: [
        {
          id: 'i-1',
          sourceDocumentId: DOC,
          sourceDocumentItemId: null,
          itemKind: 'material',
          materialId: null,
          assetId: null,
          inventoryNumber: null,
          serialNumber: null,
          nameRaw: 'Кабель',
          qtyPlanned: '1',
          qtyActual: '1',
          unit: 'шт',
          comment: null,
          lineNo: 1,
          volumeM3: null,
          massKg: null,
          price: null,
          vatRate: null,
          vatSum: null,
          volumeConfidence: null,
          groupName: null,
        },
      ] as unknown as Shipment['items'],
    });
    renderAt(`/operations?type=shipment&shipment=${ID}`);

    expect(await screen.findByText(/Выберите получателя/, {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByText(/Заполните госномер/)).toBeNull();
    expect((await saveButton()).disabled).toBe(true);
  });

  it('отгрузка с машиной без номера — по-прежнему «Заполните госномер»', async () => {
    current = shipment({ isManual: false, comment: null });
    renderAt(`/operations?type=shipment&shipment=${ID}`);

    expect(await screen.findByText(/Заполните госномер/, {}, { timeout: 4000 })).toBeTruthy();
    expect((await saveButton()).disabled).toBe(true);
  });
});

describe('новый ручной вынос с портала', () => {
  it('два «Сохранить» офлайн: в очередь уходит время первого, сразу «Подтверждено МОЛ»', async () => {
    const dbi = await db();
    await dbi.put('photos', {
      id: 'local-photo',
      deliveryId: ID,
      operationKind: 'shipment',
      origin: 'local',
      kind: 'cargo',
      stage: 'before',
      contentHash: 'b'.repeat(64),
      idempotencyKey: 'idem',
      blob: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }),
      takenAt: Date.now(),
      uploaded: false,
    });
    mocks.flushMutation.mockResolvedValue({ outcome: 'queued' });
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = new Date('2026-11-17T18:30:00.000Z');
    vi.setSystemTime(first);

    renderAt(`/operations?type=shipment&shipment=${ID}&new=1&manual=1`);

    expect(await screen.findByText('Ручной вынос')).toBeTruthy();
    expect(screen.queryByText('Госномер')).toBeNull();
    expect(screen.queryByRole('button', { name: /Подтвердить МОЛ/ })).toBeNull();

    await waitFor(async () => expect((await saveButton()).disabled).toBe(false), { timeout: 4000 });
    await act(async () => fireEvent.click(await saveButton()));
    await waitFor(() => expect(mocks.flushMutation).toHaveBeenCalledTimes(1));

    vi.setSystemTime(new Date(first.getTime() + 60_000));
    await waitFor(async () => expect((await saveButton()).disabled).toBe(false));
    await act(async () => fireEvent.click(await saveButton()));
    await waitFor(() => expect(mocks.flushMutation).toHaveBeenCalledTimes(2));

    const rec = await dbi.get('shipments', ID);
    expect(rec?.server).toBeNull();
    expect(buildUpsertPayload(rec!, 0)).toMatchObject({
      statusCode: 'confirmed_mol',
      kind: 'contractor',
      isManual: true,
      vehiclePlate: null,
      shippedAt: first.toISOString(),
      confirmedByMolAt: first.toISOString(),
    });
  });
});
