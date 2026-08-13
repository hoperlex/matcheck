// @vitest-environment jsdom
/**
 * Вход в редактор из модалки просмотра — по праву правки.
 *
 * Ровно этот контрол ревью нашло дефектом: он прятался по имени роли
 * (`isMonitor`), и выданный администратором `edit` не работал — кнопки просто
 * не было. Тест закрепляет, что решает право, а не роль.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const can = vi.fn();
vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({ can, hasCapability: () => true, loading: false }),
}));

// Галерея тянет IndexedDB и очередь загрузки — к предмету теста отношения не
// имеет, поэтому подменяется заглушкой.
vi.mock('./PhotoGallery', () => ({ PhotoGallery: () => null }));

import { DeliveryViewModal } from './DeliveryViewModal';

const data = {
  delivery: {
    id: '11111111-1111-1111-1111-111111111111',
    status: { code: 'filled', name: 'Оформлена' },
    arrivedAt: new Date('2026-08-13T10:00:00Z').toISOString(),
    updatedAt: new Date('2026-08-13T10:00:00Z').toISOString(),
    photos: [],
    items: [],
    // Компонент читает список УПД напрямую — без него падает на .length.
    sourceDocumentIds: [],
    pendingDeletionAt: null,
    reviewState: null,
    reviewNote: null,
    reviewedByUserEmail: null,
    reviewedAt: null,
  },
} as never;

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DeliveryViewModal data={data} open onClose={() => {}} onEdit={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => can.mockReset());
afterEach(() => cleanup());

describe('DeliveryViewModal: вход в редактор', () => {
  it('право правки есть — кнопка «Открыть в редакторе» на месте', () => {
    can.mockReturnValue(true);
    renderModal();
    expect(screen.getByRole('button', { name: /Открыть в редакторе/i })).toBeDefined();
    expect(can).toHaveBeenCalledWith('operations.deliveries', 'edit');
  });

  it('права нет — кнопки нет, остаётся только «Закрыть»', () => {
    can.mockReturnValue(false);
    renderModal();
    expect(screen.queryByRole('button', { name: /Открыть в редакторе/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Закрыть/i })).toBeDefined();
  });
});
