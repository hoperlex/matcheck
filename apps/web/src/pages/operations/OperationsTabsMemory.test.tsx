// @vitest-environment jsdom
/**
 * «Операции»: у каждой вкладки свои статус, номер и страница.
 *
 * Раньше переключение «Принятые → Ожидаемые → Принятые» (или Приёмка ↔
 * Отгрузка) снимало status/id/purpose/page навсегда: коды статусов у вкладок
 * разные, и их чистили, но обратно уже не возвращали. Теперь они приходят из
 * памяти списков; общие фильтры (период, объект) переживают переключение как
 * и раньше.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDto } from '@matcheck/contracts';
import { useAuthStore } from '../../stores/auth';
import { useListMemoryRecorder } from '../../shared/hooks/useListMemoryRecorder';

vi.mock('../../services/api', () => ({
  api: { get: async () => ({}) },
  apiDownload: async () => undefined,
  ApiError: class extends Error {},
}));
vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({ can: () => true, canView: () => true }),
}));
vi.mock('../../shared/hooks/useOperationsCounters', () => ({
  useOperationsCounters: () => ({ data: undefined }),
}));
// Списки — не предмет теста: проверяется только то, что пишет в адрес сама
// страница при переключении вкладок.
vi.mock('../kpp/ExpectedUpds', () => ({ ExpectedUpds: () => null }));
vi.mock('../shipments/ExpectedOutbound', () => ({ ExpectedOutbound: () => null }));
vi.mock('../kpp/DeliveriesHistory', () => ({ DeliveriesHistory: () => null }));
vi.mock('../shipments/ShipmentsHistory', () => ({ ShipmentsHistory: () => null }));

const { default: OperationsPage } = await import('./OperationsPage');

let search = '';

function Shell() {
  // Как в AppShell: память списков пишется на каждую смену адреса.
  useListMemoryRecorder();
  search = useLocation().search;
  return <OperationsPage />;
}

function renderPage(initial: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[`/operations${initial}`]}>
        <Shell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function current(): URLSearchParams {
  return new URLSearchParams(search);
}

beforeEach(() => {
  sessionStorage.clear();
  useAuthStore.getState().setUser({
    id: '11111111-1111-4111-8111-111111111111',
    email: 'x@test',
    role: 'admin',
  } as UserDto);
});

afterEach(() => {
  cleanup();
  useAuthStore.getState().clear();
});

describe('Операции: память вкладок', () => {
  it('Принятые → Ожидаемые → Принятые возвращает статус и страницу', async () => {
    renderPage('?type=delivery&tab=accepted&status=filled&page=3&dfrom=2026-11-01&site=s1');

    fireEvent.click(screen.getByText('Ожидаемые'));
    await waitFor(() => expect(current().get('tab')).toBe('expected'));
    expect(current().has('status')).toBe(false);
    expect(current().has('page')).toBe(false);
    // Общие фильтры остаются.
    expect(current().get('dfrom')).toBe('2026-11-01');
    expect(current().get('site')).toBe('s1');

    fireEvent.click(screen.getByText('Принятые'));
    await waitFor(() => expect(current().get('tab')).toBe('accepted'));
    expect(current().get('status')).toBe('filled');
    expect(current().get('page')).toBe('3');
    expect(current().get('dfrom')).toBe('2026-11-01');
  });

  it('Приёмка → Отгрузка → Приёмка: статус приёмок не уезжает к отгрузкам и возвращается', async () => {
    renderPage('?type=delivery&tab=accepted&status=filled&id=12');

    fireEvent.click(screen.getByText('Отгрузка'));
    await waitFor(() => expect(current().get('type')).toBe('shipment'));
    expect(current().has('status')).toBe(false);
    expect(current().has('id')).toBe(false);

    fireEvent.click(screen.getByText('Приёмка'));
    await waitFor(() => expect(current().get('type')).toBe('delivery'));
    expect(current().get('status')).toBe('filled');
    expect(current().get('id')).toBe('12');
  });
});
