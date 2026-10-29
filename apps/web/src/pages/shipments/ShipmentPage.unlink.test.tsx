// @vitest-environment jsdom
/**
 * Зеркало KppPage.unlink.test.tsx для карточки отгрузки: отвязка УПД с
 * удалением строк, «Сохранить», версия строк формы, привязка с ответом +1/+2.
 *
 * Тесты API и отдельных компонентов не доказывают главного: что после отвязки
 * форма карточки больше не держит удалённые строки и не отправит их следующим
 * сохранением (upsert переписывает позиции целиком — строка из старой формы
 * вернулась бы «без привязки»). И что сохранение уходит с версией строк формы,
 * а не с версией последнего поллинга: с ней устаревшая форма проходила
 * проверку на сервере.
 *
 * Шов проверки — аргументы `applyLocalEdit` (ровно этот патч уходит в upsert)
 * и `enqueueMutation` (версия). Локальная база настоящая (fake-indexeddb).
 */
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { message } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Shipment } from '@matcheck/contracts';
import type * as ApiModuleNs from '../../services/api';
import type * as ShipmentsModuleNs from '../../services/shipments';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  applyLocalEdit: vi.fn(),
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
  return {
    ...actual,
    applyLocalEdit: mocks.applyLocalEdit,
    enqueueMutation: mocks.enqueueMutation,
  };
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
const authUser = { id: 'u-1', email: 'monitor@test.com', role: 'monitor', siteId: null };
vi.mock('../../stores/auth', () => ({
  useAuthStore: Object.assign((selector: (s: unknown) => unknown) => selector({ user: authUser }), {
    getState: () => ({ user: authUser, accessToken: 'token' }),
  }),
}));

const { default: ShipmentPage } = await import('./ShipmentPage');
const { ConflictError } = await import('../../services/api');

const ID = '11111111-1111-4111-8111-111111111111';
const FIRST = '22222222-2222-4222-8222-222222222222';
const SECOND = '33333333-3333-4333-8333-333333333333';
const OLD = '44444444-4444-4444-8444-444444444444';
const SITE = '55555555-5555-4555-8555-555555555555';

type Item = Shipment['items'][number];
const item = (id: string, sourceDocumentId: string | null, nameRaw: string, qty: string): Item =>
  ({
    id,
    sourceDocumentId,
    sourceDocumentItemId: null,
    itemKind: 'material',
    materialId: null,
    assetId: null,
    inventoryNumber: null,
    serialNumber: null,
    nameRaw,
    qtyPlanned: null,
    qtyActual: qty,
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
  }) as Item;

const sourceDoc = (id: string, docNumber: string, linked = true) => ({
  id,
  kind: 'upd' as const,
  status: 'parsed' as const,
  docNumber,
  docDate: '2026-10-28',
  expectedDate: null,
  totalSum: '100.00',
  vatSum: null,
  linked,
});

function shipment(
  version: number,
  items: Item[],
  docs = [sourceDoc(FIRST, 'УПД-1'), sourceDoc(SECOND, 'УПД-2')],
): Shipment {
  return {
    id: ID,
    displayId: 1972,
    status: {
      id: 's',
      entityType: 'shipment',
      code: 'shipped',
      label: 'Оформлена',
      color: 'green',
      sortOrder: 30,
    },
    // Списание: получатель не нужен, и verifyReason не держит кнопку «Сохранить».
    kind: 'writeoff',
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
    // Госномер и фото — условия кнопки «Сохранить» (verifyReason).
    vehiclePlate: 'А123ВС77',
    driverName: null,
    shippedAt: '2026-10-28T10:00:00.000Z',
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
    version,
    sourceDocumentIds: docs.filter((d) => d.linked).map((d) => d.id),
    items,
    photos: [
      {
        id: '66666666-6666-4666-8666-666666666666',
        kind: 'cargo',
        stage: 'before',
        s3Key: 'k',
        thumbS3Key: null,
        contentHash: null,
        takenAt: '2026-10-28T10:00:00.000Z',
        uploadedAt: '2026-10-28T10:00:00.000Z',
      },
    ],
    itemCount: items.length,
    photoCount: 1,
    itemsTotal: null,
    itemsVatSum: null,
    primarySourceDocument: null,
    sourceDocuments: docs,
    createdAt: '2026-10-28T10:00:00.000Z',
    updatedAt: `2026-10-28T10:00:0${version}.000Z`,
  } as unknown as Shipment;
}

const firstRows = [
  item('i-1', FIRST, 'Дюбель 150', '25'),
  item('i-2', FIRST, 'Крышка лотка', '102'),
];
const secondRow = item('i-3', SECOND, 'Кабельный лоток', '10');

let current: Shipment;

const THIRD = '77777777-7777-4777-8777-777777777777';

function route(url: string): unknown {
  if (url === `/shipments/${ID}`) return current;
  if (url.startsWith('/source-documents?')) {
    // Окно «Привязать УПД»: одна свободная УПД того же объекта.
    return {
      items: [
        {
          id: THIRD,
          kind: 'upd',
          direction: 'outbound',
          status: 'parsed',
          origin: 'manual_pdf',
          docNumber: 'УПД-3',
          docDate: '2026-10-28',
          siteId: SITE,
          supplierName: null,
          totalSum: '100.00',
          createdAt: '2026-10-28T10:00:00.000Z',
        },
      ],
      total: 1,
    };
  }
  if (url.startsWith('/source-documents/')) {
    const id = url.split('/')[2]!.split('?')[0]!;
    return { id, kind: 'upd', docNumber: 'УПД', items: [], supplierName: null, siteId: SITE };
  }
  return { items: [], total: 0 };
}

function renderCard(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/operations?type=shipment&shipment=${ID}`]}>
        <ShipmentPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

/** Раскрывает блок материалов документа и меняет «Факт» строки с указанным значением. */
async function editFact(blockTitle: RegExp, from: string, to: string) {
  fireEvent.click(await screen.findByText(blockTitle));
  const input = await screen.findByDisplayValue(from);
  fireEvent.change(input, { target: { value: to } });
}

async function unlinkFirst(keepItems = false) {
  fireEvent.click(await screen.findByText('УПД-1, УПД-2'));
  const row = (await screen.findByText('УПД УПД-1')).closest('.ant-space') as HTMLElement;
  fireEvent.click(within(row).getByText('Отвязать'));
  if (keepItems) {
    fireEvent.click(
      await screen.findByRole('checkbox', { name: /Удалить все строки его блока \(2\)/ }),
    );
  }
  const ok = (await screen.findAllByText('Отвязать')).slice(-1)[0]!;
  fireEvent.click(ok);
}

const lastPatchItems = () =>
  (
    mocks.applyLocalEdit.mock.calls.at(-1)![1] as {
      items: { nameRaw: string; qtyActual: string | null }[];
    }
  ).items;
const lastBaseVersion = () =>
  (mocks.enqueueMutation.mock.calls.at(-1)![0] as { baseVersion: number }).baseVersion;

beforeEach(() => {
  vi.clearAllMocks();
  current = shipment(4, [...firstRows, secondRow]);
  mocks.apiGet.mockImplementation(async (url: string) => route(url));
  mocks.applyLocalEdit.mockResolvedValue(undefined);
  mocks.enqueueMutation.mockResolvedValue(undefined);
  mocks.flushMutation.mockResolvedValue({ outcome: 'server_acked' });
});

afterEach(() => {
  cleanup();
  // Тосты antd живут вне контейнера теста: без этого «УПД привязана» прошлого
  // сценария находилась сразу, и следующий шаг шёл раньше ответа сервера.
  message.destroy();
});

describe('карточка отгрузки: отвязка с удалением и сохранение', () => {
  it('удалённые строки не уходят в «Сохранить», правка соседней строки цела, версия — ответа отвязки', async () => {
    renderCard();
    await editFact(/УПД № УПД-2/, '10', '9');
    mocks.apiPost.mockImplementation(async () => {
      current = shipment(5, [secondRow], [sourceDoc(SECOND, 'УПД-2')]);
      return current;
    });

    await unlinkFirst();

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalled());
    expect(mocks.apiPost).toHaveBeenCalledWith(`/shipments/${ID}/unlink-source`, {
      sourceDocumentId: FIRST,
      deleteItems: true,
      baseVersion: 4,
    });
    await screen.findByText('Документ отвязан, его материалы удалены');

    fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }));
    await waitFor(() => expect(mocks.applyLocalEdit).toHaveBeenCalled());

    const items = lastPatchItems();
    expect(items.map((i) => i.nameRaw)).toEqual(['Кабельный лоток']);
    expect(Number(items[0]!.qtyActual)).toBe(9);
    expect(lastBaseVersion()).toBe(5);
  });

  it('без галочки строки остаются в форме и отвязка уходит без удаления', async () => {
    renderCard();
    mocks.apiPost.mockImplementation(async () => {
      current = shipment(
        5,
        [...firstRows, secondRow],
        [sourceDoc(SECOND, 'УПД-2'), sourceDoc(FIRST, 'УПД-1', false)],
      );
      return current;
    });

    await unlinkFirst(true);

    await waitFor(() =>
      expect(mocks.apiPost).toHaveBeenCalledWith(`/shipments/${ID}/unlink-source`, {
        sourceDocumentId: FIRST,
      }),
    );
    await screen.findByText('Документ отвязан');
    fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }));
    await waitFor(() => expect(mocks.applyLocalEdit).toHaveBeenCalled());
    expect(lastPatchItems()).toHaveLength(3);
  });

  it('вторая вкладка: поллинг принёс новую версию, а строки формы прежние — сохранение уходит со старой', async () => {
    const client = renderCard();
    await screen.findByText('УПД-1, УПД-2');
    // В другой вкладке первую УПД отвязали с удалением: сервер на версии 5.
    current = shipment(5, [secondRow], [sourceDoc(SECOND, 'УПД-2')]);
    const calls = mocks.apiGet.mock.calls.length;
    await client.invalidateQueries({ queryKey: ['shipments', ID] });
    await waitFor(() => expect(mocks.apiGet.mock.calls.length).toBeGreaterThan(calls));

    fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }));
    await waitFor(() => expect(mocks.enqueueMutation).toHaveBeenCalled());

    // Форма всё ещё помнит строки первой УПД — сервер обязан ответить 409, а
    // для этого в запросе должна быть версия формы, а не поллинга.
    expect(lastPatchItems()).toHaveLength(3);
    expect(lastBaseVersion()).toBe(4);
  });

  describe('привязка УПД сдвигает версию формы только при ответе «версия + 1»', () => {
    const thirdRow = item('i-7', THIRD, 'Сепаратор', '102');
    // Строка, которую между снимком формы и привязкой сохранил кто-то другой.
    const foreignRow = item('i-8', SECOND, 'Чужая строка планшета', '1');

    async function linkThird(version: number) {
      mocks.apiPost.mockImplementation(async () => {
        current = shipment(
          version,
          [...firstRows, secondRow, foreignRow, thirdRow],
          [sourceDoc(FIRST, 'УПД-1'), sourceDoc(SECOND, 'УПД-2'), sourceDoc(THIRD, 'УПД-3')],
        );
        return current;
      });
      fireEvent.click(await screen.findByRole('button', { name: /Документ/ }));
      fireEvent.click(await screen.findByText('УПД-3'));
      // Окно закрывает onSuccess привязки — после него версия уже решена.
      await waitFor(() => expect(screen.queryByText('Привязать УПД')).toBeNull());
      fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }));
      await waitFor(() => expect(mocks.applyLocalEdit).toHaveBeenCalled());
    }

    it('между снимком и привязкой кто-то сохранил (+2) — версия прежняя, чужие строки не влиты', async () => {
      renderCard();
      await screen.findByText('УПД-1, УПД-2');

      await linkThird(6);

      expect(lastPatchItems().map((i) => i.nameRaw)).toEqual([
        'Дюбель 150',
        'Крышка лотка',
        'Кабельный лоток',
        'Сепаратор',
      ]);
      // Со старой версией сервер ответит 409 и не даст затереть чужую строку.
      expect(lastBaseVersion()).toBe(4);
    });

    it('ответ «версия + 1» — форма совпадает с сервером, сохранение идёт с новой версией', async () => {
      renderCard();
      await screen.findByText('УПД-1, УПД-2');

      await linkThird(5);

      expect(lastBaseVersion()).toBe(5);
    });
  });

  it('устаревшая форма: отвязка с удалением получает 409, форма не тронута', async () => {
    renderCard();
    mocks.apiPost.mockRejectedValue(new ConflictError(0, undefined));

    await unlinkFirst();

    await screen.findByText('Отгрузку изменили на другом устройстве. Откройте карточку заново');
    fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }));
    await waitFor(() => expect(mocks.applyLocalEdit).toHaveBeenCalled());
    expect(lastPatchItems()).toHaveLength(3);
    expect(lastBaseVersion()).toBe(4);
  });

  it('«Удалить материалы» в блоке отвязанного документа, затем «Сохранить» — строк блока в патче нет', async () => {
    current = shipment(
      4,
      [item('i-9', OLD, 'Старая строка', '5'), secondRow],
      [sourceDoc(SECOND, 'УПД-2'), sourceDoc(OLD, '371', false)],
    );
    renderCard();

    fireEvent.click(await screen.findByText('Удалить материалы'));
    await screen.findByText('Удалить все строки блока (1)?');
    fireEvent.click(screen.getAllByRole('button', { name: 'Удалить' }).slice(-1)[0]!);
    fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }));
    await waitFor(() => expect(mocks.applyLocalEdit).toHaveBeenCalled());

    expect(lastPatchItems().map((i) => i.nameRaw)).toEqual(['Кабельный лоток']);
    expect(lastBaseVersion()).toBe(4);
  });
});
