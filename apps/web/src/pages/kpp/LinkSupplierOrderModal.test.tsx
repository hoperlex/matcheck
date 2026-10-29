// @vitest-environment jsdom
/**
 * Окно подбора заказа EstiMat: отборы и страница уходят на сервер, смена
 * отбора сбрасывает страницу; привязка — POST; заказ другого объекта —
 * подтверждение и повтор с confirmSiteMismatch, отказ — без второго запроса.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EstimatOrderItemsResponse,
  SupplierOrderCandidate,
  SupplierOrderCandidateDetail,
  SupplierOrderCandidatesResponse,
} from '@matcheck/contracts';

class ApiErrorMock extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public payload?: unknown,
  ) {
    super(message);
  }
}

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('../../services/api', () => ({ api: { get: apiGet, post: apiPost }, ApiError: ApiErrorMock }));

const { LinkSupplierOrderModal } = await import('./LinkSupplierOrderModal');

function candidate(patch: Partial<SupplierOrderCandidate> = {}): SupplierOrderCandidate {
  return {
    id: crypto.randomUUID(),
    number: 'З-012',
    orderNo: 12,
    subNo: 0,
    sourcingStatus: 'awarded',
    approvalState: 'approved',
    projectCode: 'ЗИЛ33',
    projectName: null,
    siteId: 's1',
    siteCode: 'ЗИЛ33',
    contractors: [],
    supplierName: 'ООО Поставщик',
    supplierInn: '7800000000',
    amount: '1000.00',
    awardedAt: null,
    supplyApprovedAt: '2026-10-22T12:40:11.000Z',
    lastApprovalRevokedAt: null,
    deletedAt: null,
    lastSeenAt: '2026-10-27T10:00:00.000Z',
    estimatCreatedAt: null,
    supplierMatch: true,
    contractorMatch: null,
    siteMatch: true,
    linked: false,
    linkedDeliveriesCount: 0,
    ...patch,
  };
}

function response(items: SupplierOrderCandidate[], total = items.length): SupplierOrderCandidatesResponse {
  return {
    items,
    total,
    syncInfo: { enabled: true, reason: null, lastCompletedAt: '2026-10-27T10:00:00.000Z', lastOutcome: 'completed', lastErrorCode: null },
  };
}

const linked = { items: [], sync: { enabled: true, reason: null, lastCompletedAt: null, lastOutcome: null, lastErrorCode: null } };

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (open: boolean) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <LinkSupplierOrderModal open={open} deliveryId="d1" onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const { rerender } = render(ui(true));
  return { onClose, reopen: () => (rerender(ui(false)), rerender(ui(true))) };
}

const lastUrl = () => new URL(`http://x${apiGet.mock.calls.at(-1)![0] as string}`);

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});
afterEach(() => {
  cleanup();
  document.querySelectorAll('.ant-modal-root').forEach((n) => n.remove());
});

function detailOf(c: SupplierOrderCandidate, patch: Partial<SupplierOrderCandidateDetail> = {}): SupplierOrderCandidateDetail {
  const { supplierMatch, contractorMatch, siteMatch, linked: _l, linkedDeliveriesCount, ...summary } = c;
  void supplierMatch;
  void contractorMatch;
  void siteMatch;
  void linkedDeliveriesCount;
  return {
    ...summary,
    procurementMethod: null,
    acquisitionType: null,
    contractNumber: 'Д-7',
    contractDate: '2026-10-01',
    deliveries: [],
    ...patch,
  };
}

const ITEMS_READY: EstimatOrderItemsResponse = {
  state: 'ready',
  fetchedAt: '2026-10-29T06:00:00.000Z',
  message: null,
  items: [
    { id: 'i1', materialName: 'Бетон B25', unit: 'м3', quantity: 12.5, deliveryDate: '2026-11-01', contractorName: null },
  ],
};

/** Список, подробности и состав — по адресу: раскрытие строки шлёт свои GET. */
function routeGet(
  c: SupplierOrderCandidate,
  opts: { detail?: () => Promise<unknown>; items?: () => Promise<unknown>; total?: number } = {},
) {
  apiGet.mockImplementation(async (url: string) => {
    if (url === `/deliveries/d1/supplier-order-candidates/${c.id}/items`) {
      return (opts.items ?? (async () => ITEMS_READY))();
    }
    if (url === `/deliveries/d1/supplier-order-candidates/${c.id}`) {
      return (opts.detail ?? (async () => detailOf(c)))();
    }
    return response([c], opts.total ?? 1);
  });
}

const getUrls = () => apiGet.mock.calls.map((x) => x[0] as string);
const expandIcon = () => document.querySelector<HTMLElement>('.ant-table-row-expand-icon')!;
const isExpanded = () => expandIcon().classList.contains('ant-table-row-expand-icon-expanded');
const expandedRow = () => document.querySelector<HTMLElement>('.ant-table-expanded-row')!;

describe('LinkSupplierOrderModal', () => {
  it('отборы и страница — параметрами запроса; смена отбора сбрасывает страницу', async () => {
    apiGet.mockResolvedValue(response(Array.from({ length: 20 }, () => candidate()), 45));
    renderModal();
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    let url = lastUrl();
    expect(url.pathname).toBe('/deliveries/d1/supplier-order-candidates');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.get('offset')).toBe('0');
    expect(url.searchParams.has('allSites')).toBe(false);

    fireEvent.click(await screen.findByTitle('2'));
    await waitFor(() => expect(lastUrl().searchParams.get('offset')).toBe('20'));

    fireEvent.click(screen.getByRole('switch', { name: 'Все объекты' }));
    await waitFor(() => {
      url = lastUrl();
      expect(url.searchParams.get('allSites')).toBe('true');
      expect(url.searchParams.get('offset')).toBe('0');
    });

    fireEvent.change(screen.getByPlaceholderText(/Номер/), { target: { value: ' З-12/1 ' } });
    fireEvent.click(screen.getByRole('button', { name: /Найти/ }));
    await waitFor(() => expect(lastUrl().searchParams.get('q')).toBe('З-12/1'));
  });

  it('привязка — POST и закрытие окна', async () => {
    const c = candidate();
    apiGet.mockResolvedValue(response([c]));
    apiPost.mockResolvedValue(linked);
    const { onClose } = renderModal();
    fireEvent.click(await screen.findByRole('button', { name: 'Привязать' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/deliveries/d1/supplier-orders', { orderId: c.id }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('другой объект: подтверждение и повтор с confirmSiteMismatch', async () => {
    const c = candidate({ siteMatch: false, siteCode: 'СОБ62' });
    apiGet.mockResolvedValue(response([c]));
    apiPost
      .mockRejectedValueOnce(
        new ApiErrorMock(409, 'site_mismatch', 'Заказ для объекта СОБ62', {
          error: 'site_mismatch',
          message: 'Заказ для объекта СОБ62, приёмка — на объекте ЗИЛ33',
        }),
      )
      .mockResolvedValueOnce(linked);
    renderModal();
    fireEvent.click(await screen.findByRole('button', { name: 'Привязать' }));
    const text = await screen.findByText(/приёмка — на объекте ЗИЛ33/);
    const dialog = text.closest<HTMLElement>('.ant-modal-confirm')!;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Привязать' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
    expect(apiPost.mock.calls[1]![1]).toEqual({ orderId: c.id, confirmSiteMismatch: true });
  });

  it('другой объект: «Отмена» — второго запроса нет', async () => {
    const c = candidate({ siteMatch: false });
    apiGet.mockResolvedValue(response([c]));
    apiPost.mockRejectedValueOnce(
      new ApiErrorMock(409, 'site_mismatch', 'x', { error: 'site_mismatch', message: 'Объект заказа не найден в портале' }),
    );
    renderModal();
    fireEvent.click(await screen.findByRole('button', { name: 'Привязать' }));
    const text = await screen.findByText(/Объект заказа не найден в портале/);
    const dialog = text.closest<HTMLElement>('.ant-modal-confirm')!;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it('отменённый заказ — сначала подтверждение', async () => {
    const c = candidate({ approvalState: 'cancelled', sourcingStatus: 'cancelled' });
    apiGet.mockResolvedValue(response([c]));
    apiPost.mockResolvedValue(linked);
    renderModal();
    fireEvent.click(await screen.findByRole('button', { name: 'Привязать' }));
    const text = await screen.findByText(/Поставки по такому заказу, скорее всего, не будет/);
    expect(apiPost).not.toHaveBeenCalled();
    fireEvent.click(within(text.closest<HTMLElement>('.ant-modal-confirm')!).getByRole('button', { name: 'Привязать' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
  });

  it('уже привязанный — без кнопки, с меткой', async () => {
    apiGet.mockResolvedValue(response([candidate({ linked: true })]));
    renderModal();
    expect(await screen.findByText('Уже привязан')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Привязать' })).toBeNull();
  });
});

describe('LinkSupplierOrderModal: подробности по клику на строку', () => {
  const longContractor = 'Смирнов Евгений Александрович — бригада отделочников корпуса 6.2';

  it('клик по строке — поля и состав; повторный клик сворачивает', async () => {
    const c = candidate({ contractors: [{ id: 'c1', name: longContractor, inn: '771234567890', type: 'mol' }] });
    routeGet(c);
    renderModal();
    fireEvent.click(await screen.findByText(c.number));
    expect(await screen.findByText('Бетон B25')).toBeTruthy();
    expect(getUrls()).toContain(`/deliveries/d1/supplier-order-candidates/${c.id}`);
    expect(getUrls()).toContain(`/deliveries/d1/supplier-order-candidates/${c.id}/items`);
    const row = within(expandedRow());
    expect(row.getByText(new RegExp(`${longContractor} \\(МОЛ\\), ИНН 771234567890`))).toBeTruthy();
    expect(row.getByText(/Д-7 от 2026-10-01/)).toBeTruthy();
    expect(isExpanded()).toBe(true);

    fireEvent.click(screen.getAllByText(c.number)[0]!);
    await waitFor(() => expect(isExpanded()).toBe(false));
  });

  it('«Привязать» строку не раскрывает', async () => {
    const c = candidate();
    routeGet(c);
    apiPost.mockResolvedValue(linked);
    renderModal();
    fireEvent.click(await screen.findByRole('button', { name: 'Привязать' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(getUrls().some((u) => u.startsWith(`/deliveries/d1/supplier-order-candidates/${c.id}`))).toBe(false);
    expect(isExpanded()).toBe(false);
  });

  it('смена отбора, страницы и повторное открытие окна сворачивают строку', async () => {
    const c = candidate();
    routeGet(c, { total: 45 });
    const { reopen } = renderModal();
    const expand = async () => {
      fireEvent.click((await screen.findAllByText(c.number))[0]!);
      await waitFor(() => expect(isExpanded()).toBe(true));
    };

    await expand();
    fireEvent.click(screen.getByRole('switch', { name: 'Все объекты' }));
    await waitFor(() => expect(isExpanded()).toBe(false));

    await expand();
    fireEvent.click(await screen.findByTitle('2'));
    await waitFor(() => expect(isExpanded()).toBe(false));

    await expand();
    reopen();
    await waitFor(() => expect(isExpanded()).toBe(false));
  });

  it.each([
    [
      'заказ удалён — 404 подробностей',
      { detail: async () => Promise.reject(new ApiErrorMock(404, 'not_found', 'not_found')) },
      /Заказ удалён в EstiMat или не найден/,
    ],
    ['сбой подробностей', { detail: async () => Promise.reject(new Error('502')) }, /Не удалось загрузить заказ/],
    ['сбой состава — поля на месте', { items: async () => Promise.reject(new Error('502')) }, /Состав не загрузился/],
    [
      'интеграция не настроена',
      { items: async () => ({ state: 'disabled', fetchedAt: null, message: 'нет токена', items: [] }) },
      /интеграция с EstiMat не настроена \(нет токена\)/,
    ],
    [
      'EstiMat не ответил',
      { items: async () => ({ state: 'unavailable', fetchedAt: null, message: 'EstiMat занят', items: [] }) },
      /EstiMat сейчас не ответил: EstiMat занят\. Попробуйте позже/,
    ],
    [
      'в заказе нет позиций',
      { items: async () => ({ state: 'ready', fetchedAt: '2026-10-29T06:00:00.000Z', message: null, items: [] }) },
      /В заказе нет позиций/,
    ],
  ])('%s', async (_name, opts, text) => {
    const c = candidate();
    routeGet(c, opts);
    renderModal();
    fireEvent.click(await screen.findByText(c.number));
    expect(await within(await waitFor(() => expandedRow())).findByText(text)).toBeTruthy();
    if (_name === 'сбой состава — поля на месте') {
      expect(within(expandedRow()).getByText(/Д-7 от 2026-10-01/)).toBeTruthy();
    }
  });
});
