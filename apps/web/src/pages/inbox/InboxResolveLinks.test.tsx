// @vitest-environment jsdom
/**
 * Ссылки действий в колонке «Статус» списка документов.
 *
 * С июня 2026 «дополнить» (распознано частично) и «проверить» (суммы не
 * сходятся) звали тот же колбэк, что и «разрешить», и открывали окно
 * «Дубликат УПД», где ни одна кнопка к такому документу не применима. Теперь:
 *   * «разрешить» — окно решения по копии-дубликату;
 *   * «дополнить» и «проверить» — карточка документа.
 * И все они — по праву «Документы × Редактировать», а не «всем, кроме
 * подрядчика»: мониторинг получает их галочкой в «Ролях».
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageAction, PageId } from '@matcheck/contracts';

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
    selector({ user: { id: 'u1', role: 'monitor' } }),
}));

const BASE = {
  kind: 'transport_waybill',
  direction: 'inbound',
  origin: 'manual_pdf',
  docDate: '2026-11-11',
  expectedDate: '2026-11-12',
  totalSum: null,
  vatSum: null,
  supplierId: null,
  supplierName: null,
  contractorId: null,
  contractorName: null,
  recipientId: null,
  recipientName: null,
  recipientMolId: null,
  recipientMolName: null,
  siteId: 'site-1',
  siteName: 'ЖК ДОМ 56',
  llmProviderId: null,
  llmConfidence: null,
  parsedAt: '2026-11-12T06:35:00.000Z',
  queuedAt: null,
  processedAt: null,
  contentHash: null,
  jobAttempts: 0,
  version: 1,
  createdAt: '2026-11-12T06:35:00.000Z',
  updatedAt: '2026-11-12T06:35:00.000Z',
  validation: null,
};
const DUP = {
  ...BASE,
  id: '22222222-2222-2222-2222-222222222222',
  status: 'needs_resolution',
  docNumber: 'НФНФ-000538',
  parseErrorCode: 'duplicate_upd',
  parseErrorDetails: { existingId: '11111111-1111-1111-1111-111111111111' },
  originalFilename: 'IMG_0002.pdf',
};
const PARTIAL = {
  ...BASE,
  id: '44444444-4444-4444-4444-444444444444',
  status: 'needs_resolution',
  docNumber: null,
  parseErrorCode: 'partial_parse',
  parseErrorDetails: { missing: ['docNumber'] },
  originalFilename: 'IMG_0004.pdf',
};

const getSpy = vi.hoisted(() => vi.fn());
vi.mock('../../services/api', () => ({
  api: {
    get: async (url: string) => {
      getSpy(url);
      if (url === '/suppliers/filter-options') return { items: [] };
      if (url.startsWith('/source-documents?') || url === '/source-documents') {
        return { items: [DUP, PARTIAL], total: 2 };
      }
      // Карточка и окно в этом тесте не дорисовываются — важно, куда пошли.
      return new Promise(() => undefined);
    },
    post: async () => ({ ok: true }),
    patch: async () => ({}),
    delete: async () => ({}),
  },
  apiDownload: async () => undefined,
  ApiError: class extends Error {},
}));

const { default: InboxPage } = await import('./Inbox');

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/documents']}>
        <InboxPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  permissions.allowed = new Set(['documents.list:view']);
  getSpy.mockClear();
});
afterEach(cleanup);

describe('Документы: «разрешить» и «дополнить»', () => {
  it('без права «Редактировать» ссылок нет', async () => {
    renderPage();
    expect(await screen.findByText('НФНФ-000538')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'разрешить' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'дополнить' })).toBeNull();
  });

  it('«дополнить» открывает карточку документа, а не окно дубликата', async () => {
    permissions.allowed.add('documents.list:edit');
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'дополнить' }));
    await waitFor(() => expect(getSpy).toHaveBeenCalledWith(`/source-documents/${PARTIAL.id}`));
    expect(getSpy.mock.calls.some(([u]) => String(u).includes('duplicate-info'))).toBe(false);
  });

  it('«разрешить» открывает окно решения по копии', async () => {
    permissions.allowed.add('documents.list:edit');
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'разрешить' }));
    await waitFor(() =>
      expect(getSpy).toHaveBeenCalledWith(`/source-documents/${DUP.id}/duplicate-info`),
    );
    expect(await screen.findByText('Дубликат документа')).toBeTruthy();
  });
});
