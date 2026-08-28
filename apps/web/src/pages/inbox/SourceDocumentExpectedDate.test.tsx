// @vitest-environment jsdom
/**
 * Дата поставки в карточке — свойство МАШИНЫ, а не строки.
 *
 * Менеджер должен узнать об этом до сохранения: правка переносит дату на все
 * документы рейса и на сам пакет. Отдельно охраняется очистка — без даты
 * поставка пропадает у инспектора ЦЕЛИКОМ (предикат видимости требует дату у
 * каждого документа машины), поэтому там спрашивают подтверждение.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function wrap(node: ReactElement): ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

/** Реквизиты живут в свёрнутой панели (широкий экран) или на вкладке «Шапка». */
async function openHeader(): Promise<void> {
  const tab = screen.queryByRole('tab', { name: /Шапка/ });
  if (tab) {
    fireEvent.click(tab);
    return;
  }
  fireEvent.click(await screen.findByText('Реквизиты документа'));
}

/** Крестик очистки внутри поля «Дата поставки» — antd рисует его всегда. */
function clearExpectedDate(): void {
  const item = screen.getByText('Дата поставки').closest('.ant-form-item');
  const clear = item?.querySelector('.ant-picker-clear');
  if (!clear) throw new Error('крестик очистки не найден');
  fireEvent.mouseDown(clear);
  fireEvent.click(clear);
}

async function openCard(): Promise<void> {
  render(wrap(<SourceDocumentDetailModal id={detail.id} open onClose={() => {}} />));
  await screen.findByText(/ТР-12296|Реквизиты документа|Позиции/);
  await openHeader();
  await screen.findByText('Дата поставки');
}

beforeEach(() => {
  detail.portalGroupSize = 3;
  detail.expectedDate = '2026-08-26';
});

afterEach(() => {
  patch.mockClear();
  cleanup();
});

describe('дата поставки — свойство машины', () => {
  it('предупреждает, что дата сменится у всей машины', async () => {
    await openCard();
    expect(await screen.findByText(/дата сменится у всей машины \(3 док\.\)/)).toBeTruthy();
  });

  it('очистка даты требует подтверждения: отмена не отправляет PATCH', async () => {
    await openCard();
    clearExpectedDate();

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText(/пропадёт у инспектора на планшете/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(patch).not.toHaveBeenCalled());
  });

  it('подтверждение очистки отправляет пустую дату', async () => {
    await openCard();
    clearExpectedDate();

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Снять дату' }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    const [, body] = patch.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(body.expectedDate).toBeNull();
  });

  it('обычное сохранение с датой лишнего вопроса не задаёт', async () => {
    await openCard();

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    const [, body] = patch.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(body.expectedDate).toBe('2026-08-26');
    expect(screen.queryByText(/пропадёт у инспектора на планшете/)).toBeNull();
  });

  it('машина из одного документа: очистка даты подтверждения не требует', async () => {
    detail.portalGroupSize = 1;
    await openCard();
    clearExpectedDate();

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    const [, body] = patch.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(body.expectedDate).toBeNull();
  });
});
