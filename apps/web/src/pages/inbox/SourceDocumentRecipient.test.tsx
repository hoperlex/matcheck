// @vitest-environment jsdom
/**
 * Блок «Получатель» в карточке приёмки: показ вместо выбора.
 *
 * Подрядчик у приёмки — внутренняя привязка затрат: на «Обработано» он не
 * влияет, инспектору не показывается (планшет рисует грузополучателя из самого
 * документа), а выбор из карточки только путал — резолвер подставлял туда
 * покупателя, и у поставки субподрядчику это оказывался генподрядчик.
 *
 * Тест держит два свойства: подрядчика в форме приёмки не выбирают, а
 * сохранение не трогает его значение в базе (оно живёт для фильтра «Подрядчик»
 * и области видимости роли contractor).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageAction, PageId } from '@matcheck/contracts';
import type { ReactElement } from 'react';

const detail = {
  id: '22222222-2222-2222-2222-222222222222',
  kind: 'upd',
  direction: 'inbound',
  status: 'parsed',
  origin: 'manual_pdf',
  docNumber: 'ТР-12296',
  docDate: '2026-08-25',
  expectedDate: '2026-08-26',
  totalSum: '60263.00',
  vatSum: null,
  supplierName: 'ООО «РУТЕК»',
  buyerName: 'ООО "СУ-10"',
  consigneeName: 'ООО "СУ-10"',
  contractorId: '33333333-3333-3333-3333-333333333333',
  contractorName: 'ООО «СУ-10»',
  recipientSource: 'auto_buyer',
  recipientMolId: null,
  siteId: '44444444-4444-4444-4444-444444444444',
  siteName: 'ЖК Сити Бей 2-ая оч.',
  portalGroupId: '55555555-5555-5555-5555-555555555555',
  portalGroupSize: 3,
  items: [{ id: 'i1', lineNo: 1, nameRaw: 'Труба', qty: '1', unit: 'шт', price: '100', sum: '100' }],
  attachments: [],
  extraFiles: [],
  validation: { hasMismatch: false, checkedAt: null, checks: [], warnings: [] },
};

const patch = vi.fn(() => Promise.resolve(detail));

vi.mock('../../services/api', () => ({
  api: {
    get: vi.fn((url: string) => {
      if (url.includes('/responsible-persons')) return Promise.resolve({ items: [], total: 0 });
      if (url.includes('/sites')) return Promise.resolve({ items: [], total: 0 });
      if (url.includes('/units')) return Promise.resolve({ items: [], total: 0 });
      if (url.includes('/customer-counterparties')) return Promise.resolve({ items: [], total: 0 });
      if (url.endsWith('/file')) return Promise.reject(new Error('no file'));
      return Promise.resolve(detail);
    }),
    post: vi.fn(),
    patch: (...args: unknown[]) => patch(...(args as [])),
  },
  apiDownload: vi.fn(),
  ApiError: class ApiError extends Error {
    status = 404;
    code = 'not_found';
  },
}));

vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({
    can: (_page: PageId, _action: PageAction) => true,
    canView: () => true,
    canViewGroup: () => true,
    hasCapability: () => true,
    enforced: true,
    loading: false,
  }),
}));

vi.mock('../../stores/auth', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ user: { id: 'u1', role: 'manager' } }),
}));

const { SourceDocumentDetailModal } = await import('./SourceDocumentDetailModal');

/**
 * Реквизиты живут в свёрнутой панели (широкий экран) или на вкладке «Шапка»
 * (узкий). jsdom по умолчанию узкий, поэтому раскрываем то, что есть.
 */
async function openHeader(): Promise<void> {
  const tab = screen.queryByRole('tab', { name: /Шапка/ });
  if (tab) {
    fireEvent.click(tab);
    return;
  }
  fireEvent.click(await screen.findByText('Реквизиты документа'));
}

function wrap(node: ReactElement): ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

afterEach(() => {
  patch.mockClear();
  cleanup();
});

describe('карточка приёмки — получатель', () => {
  it('вместо выбора подрядчика показывает стороны из документа', async () => {
    render(wrap(<SourceDocumentDetailModal id={detail.id} open onClose={() => {}} />));
    await screen.findByText(/ТР-12296|Реквизиты документа|Позиции/);
    await openHeader();

    expect(await screen.findByText('Стороны по документу')).toBeTruthy();
    // Текст собран из нескольких узлов (имя сокращается отдельным элементом),
    // поэтому сверяем содержимое абзаца целиком.
    const hasLine = (prefix: string) =>
      screen
        .getAllByText((_, el) => (el?.textContent ?? '').startsWith(prefix))
        .some((el) => (el.textContent ?? '').includes('СУ-10'));
    expect(hasLine('Грузополучатель:')).toBe(true);
    expect(hasLine('Покупатель:')).toBe(true);
    // Ни переключателя «Подрядчик/МОЛ», ни подсказки про автоподстановку.
    expect(screen.queryByText('Подрядчик')).toBeNull();
    expect(screen.queryByText(/Подставлено автоматически/)).toBeNull();
    // МОЛ остаётся редактируемым — это единственный получатель, которого
    // менеджер задаёт руками.
    expect(screen.getByText('МОЛ')).toBeTruthy();
  });

  it('сохранение не отправляет contractorId и предупреждает про всю машину', async () => {
    render(wrap(<SourceDocumentDetailModal id={detail.id} open onClose={() => {}} />));
    await screen.findByText(/ТР-12296|Реквизиты документа|Позиции/);
    await openHeader();

    expect(await screen.findByText(/объект сменится у всей машины \(3 док\.\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    const [, body] = patch.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect('contractorId' in body).toBe(false);
    expect(body.recipientMolId).toBeNull();
    expect(body.siteId).toBe(detail.siteId);
  });
});
