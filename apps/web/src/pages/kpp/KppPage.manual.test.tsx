// @vitest-environment jsdom
/**
 * «Ручной внос» в карточке приёмки (жалоба 16.11, приёмка 25454).
 *
 *  - У ручного вноса машины нет: «Сохранить» не требует госномера. У приёмки
 *    с машиной без номера кнопка по-прежнему серая.
 *  - Новый ручной внос с портала — один этап: «Сохранить» создаёт его сразу
 *    «Подтверждено МОЛ». Время прихода и подтверждения — момент ПЕРВОГО
 *    сохранения: повторное «Сохранить» офлайн его не сдвигает (иначе
 *    утренняя отправка вечерней записи разнесла бы приход и подтверждение).
 *
 * Локальная база настоящая (fake-indexeddb): время проверяется по тому, что
 * реально уйдёт в очередь, — через buildUpsertPayload по записи из IndexedDB.
 */
import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Delivery } from '@matcheck/contracts';
import type * as ApiModuleNs from '../../services/api';
import type * as DeliveriesModuleNs from '../../services/deliveries';

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
vi.mock('../../services/deliveries', async () => {
  const actual = await vi.importActual<typeof DeliveriesModuleNs>('../../services/deliveries');
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

const { default: KppPage } = await import('./KppPage');
const { getDelivery, buildUpsertPayload } = await import('../../services/deliveries');
const { db } = await import('../../lib/db');

const ID = '11111111-1111-4111-8111-111111111111';

function delivery(over: Partial<Delivery>): Delivery {
  return {
    id: ID,
    displayId: 25454,
    status: {
      id: 's',
      entityType: 'delivery',
      code: 'confirmed_mol',
      label: 'Подтверждено МОЛ',
      color: 'green',
      sortOrder: 40,
    },
    siteId: SITE,
    supplierId: null,
    contractorId: null,
    recipientMolId: null,
    siteName: 'Объект',
    supplierName: null,
    contractorName: null,
    vehiclePlate: null,
    driverName: null,
    arrivedAt: '2026-11-16T11:44:00.000Z',
    inspectorId: null,
    comment: null,
    inTransit: false,
    isAssets: false,
    purpose: null,
    confirmedByMolUserId: null,
    confirmedByMolUserEmail: null,
    confirmedByMolAt: '2026-11-16T11:44:00.000Z',
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
    sourceShipmentId: null,
    sourceShipmentShippedAt: null,
    sourceShipmentSiteId: null,
    sourceShipmentSiteCode: null,
    items: [],
    photos: [
      {
        id: '66666666-6666-4666-8666-666666666666',
        kind: 'cargo',
        stage: 'before',
        s3Key: 'k',
        thumbS3Key: null,
        contentHash: null,
        takenAt: '2026-11-16T11:44:00.000Z',
        uploadedAt: '2026-11-16T11:44:00.000Z',
      },
    ],
    sourceDocuments: [],
    docAttention: false,
    createdAt: '2026-11-16T11:44:00.000Z',
    updatedAt: '2026-11-16T11:44:00.000Z',
    ...over,
  } as unknown as Delivery;
}

let current: Delivery;

function route(url: string): unknown {
  if (url === `/deliveries/${ID}`) return current;
  if (url.endsWith('/contract')) {
    return {
      contract: null,
      perDocument: false,
      documents: [],
      catalog: { total: 0, importedAt: null },
    };
  }
  if (url.includes('supplier-orders')) return { items: [], sync: { enabled: false } };
  return { items: [], total: 0 };
}

function renderAt(url: string) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[url]}>
        <KppPage />
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
  await dbi.clear('deliveries');
  await dbi.clear('photos');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('госномер и ручной внос', () => {
  it('ручной внос без госномера сохраняется: кнопка активна, тег «Ручной внос»', async () => {
    current = delivery({ isManual: true, comment: 'Ручной внос' });
    renderAt(`/operations?type=delivery&delivery=${ID}`);

    await screen.findByText('Ручной внос');
    await waitFor(async () => expect((await saveButton()).disabled).toBe(false), { timeout: 4000 });
    expect(screen.queryByText(/Заполните госномер/)).toBeNull();
  });

  it('приёмка с машиной без госномера — по-прежнему «Заполните госномер»', async () => {
    current = delivery({ isManual: false });
    renderAt(`/operations?type=delivery&delivery=${ID}`);

    expect(await screen.findByText(/Заполните госномер/, {}, { timeout: 4000 })).toBeTruthy();
    expect((await saveButton()).disabled).toBe(true);
  });
});

describe('новый ручной внос с портала', () => {
  it('два «Сохранить» офлайн: в очередь уходит время первого, сразу «Подтверждено МОЛ»', async () => {
    // Фото, снятое до первого сохранения (без него «Сохранить» недоступно).
    const dbi = await db();
    await dbi.put('photos', {
      id: 'local-photo',
      deliveryId: ID,
      operationKind: 'delivery',
      origin: 'local',
      kind: 'cargo',
      stage: 'before',
      contentHash: 'a'.repeat(64),
      idempotencyKey: 'idem',
      blob: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }),
      takenAt: Date.now(),
      uploaded: false,
    });
    mocks.flushMutation.mockResolvedValue({ outcome: 'queued' });
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = new Date('2026-11-17T18:30:00.000Z');
    vi.setSystemTime(first);

    renderAt(`/operations?type=delivery&delivery=${ID}&new=1&manual=1`);

    // Одноэтапная форма: ни госномера, ни «Подтвердить МОЛ».
    expect(await screen.findByText('Ручной внос')).toBeTruthy();
    expect(screen.queryByText('Госномер')).toBeNull();
    expect(screen.queryByRole('button', { name: /Подтвердить МОЛ/ })).toBeNull();

    await waitFor(async () => expect((await saveButton()).disabled).toBe(false), { timeout: 4000 });
    await act(async () => fireEvent.click(await saveButton()));
    await waitFor(() => expect(mocks.flushMutation).toHaveBeenCalledTimes(1));

    // Вторая попытка через минуту — офлайн человек жмёт ещё раз.
    vi.setSystemTime(new Date(first.getTime() + 60_000));
    await waitFor(async () => expect((await saveButton()).disabled).toBe(false));
    await act(async () => fireEvent.click(await saveButton()));
    await waitFor(() => expect(mocks.flushMutation).toHaveBeenCalledTimes(2));

    const rec = await getDelivery(ID);
    expect(rec?.server).toBeNull();
    const payload = buildUpsertPayload(rec!, 0);
    expect(payload).toMatchObject({
      statusCode: 'confirmed_mol',
      isManual: true,
      vehiclePlate: null,
      arrivedAt: first.toISOString(),
      confirmedByMolAt: first.toISOString(),
    });
  });
});
