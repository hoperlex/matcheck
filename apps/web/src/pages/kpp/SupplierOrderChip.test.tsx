// @vitest-environment jsdom
/**
 * Чип «Заказ»: цвет по худшему состоянию визы, «Отвязать» по подтверждению,
 * без права — без кнопок. Плюс сквозной сценарий открытой карточки: виза снята
 * в EstiMat — через 30 с опроса чип становится оранжевым без действий человека.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeliverySupplierOrder, DeliverySupplierOrdersResponse } from '@matcheck/contracts';

const apiGet = vi.fn();
vi.mock('../../services/api', () => ({ api: { get: apiGet } }));

const { SupplierOrderChip } = await import('./SupplierOrderChip');
const { DeliverySupplierOrdersBlock } = await import('./DeliverySupplierOrdersBlock');
const { useDeliverySupplierOrders, SUPPLIER_ORDERS_REFRESH_MS } = await import('./useDeliverySupplierOrders');

function order(patch: Partial<DeliverySupplierOrder> = {}): DeliverySupplierOrder {
  return {
    id: crypto.randomUUID(),
    number: 'З-012',
    orderNo: 12,
    subNo: 0,
    sourcingStatus: 'awarded',
    approvalState: 'approved',
    projectCode: 'ЗИЛ33',
    projectName: 'ЖК МАРК',
    siteId: null,
    siteCode: 'ЗИЛ33',
    contractors: [{ id: 'c', name: 'ООО МСУ-15', inn: '7700000000', type: 'subcontractor' }],
    supplierName: 'ООО ЛАУРУС ГРУПП',
    supplierInn: '7800000000',
    amount: '1584000.00',
    awardedAt: null,
    supplyApprovedAt: '2026-10-22T12:40:11.000Z',
    lastApprovalRevokedAt: null,
    deletedAt: null,
    lastSeenAt: '2026-10-27T10:00:00.000Z',
    estimatCreatedAt: null,
    linkedAt: '2026-10-27T10:00:00.000Z',
    siteMismatch: false,
    supplierMatch: true,
    contractorMatch: null,
    ...patch,
  };
}

afterEach(() => {
  cleanup();
  apiGet.mockReset();
  vi.useRealTimers();
});

describe('SupplierOrderChip', () => {
  it('цвет — по худшему; recorded не хуже согласованного', () => {
    const { rerender } = render(
      <SupplierOrderChip orders={[order(), order({ approvalState: 'not_required', number: 'З-013' })]} />,
    );
    expect(screen.getByTestId('supplier-order-chip').dataset.state).toBe('approved');
    expect(screen.getByTestId('supplier-order-chip').textContent).toContain('З-012 · З-013');

    rerender(<SupplierOrderChip orders={[order(), order({ approvalState: 'pending' })]} />);
    expect(screen.getByTestId('supplier-order-chip').dataset.state).toBe('pending');

    rerender(<SupplierOrderChip orders={[order({ approvalState: 'pending' }), order({ approvalState: 'deleted' })]} />);
    expect(screen.getByTestId('supplier-order-chip').dataset.state).toBe('deleted');
  });

  it('без заказов чипа нет', () => {
    render(<SupplierOrderChip orders={[]} />);
    expect(screen.queryByTestId('supplier-order-chip')).toBeNull();
  });

  it('«Отвязать» — по подтверждению; без права кнопки нет', async () => {
    const onUnlink = vi.fn();
    const o = order();
    render(<SupplierOrderChip orders={[o]} onUnlink={onUnlink} />);
    fireEvent.click(screen.getByTestId('supplier-order-chip'));
    fireEvent.click(await screen.findByRole('button', { name: /Отвязать/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Отвязать', hidden: false }));
    await waitFor(() => expect(onUnlink).toHaveBeenCalledWith(o));

    cleanup();
    render(<SupplierOrderChip orders={[o]} />);
    fireEvent.click(screen.getByTestId('supplier-order-chip'));
    await screen.findByTestId(`supplier-order-${o.id}`);
    expect(screen.queryByRole('button', { name: /Отвязать/ })).toBeNull();
  });
});

function OpenCard({ deliveryId }: { deliveryId: string }) {
  const q = useDeliverySupplierOrders(deliveryId, true);
  const orders = q.data?.items ?? [];
  return (
    <>
      <SupplierOrderChip orders={orders} />
      <DeliverySupplierOrdersBlock deliveryId={deliveryId} orders={orders} />
    </>
  );
}

describe('открытая карточка приёмки', () => {
  it('виза снята в EstiMat — чип и блок меняются после опроса, без действий человека', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const approved = order();
    const response = (o: DeliverySupplierOrder): DeliverySupplierOrdersResponse => ({
      items: [o],
      sync: { enabled: true, reason: null, lastCompletedAt: null, lastOutcome: null, lastErrorCode: null },
    });
    apiGet.mockResolvedValueOnce(response(approved));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <OpenCard deliveryId="d1" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('supplier-order-chip').dataset.state).toBe('approved'));
    expect(screen.getByText(/Заказ З-012 · согласован/)).toBeTruthy();

    apiGet.mockResolvedValue(
      response({
        ...approved,
        approvalState: 'pending',
        supplyApprovedAt: null,
        lastApprovalRevokedAt: '2026-10-27T11:00:00.000Z',
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUPPLIER_ORDERS_REFRESH_MS + 100);
    });
    await waitFor(() => expect(screen.getByTestId('supplier-order-chip').dataset.state).toBe('pending'));
    expect(screen.getByText(/согласование снято/)).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith('/deliveries/d1/supplier-orders');
  });

  it('без привязок не опрашивает', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiGet.mockResolvedValue({
      items: [],
      sync: { enabled: true, reason: null, lastCompletedAt: null, lastOutcome: null, lastErrorCode: null },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <OpenCard deliveryId="d2" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUPPLIER_ORDERS_REFRESH_MS * 3);
    });
    expect(apiGet).toHaveBeenCalledTimes(1);
  });
});
