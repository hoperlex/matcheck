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
import { chipText } from '../../test/chipText';

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
    expect(screen.getByText(chipText('Признак: Давальческий акт'))).toBeDefined();
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
    expect(screen.getByText(chipText(/Получатель: — не указан/))).toBeTruthy();
    expect(screen.getByText(chipText(/Признак: — не выбран/))).toBeTruthy();
  });
  it('УПД из ЭДО без скана (0152): блоки с получателем и признаком без права правки и без запросов', () => {
    can.mockReturnValue(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderModal({
      delivery: {
        id: '11111111-1111-4111-8111-111111111111',
        status: { code: 'filled', name: 'Оформлена' },
        arrivedAt: null,
        updatedAt: '2026-11-18T10:00:00Z',
        photos: [],
        items: [],
        sourceDocumentIds: [],
        sourceDocuments: [],
        recipientsPerDocument: true,
        recipientMolId: null,
        contractorId: null,
        purpose: 'tolling_act',
        documentRecipients: [],
        edoDocuments: [
          {
            matchId: '33333333-3333-4333-8333-333333333333',
            operator: 'diadoc',
            docNumber: '201/21126982-2332',
            docDate: '2026-10-29',
            ownRecipient: true,
            contractorId: '44444444-4444-4444-8444-444444444444',
            contractorName: 'ООО КС',
            recipientMolId: null,
            recipientMolName: null,
            ownPurpose: false,
            purpose: null,
          },
          {
            matchId: '55555555-5555-4555-8555-555555555555',
            operator: 'sbis',
            docNumber: '1438',
            docDate: '2026-10-30',
            ownRecipient: false,
            contractorId: null,
            contractorName: null,
            recipientMolId: null,
            recipientMolName: null,
            ownPurpose: false,
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
    expect(screen.getByText('Материалы · УПД № 201/21126982-2332 из ЭДО · Диадок')).toBeTruthy();
    expect(screen.getByText('Материалы · УПД № 1438 из ЭДО · СБИС')).toBeTruthy();
    expect(screen.getByText(chipText(/Получатель: Подрядчик: ООО КС/))).toBeTruthy();
    expect(screen.getByText(chipText(/Получатель: как у приёмки: — не указан/))).toBeTruthy();
    expect(screen.getAllByText(chipText(/Признак: как у приёмки: Давальческий акт/))).toHaveLength(
      2,
    );
    // Данные — из строки списка: чтение ЭДО (право правки) не нужно.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('DeliveryViewModal: сумма по УПД из ЭДО', () => {
  const edoSummary = {
    documents: [],
    unpairedLinkedDocumentIds: [],
    ambiguous: false,
    sharedMax: 2,
    header: {
      total: 2323906.09,
      known: 1,
      count: 1,
      source: 'edo',
      comparison: { edo: 2323906.09, scan: 156336, mismatch: true },
    },
    list: {
      exVat: 1904840.56,
      vat: 419065.53,
      source: 'edo',
      edoExVat: 1904840.56,
      edoVat: 419065.53,
      factExVat: null,
      factVat: null,
      edoMissing: 0,
    },
  };

  it('подпись «Сумма по ЭДО», пометки расхождения и общей УПД; без «Без документа»', () => {
    can.mockReturnValue(false);
    renderModal({
      ...(data as object),
      delivery: { ...(data as { delivery: object }).delivery, edoSummary },
      docKindLabel: 'УПД из ЭДО',
      docNumber: '524',
      docTotalSum: 2323906.09,
      docTotalLabel: 'Сумма по ЭДО',
    });
    expect(
      screen.getByText(chipText(/^Сумма по ЭДО: 2 323 906,09 .* · УПД на 2 приёмки/)),
    ).toBeTruthy();
    expect(screen.getByText(/по скану 156 336,00/)).toBeTruthy();
    expect(screen.getByText(chipText('УПД из ЭДО: 524'))).toBeTruthy();
    // sourceDocumentIds пуст, но УПД из ЭДО есть — это не «без документа».
    expect(screen.queryByText('Без документа')).toBeNull();
  });
});
