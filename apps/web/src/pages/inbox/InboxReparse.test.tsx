// @vitest-environment jsdom
/**
 * Кнопка «Распознать повторно» в списке документов: кому она видна.
 *
 * Право `documents.list:reparse` в дефолте не выдано никому — его включает
 * администратор в «Ролях». Значит гейт на кнопке обязан работать, иначе роль
 * увидит действие, которое сервер ей не разрешит: маршрут отбивает не своих
 * ролью, а не молчаливым no-op.
 *
 * Проверяется именно то, чего не поймает typecheck: `tsc --noEmit` в apps/web
 * анализирует пустой проект (tsconfig.json со списком `files: []`).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageAction, PageId } from '@matcheck/contracts';
import type { ReactElement } from 'react';

const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({
    can: (page: PageId, action: PageAction) => permissions.allowed.has(`${page}:${action}`),
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

const DOC = {
  id: '11111111-1111-1111-1111-111111111111',
  kind: 'upd',
  direction: 'inbound',
  status: 'parsed',
  origin: 'manual_pdf',
  docNumber: 'УТ-42',
  docDate: '2026-07-10',
  expectedDate: null,
  totalSum: '1000.00',
  vatSum: null,
  supplierId: null,
  supplierName: 'ООО «Поставщик»',
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
  parsedAt: '2026-07-10T10:00:00.000Z',
  queuedAt: null,
  processedAt: null,
  parseErrorCode: null,
  parseErrorDetails: null,
  originalFilename: 'doc.pdf',
  contentHash: null,
  jobAttempts: 0,
  version: 1,
  createdAt: '2026-07-10T10:00:00.000Z',
  updatedAt: '2026-07-10T10:00:00.000Z',
  validation: null,
};

vi.mock('../../services/api', () => ({
  api: {
    get: async () => ({ items: [DOC], total: 1 }),
    post: async () => ({ ok: true }),
    patch: async () => ({}),
    delete: async () => ({}),
  },
  apiDownload: async () => undefined,
  ApiError: class extends Error {},
}));

const { default: InboxPage } = await import('./Inbox');

function renderPage(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui: ReactElement = (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/documents']}>
        <InboxPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(ui);
}

beforeEach(() => {
  permissions.allowed = new Set(['documents.list:view']);
});
afterEach(cleanup);

describe('Документы: кнопка «Распознать повторно»', () => {
  it('без права её нет', async () => {
    renderPage();

    expect(await screen.findByText('УТ-42')).toBeTruthy();
    expect(screen.queryByTitle('Распознать повторно')).toBeNull();
  });

  it('с правом она появляется у строки', async () => {
    permissions.allowed.add('documents.list:reparse');
    renderPage();

    expect(await screen.findByText('УТ-42')).toBeTruthy();
    expect(await screen.findByTitle('Распознать повторно')).toBeTruthy();
  });
});
