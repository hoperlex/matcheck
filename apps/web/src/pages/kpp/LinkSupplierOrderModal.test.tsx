// @vitest-environment jsdom
/**
 * Окно подбора заказа EstiMat: отборы и страница уходят на сервер, смена
 * отбора сбрасывает страницу; привязка — POST; заказ другого объекта —
 * подтверждение и повтор с confirmSiteMismatch, отказ — без второго запроса.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupplierOrderCandidate, SupplierOrderCandidatesResponse } from '@matcheck/contracts';

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
  render(
    <QueryClientProvider client={client}>
      <LinkSupplierOrderModal open deliveryId="d1" onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose };
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
