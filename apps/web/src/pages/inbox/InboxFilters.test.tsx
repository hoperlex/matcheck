// @vitest-environment jsdom
/**
 * Фильтры «Документов» независимы друг от друга.
 *
 * Жалоба звучала так: выбираешь объект, вводишь номер документа — объект
 * слетает. Причина была в записи query-параметров: панель шлёт частичный патч,
 * а недостающие ключи приходили как `undefined` и удалялись вместе с реально
 * снятыми. Тест держит именно это: адрес после ввода номера сохраняет объект,
 * подрядчика и поставщика.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({
    can: () => true,
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

const SITE_ID = '33333333-3333-3333-3333-333333333333';
const CONTRACTOR_ID = '44444444-4444-4444-4444-444444444444';
const SUPPLIER_ID = '55555555-5555-5555-5555-555555555555';

// Сеть не предмет теста: список пустой, важен только адрес после ввода.
// Ответ подменяется в тестах: базовый — пустой список.
const apiState = vi.hoisted(() => ({
  response: { items: [], total: 0 } as Record<string, unknown>,
}));

vi.mock('../../services/api', () => ({
  api: {
    get: async () => apiState.response,
    post: async () => ({ ok: true }),
    patch: async () => ({}),
    delete: async () => ({}),
  },
  apiDownload: async () => undefined,
  ApiError: class extends Error {},
}));

const { default: InboxPage } = await import('./Inbox');

let search = '';
// eslint-disable-next-line @typescript-eslint/no-explicit-any

function UrlSpy(): null {
  search = useLocation().search;
  return null;
}

function renderPage(initial: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui: ReactElement = (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initial]}>
        <InboxPage />
        <UrlSpy />
      </MemoryRouter>
    </QueryClientProvider>
  );
  render(ui);
}

afterEach(() => {
  cleanup();
  apiState.response = { items: [], total: 0 };
});

describe('Документы: фильтры не затирают друг друга', () => {
  it('ввод номера документа сохраняет объект, подрядчика и поставщика', async () => {
    renderPage(
      `/documents?site=${SITE_ID}&contractor=${CONTRACTOR_ID}&supplier=${SUPPLIER_ID}&direction=inbound`,
    );

    const input = await screen.findByPlaceholderText('Номер документа');
    fireEvent.change(input, { target: { value: 'УТ-10354' } });

    // DebouncedSearch отдаёт значение родителю через 300 мс.
    await waitFor(() => expect(search).toContain('q=%D0%A3%D0%A2-10354'), { timeout: 2000 });

    expect(search).toContain(`site=${SITE_ID}`);
    expect(search).toContain(`contractor=${CONTRACTOR_ID}`);
    expect(search).toContain(`supplier=${SUPPLIER_ID}`);
    expect(search).toContain('direction=inbound');
  });

  it('очистка номера снимает только его', async () => {
    renderPage(`/documents?site=${SITE_ID}&q=%D0%A3%D0%A2-1`);

    const input = await screen.findByPlaceholderText('Номер документа');
    fireEvent.change(input, { target: { value: '' } });

    await waitFor(() => expect(search).not.toContain('q='), { timeout: 2000 });
    expect(search).toContain(`site=${SITE_ID}`);
  });

  it('кнопка «Требуют внимания» не трогает остальные фильтры', async () => {
    renderPage(`/documents?site=${SITE_ID}&q=%D0%A3%D0%A2-1`);

    fireEvent.click(await screen.findByRole('button', { name: /Требуют внимания/ }));

    await waitFor(() => expect(search).toContain('attention=1'));
    expect(search).toContain(`site=${SITE_ID}`);
    expect(search).toContain('q=%D0%A3%D0%A2-1');
  });
});

describe('Документы: принятые файлы и страница списка', () => {
  it('файлы показываются отдельным блоком и не вытесняют документы', async () => {
    const docs = Array.from({ length: 50 }, (_, i) => ({
      id: `doc-${String(i).padStart(2, '0')}`,
      kind: 'upd',
      direction: 'inbound',
      status: 'parsed',
      origin: 'manual_pdf',
      docNumber: `Д-${i}`,
      docDate: '2026-08-01',
      expectedDate: null,
      totalSum: '1000.00',
      vatSum: null,
      supplierId: null,
      supplierName: null,
      contractorId: null,
      contractorName: null,
      recipientId: null,
      recipientName: null,
      recipientMolId: null,
      recipientMolName: null,
      siteId: null,
      siteName: null,
      llmProviderId: null,
      llmConfidence: null,
      parsedAt: '2026-08-01T10:00:00.000Z',
      queuedAt: null,
      processedAt: null,
      parseErrorCode: null,
      parseErrorDetails: null,
      originalFilename: null,
      contentHash: null,
      jobAttempts: 0,
      version: 1,
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      validation: null,
    }));
    const pending = [
      {
        key: 'registry:aaa',
        itemId: '99999999-9999-9999-9999-999999999999',
        bundleId: '88888888-8888-8888-8888-888888888888',
        portalGroupId: null,
        filename: 'ждёт-разбора.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        siteName: 'ЖК Тест',
        expectedDate: null,
        createdAt: '2026-08-01T09:00:00.000Z',
        state: 'awaiting_processing',
      },
    ];
    apiState.response = { items: docs, total: 2064, pendingFiles: pending, pendingTotal: 1 };

    renderPage('/documents');

    // Документ №50 остаётся на странице: раньше строка принятого файла
    // делала dataSource длиннее pageSize, и antd срезал последние документы.
    expect(await screen.findByText('Д-49')).toBeTruthy();
    expect(screen.getByText('ждёт-разбора.pdf')).toBeTruthy();
  });
});
