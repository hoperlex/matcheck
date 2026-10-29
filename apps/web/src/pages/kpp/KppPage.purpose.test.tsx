// @vitest-environment jsdom
/**
 * Признак приёмки в карточке зависит от получателя.
 *
 * У подрядчика «Свои силы» не бывает — пункта нет в меню. Сервер сверяет
 * признак с СОХРАНЁННЫМ получателем, поэтому, пока новый получатель в форме не
 * сохранён, выбор закрыт, а кнопка показывает, каким признак станет после
 * «Сохранить» (МОЛ подставляет «Свои силы»).
 */
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Delivery } from '@matcheck/contracts';
import type * as ApiModuleNs from '../../services/api';
import { api } from '../../services/api';
import type * as DeliveriesModuleNs from '../../services/deliveries';

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
vi.mock('../../services/deliveries', async () => {
  const actual = await vi.importActual<typeof DeliveriesModuleNs>('../../services/deliveries');
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

const { default: KppPage } = await import('./KppPage');

const ID = '11111111-1111-4111-8111-111111111111';
const FIRST = '22222222-2222-4222-8222-222222222222';
const SECOND = '33333333-3333-4333-8333-333333333333';
const SITE = '55555555-5555-4555-8555-555555555555';

type Item = Delivery['items'][number];

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

function delivery(
  version: number,
  items: Item[],
  docs = [sourceDoc(FIRST, 'УПД-1'), sourceDoc(SECOND, 'УПД-2')],
): Delivery {
  return {
    id: ID,
    displayId: 22293,
    status: {
      id: 's',
      entityType: 'delivery',
      code: 'filled',
      label: 'Оформлена',
      color: 'green',
      sortOrder: 30,
    },
    siteId: SITE,
    supplierId: null,
    contractorId: null,
    recipientMolId: null,
    siteName: 'Объект',
    supplierName: null,
    contractorName: null,
    // Госномер и фото — условия кнопки «Сохранить» (verifyReason).
    vehiclePlate: 'А123ВС77',
    driverName: null,
    arrivedAt: null,
    inspectorId: null,
    comment: null,
    inTransit: false,
    isAssets: false,
    purpose: null,
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
    sourceShipmentId: null,
    sourceShipmentShippedAt: null,
    sourceShipmentSiteId: null,
    sourceShipmentSiteCode: null,
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
    docAttention: false,
    createdAt: '2026-10-28T10:00:00.000Z',
    updatedAt: `2026-10-28T10:00:0${version}.000Z`,
  } as unknown as Delivery;
}

const CONTRACTOR = '88888888-8888-4888-8888-888888888888';
const MOL = '99999999-9999-4999-8999-999999999999';

let current: Delivery;

function route(url: string): unknown {
  if (url === `/deliveries/${ID}`) return current;
  if (url.startsWith('/responsible-persons')) {
    return { items: [{ id: MOL, fullName: 'Иванов Иван Иванович', isActive: true }], total: 1 };
  }
  if (url.startsWith('/source-documents/')) {
    const id = url.split('/')[2]!.split('?')[0]!;
    return { id, kind: 'upd', docNumber: 'УПД', items: [], supplierName: null, siteId: SITE };
  }
  if (url.includes('supplier-orders')) return { items: [], sync: { enabled: false } };
  return { items: [], total: 0 };
}

function renderCard() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[`/operations?type=delivery&delivery=${ID}`]}>
        <KppPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const purposeButton = () => screen.findByRole('button', { name: /Признак:/ });

/** Кнопка после того, как форма подхватила получателя с сервера. */
async function readyPurposeButton(): Promise<HTMLButtonElement> {
  let btn: HTMLButtonElement | undefined;
  // Получатель приходит в форму эффектом после первой отрисовки, а карточка
  // читает локальную базу — дольше, чем ждёт waitFor по умолчанию.
  await waitFor(
    async () => {
      btn = (await purposeButton()) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    },
    { timeout: 4000 },
  );
  return btn!;
}

beforeEach(() => {
  mocks.apiGet.mockImplementation(async (url: string) => route(url));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  authUser.role = 'monitor';
});

describe('режим получателей по УПД', () => {
  it('менеджер включает его при двух связанных документах', async () => {
    authUser.role = 'manager';
    current = delivery(3, []);
    vi.mocked(api.patch).mockResolvedValue({ ...current, recipientsPerDocument: true });
    renderCard();
    const label = await screen.findByText('Разные получатели по документам');
    const control = label.parentElement?.querySelector('[role="switch"]');
    expect(control).toBeTruthy();
    fireEvent.click(control!);
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(`/deliveries/${ID}/recipient-mode`, {
        perDocument: true,
      }),
    );
  });
});

describe('карточка приёмки: признак зависит от получателя', () => {
  it('у подрядчика нет «Свои силы», пятый пункт есть', async () => {
    current = {
      ...delivery(3, []),
      contractorId: CONTRACTOR,
      contractorName: 'ООО «Альфа»',
    } as Delivery;
    renderCard();
    fireEvent.click(await readyPurposeButton());
    const items = (await screen.findAllByRole('menuitem')).map((n) => n.textContent);
    expect(items).toEqual([
      '2 Реализация',
      '3 Давальческий акт',
      '4 Материалы подрядчика',
      '5 Реализация + давальческий',
    ]);
  });

  it('без получателя доступны все пять пунктов', async () => {
    current = delivery(3, []);
    renderCard();
    fireEvent.click(await readyPurposeButton());
    const items = (await screen.findAllByRole('menuitem')).map((n) => n.textContent);
    expect(items[0]).toBe('1 Свои силы');
    expect(items).toHaveLength(5);
  });

  it('МОЛ выбран, но не сохранён — кнопка закрыта и показывает «Свои силы»', async () => {
    current = { ...delivery(3, []), purpose: 'realization' } as Delivery;
    renderCard();
    expect((await readyPurposeButton()).textContent).toContain('Реализация');

    fireEvent.click(await screen.findByText('Получатель:'));
    const popover = (await screen.findByText('МОЛ')).closest('.ant-popover') as HTMLElement;
    fireEvent.click(within(popover).getByText('МОЛ'));
    const box = await within(popover).findByRole('combobox');
    fireEvent.mouseDown(box);
    fireEvent.click(await screen.findByTitle('Иванов Иван Иванович'));

    await waitFor(async () => {
      const btn = (await purposeButton()) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.textContent).toContain('Свои силы');
    });
  });
});
