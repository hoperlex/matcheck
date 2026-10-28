// @vitest-environment jsdom
/**
 * Вкладка «Заказы»: каждый фильтр уходит в запрос к серверу (клиентских
 * фильтров и сортировок нет), смена фильтра сбрасывает страницу; «Обновить» —
 * только с возможностью; вкладка скрыта без возможности маршрута.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EstimatSyncStatus } from '@matcheck/contracts';

const caps = new Set<string>();
vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({
    can: () => true,
    canView: () => true,
    canViewGroup: () => true,
    hasCapability: (c: string) => caps.has(c),
    enforced: true,
    loading: false,
  }),
}));

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('../../services/api', () => ({ api: { get: apiGet, post: apiPost }, ApiError: class extends Error {} }));

const { default: SupplierOrders } = await import('./SupplierOrders');
const { default: ReferencesLayout, TAB_DEFS } = await import('./ReferencesLayout');

const STATUS: EstimatSyncStatus = {
  enabled: true,
  reason: null,
  intervalSec: 1800,
  running: null,
  lastRun: null,
  lastCompleted: null,
};

function route(url: string) {
  if (url.startsWith('/estimat/sync-status')) return Promise.resolve(STATUS);
  if (url.startsWith('/sites')) {
    return Promise.resolve({ items: [{ id: 'site-1', code: 'ЗИЛ33', name: 'ЖК МАРК' }], total: 1 });
  }
  return Promise.resolve({ items: [], total: 120 });
}

function renderPage(initial = '/references/supplier-orders') {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <App>
        <MemoryRouter initialEntries={[initial]}>
          <Routes>
            <Route path="/references/supplier-orders" element={<SupplierOrders />} />
          </Routes>
        </MemoryRouter>
      </App>
    </QueryClientProvider>,
  );
}

const listUrls = () =>
  apiGet.mock.calls
    .map((c) => c[0] as string)
    .filter((u) => u.startsWith('/estimat/supplier-orders?'))
    .map((u) => new URL(`http://x${u}`).searchParams);
const lastList = () => listUrls().at(-1)!;

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockImplementation(route);
  apiPost.mockReset();
  caps.clear();
});
afterEach(cleanup);

describe('вкладка «Заказы»', () => {
  it('фильтры из адреса уходят на сервер', async () => {
    renderPage('/references/supplier-orders?q=бетон&site=site-1&status=awarded&approval=pending&deleted=1&page=3');
    await waitFor(() => expect(listUrls().length).toBeGreaterThan(0));
    const p = lastList();
    expect(p.get('q')).toBe('бетон');
    expect(p.get('siteId')).toBe('site-1');
    expect(p.get('status')).toBe('awarded');
    expect(p.get('approval')).toBe('pending');
    expect(p.get('includeDeleted')).toBe('true');
    expect(p.get('limit')).toBe('50');
    expect(p.get('offset')).toBe('100');
  });

  it('смена фильтра сбрасывает страницу', async () => {
    renderPage('/references/supplier-orders?page=2');
    await waitFor(() => expect(lastList()?.get('offset')).toBe('50'));
    fireEvent.click(screen.getByRole('switch', { name: 'Показывать удалённые' }));
    await waitFor(() => {
      expect(lastList().get('includeDeleted')).toBe('true');
      expect(lastList().get('offset')).toBe('0');
    });
  });

  it('«Обновить» — только с возможностью sync', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Заказы ещё не загружались')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Обновить/ })).toBeNull();
    cleanup();

    caps.add('references.supplier_orders.sync');
    apiPost.mockResolvedValue({ status: 'queued' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Обновить/ }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/estimat/sync'));
  });

  it('вкладка в Справочниках требует возможность маршрута', async () => {
    expect(TAB_DEFS.find((t) => t.key === '/references/supplier-orders')).toMatchObject({
      page: 'references.supplier_orders',
      capability: 'references.supplier_orders.view',
    });
    const renderLayout = () =>
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter initialEntries={['/references/sites']}>
            <Routes>
              <Route path="/references/*" element={<ReferencesLayout />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    renderLayout();
    await waitFor(() => expect(screen.getByText(/Объекты/)).toBeTruthy());
    expect(screen.queryByText(/^Заказы/)).toBeNull();
    cleanup();

    caps.add('references.supplier_orders.view');
    renderLayout();
    expect(await screen.findByText(/^Заказы/)).toBeTruthy();
  });
});
