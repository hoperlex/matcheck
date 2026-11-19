// @vitest-environment jsdom
/**
 * Получатель отгрузки сохраняется сразу (PATCH /shipments/:id/recipient) —
 * зеркало KppPage.recipient.test.tsx. Только вид «подрядчику»: у перемещения
 * получатель уходит ещё и в парную приёмку, поэтому там и у возврата — прежний
 * режим «до Сохранить», как у роли без возможности.
 */
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Shipment } from '@matcheck/contracts';
import type * as ApiModuleNs from '../../services/api';
import type * as ShipmentsModuleNs from '../../services/shipments';
import type * as MutationQueueNs from '../../services/mutationQueue';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  enqueueMutation: vi.fn(),
  flushMutation: vi.fn(),
  deniedCapabilities: new Set<string>(),
}));

vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof ApiModuleNs>('../../services/api');
  return {
    ...actual,
    api: { get: mocks.apiGet, post: mocks.apiPost, patch: mocks.apiPatch, delete: vi.fn() },
    apiDownload: vi.fn(),
  };
});
vi.mock('../../services/shipments', async () => {
  const actual = await vi.importActual<typeof ShipmentsModuleNs>('../../services/shipments');
  // applyLocalEdit — настоящий: тело upsert проверяем по содержимому IDB.
  return { ...actual, enqueueMutation: mocks.enqueueMutation };
});
vi.mock('../../services/mutationQueue', async () => {
  const actual = await vi.importActual<typeof MutationQueueNs>('../../services/mutationQueue');
  return { ...actual, flushMutation: mocks.flushMutation };
});
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
    hasCapability: (capability: string) => !mocks.deniedCapabilities.has(capability),
    enforced: true,
    loading: false,
  }),
}));
const SITE = '55555555-5555-4555-8555-555555555555';
const OTHER_SITE = '44444444-4444-4444-8444-444444444444';
const authUser = { id: 'u-1', email: 'manager@test.com', role: 'manager', siteId: null };
vi.mock('../../stores/auth', () => ({
  useAuthStore: Object.assign((selector: (s: unknown) => unknown) => selector({ user: authUser }), {
    getState: () => ({ user: authUser, accessToken: 'token' }),
    subscribe: () => () => {},
  }),
}));

const { default: ShipmentPage } = await import('./ShipmentPage');
const { buildUpsertPayload, getShipment } = await import('../../services/shipments');
const { db } = await import('../../lib/db');

const ID = '11111111-1111-4111-8111-111111111111';
const MOL = '99999999-9999-4999-8999-999999999999';

function shipment(over: Partial<Shipment> & { tick?: number } = {}): Shipment {
  const { tick = 1, ...rest } = over;
  return {
    id: ID,
    displayId: 1972,
    status: {
      id: 's',
      entityType: 'shipment',
      code: 'shipped',
      label: 'Отгружена',
      color: 'blue',
      sortOrder: 30,
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
    vehiclePlate: 'А243МХ550',
    driverName: null,
    shippedAt: '2026-11-18T09:00:00.000Z',
    inspectorId: null,
    comment: null,
    confirmedByMolUserId: null,
    confirmedByMolUserEmail: null,
    confirmedByMolAt: null,
    reviewState: null,
    reviewNote: null,
    reviewedByUserId: null,
    reviewedByUserEmail: null,
    reviewedAt: null,
    pendingDeletionAt: null,
    pendingDeletionByUserId: null,
    pendingDeletionByUserEmail: null,
    pendingDeletionReason: null,
    version: 2,
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
        takenAt: '2026-11-18T09:00:00.000Z',
        uploadedAt: '2026-11-18T09:00:00.000Z',
      },
    ],
    sourceDocuments: [],
    createdAt: '2026-11-18T09:00:00.000Z',
    updatedAt: `2026-11-18T09:00:0${tick}.000Z`,
    ...rest,
  } as unknown as Shipment;
}

let current: Shipment;

function route(url: string): unknown {
  if (url === `/shipments/${ID}`) return current;
  if (url.startsWith('/responsible-persons')) {
    return { items: [{ id: MOL, fullName: 'Иванов Иван Иванович', isActive: true }], total: 1 };
  }
  if (url.startsWith('/sites')) {
    return {
      items: [
        { id: SITE, code: 'ОБ1', name: 'Объект' },
        { id: OTHER_SITE, code: 'ОБ2', name: 'Другой объект' },
      ],
      total: 2,
    };
  }
  return { items: [], total: 0 };
}

function renderCard() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[`/operations?type=shipment&shipment=${ID}`]}>
        <ShipmentPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const saveButton = () => screen.getByRole('button', { name: /Сохранить/ }) as HTMLButtonElement;
/** «Сохранить» доступна — у вида «подрядчику» это значит, что получатель уже есть. */
async function ready(): Promise<void> {
  await waitFor(() => expect(saveButton().disabled).toBe(false), { timeout: 4000 });
}
/** Карточка загружена. Без получателя «Сохранить» ждёт выбора (verifyReason). */
async function loaded(): Promise<void> {
  await waitFor(() => expect(screen.getByText(/Выберите получателя/)).toBeTruthy(), {
    timeout: 4000,
  });
}
async function pickMol(): Promise<void> {
  // Собственные текстовые узлы метки — «Получатель» и «:»; звёздочка
  // обязательного поля — во вложенном узле.
  fireEvent.click(await screen.findByText('Получатель:'));
  const popover = (await screen.findByText('МОЛ')).closest('.ant-popover') as HTMLElement;
  fireEvent.click(within(popover).getByText('МОЛ'));
  const box = await within(popover).findByRole('combobox');
  fireEvent.mouseDown(box);
  fireEvent.click(await screen.findByTitle('Иванов Иван Иванович'));
}

beforeEach(async () => {
  current = shipment();
  mocks.apiGet.mockImplementation(async (url: string) => route(url));
  mocks.enqueueMutation.mockResolvedValue(undefined);
  mocks.flushMutation.mockResolvedValue({ outcome: 'queued' });
  const dbi = await db();
  await dbi.clear('shipments');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.deniedCapabilities.clear();
});

describe('получатель отгрузки — сразу', () => {
  it('выбор МОЛ уходит PATCH-ем; «Сохранить» потом идёт с keepReceiver без получателя', async () => {
    mocks.apiPatch.mockImplementation(async () => {
      current = shipment({ receiverMolId: MOL, tick: 2 });
      return current;
    });
    renderCard();
    await loaded();
    await pickMol();
    await waitFor(() =>
      expect(mocks.apiPatch).toHaveBeenCalledWith(`/shipments/${ID}/recipient`, {
        recipientMolId: MOL,
      }),
    );
    expect(await screen.findByText('МОЛ: Иванов Иван Иванович')).toBeTruthy();

    await ready();
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.enqueueMutation).toHaveBeenCalled());
    const record = (await getShipment(ID))!;
    expect(record.local).not.toHaveProperty('receiverCounterpartyId');
    expect(record.local).not.toHaveProperty('receiverMolId');
    expect(buildUpsertPayload(record, 2)).toMatchObject({ keepReceiver: true, receiverMolId: MOL });
  });

  it('пока PATCH идёт, «Сохранить» заблокирована', async () => {
    let resolve!: (s: Shipment) => void;
    mocks.apiPatch.mockImplementation(
      () =>
        new Promise<Shipment>((r) => {
          resolve = r;
        }),
    );
    renderCard();
    await loaded();
    await pickMol();
    await waitFor(() => expect(mocks.apiPatch).toHaveBeenCalledTimes(1));
    expect(saveButton().disabled).toBe(true);
    current = shipment({ receiverMolId: MOL, tick: 2 });
    resolve(current);
    await ready();
  });

  it('без возможности — прежний режим: PATCH не уходит, получатель в правке', async () => {
    mocks.deniedCapabilities.add('operations.edit.recipient');
    renderCard();
    await loaded();
    await pickMol();
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.enqueueMutation).toHaveBeenCalled());
    expect(mocks.apiPatch).not.toHaveBeenCalled();
    const record = (await getShipment(ID))!;
    expect(record.local).toMatchObject({ receiverMolId: MOL, receiverCounterpartyId: null });
    expect(buildUpsertPayload(record, 2).keepReceiver).toBeUndefined();
  });

  it('перемещение — прежний режим: получатель уходит в парную приёмку, PATCH не нужен', async () => {
    current = shipment({ kind: 'transfer', destSiteId: OTHER_SITE });
    renderCard();
    await loaded();
    await pickMol();
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.enqueueMutation).toHaveBeenCalled());
    expect(mocks.apiPatch).not.toHaveBeenCalled();
    expect((await getShipment(ID))!.local).toMatchObject({ receiverMolId: MOL });
  });
});
