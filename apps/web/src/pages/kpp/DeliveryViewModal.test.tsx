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
    purpose: 'tolling_act',
    reviewNote: null,
    reviewedByUserEmail: null,
    reviewedAt: null,
  },
} as never;

function renderModal(payload: unknown = data) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DeliveryViewModal data={payload as never} open onClose={() => {}} onEdit={() => {}} />
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
    expect(screen.getByText('Признак: Давальческий акт')).toBeDefined();
  });

  it('права нет — кнопки нет, остаётся только «Закрыть»', () => {
    can.mockReturnValue(false);
    renderModal();
    expect(screen.queryByRole('button', { name: /Открыть в редакторе/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Закрыть/i })).toBeDefined();
  });

  it('показывает отдельные значения связанного УПД в заголовке материалов', () => {
    can.mockReturnValue(false);
    renderModal({
      delivery: {
        id: '11111111-1111-4111-8111-111111111111',
        status: { code: 'filled', name: 'Оформлена' },
        arrivedAt: null,
        updatedAt: '2026-10-29T10:00:00Z',
        photos: [],
        items: [],
        sourceDocumentIds: ['22222222-2222-4222-8222-222222222222'],
        sourceDocuments: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            kind: 'upd',
            docNumber: '77',
            linked: true,
          },
        ],
        recipientsPerDocument: true,
        recipientMolId: null,
        contractorId: null,
        purpose: 'realization',
        documentRecipients: [
          {
            sourceDocumentId: '22222222-2222-4222-8222-222222222222',
            ownRecipient: true,
            contractorId: null,
            contractorName: null,
            recipientMolId: null,
            recipientMolName: null,
            ownPurpose: true,
            purpose: null,
          },
        ],
        pendingDeletionAt: null,
        reviewState: null,
        reviewNote: null,
        reviewedByUserEmail: null,
        reviewedAt: null,
      },
    });
    expect(screen.getByText(/Материалы · УПД № 77/)).toBeTruthy();
    expect(screen.getByText(/Получатель: — не указан/)).toBeTruthy();
    expect(screen.getByText(/Признак: — не выбран/)).toBeTruthy();
  });
});
