// @vitest-environment jsdom
/**
 * Действия в строке истории отгрузок — по матрице, зеркально приёмкам.
 *
 * Сценарий «Поделиться» здесь не дубликат: в отгрузках кнопка не спрашивала
 * права вовсе (ни ячейки, ни возможности) — тот же дефект, что ревью нашло в
 * приёмках, но в другом файле. Тест закрепляет обе половины гейта.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const can = vi.fn();
const hasCapability = vi.fn();
vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({ can, hasCapability, canView: () => true, loading: false }),
}));

const authUser = { id: 'u-1', email: 'manager@test.com', role: 'manager' };
vi.mock('../../stores/auth', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: authUser }),
}));

const row = {
  id: '11111111-1111-1111-1111-111111111111',
  displayId: 5,
  kind: 'external',
  purpose: null,
  // shipped — soft-delete: в строке кнопка «Пометить на удаление».
  status: { code: 'shipped', label: 'Отгружена', color: null },
  siteId: '33333333-3333-3333-3333-333333333333',
  siteName: 'Объект 1',
  receiverCounterpartyId: null,
  receiverMolId: null,
  destSiteId: null,
  supplierId: null,
  receiverName: null,
  supplierName: null,
  vehiclePlate: 'В777МР99',
  driverName: null,
  shippedAt: '2026-08-13T10:00:00.000Z',
  inTransit: false,
  isAssets: false,
  pendingDeletionAt: null,
  pendingDeletionByUserId: null,
  reviewState: null,
  items: [],
  photos: [],
  sourceDocumentIds: [],
  primarySourceDocument: null,
  itemCount: 0,
  photoCount: 0,
  createdAt: '2026-08-13T10:00:00.000Z',
  updatedAt: '2026-08-13T10:00:00.000Z',
};

vi.mock('../../services/api', () => ({
  ApiError: class extends Error {},
  api: {
    get: async (url: string) =>
      url.startsWith('/shipments') ? { items: [row], total: 1 } : { items: [], total: 0 },
  },
}));
vi.mock('../../services/shipments', () => ({
  hardDeleteShipment: vi.fn(),
  markDeletion: vi.fn(),
  unmarkDeletion: vi.fn(),
}));
vi.mock('./ShipmentViewModal', () => ({ ShipmentViewModal: () => null }));
vi.mock('../../components/ShareLinkModal', () => ({ ShareLinkModal: () => null }));

import { ShipmentsHistory } from './ShipmentsHistory';

async function renderHistory(): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ShipmentsHistory onOpen={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('В777МР99')).toBeDefined());
  return container;
}

const hasIcon = (c: HTMLElement, name: string) => c.querySelector(`.anticon-${name}`) !== null;

beforeEach(() => {
  can.mockReset();
  hasCapability.mockReset();
});
afterEach(() => cleanup());

describe('ShipmentsHistory: действия в строке', () => {
  it('права выданы — правка, удаление и ссылка на месте', async () => {
    can.mockReturnValue(true);
    hasCapability.mockReturnValue(true);
    const c = await renderHistory();
    expect(hasIcon(c, 'edit')).toBe(true);
    expect(hasIcon(c, 'delete')).toBe(true);
    expect(hasIcon(c, 'share-alt')).toBe(true);
    expect(can).toHaveBeenCalledWith('operations.shipments', 'edit');
    expect(can).toHaveBeenCalledWith('operations.shipments', 'delete');
  });

  it('прав нет — остаётся только просмотр', async () => {
    can.mockReturnValue(false);
    hasCapability.mockReturnValue(true);
    const c = await renderHistory();
    expect(hasIcon(c, 'edit')).toBe(false);
    expect(hasIcon(c, 'delete')).toBe(false);
    expect(hasIcon(c, 'share-alt')).toBe(false);
    expect(hasIcon(c, 'eye')).toBe(true);
  });

  it('РЕГРЕСС: снят edit — ссылки нет, хотя возможность есть', async () => {
    can.mockImplementation((_page: string, action: string) => action !== 'edit');
    hasCapability.mockReturnValue(true);
    const c = await renderHistory();
    expect(hasIcon(c, 'share-alt')).toBe(false);
    expect(hasIcon(c, 'edit')).toBe(false);
    expect(hasIcon(c, 'delete')).toBe(true);
  });

  it('возможности нет — ссылки нет, хотя edit выдан', async () => {
    can.mockReturnValue(true);
    hasCapability.mockReturnValue(false);
    const c = await renderHistory();
    expect(hasIcon(c, 'share-alt')).toBe(false);
    expect(hasIcon(c, 'edit')).toBe(true);
    expect(hasCapability).toHaveBeenCalledWith('operations.share.manage');
  });
});
