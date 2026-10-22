// @vitest-environment jsdom
/**
 * Окно «Разбор письма» на узком экране.
 *
 * Левая колонка решения — 380px, рядом предпросмотр документа. На телефоне
 * окно шириной ≈330px резало обе колонки (тело с overflow: hidden), поэтому
 * ниже порога портала они идут стопкой и прокручивается всё тело. На
 * десктопе раскладка прежняя: две колонки, высота задана окну.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MailMessageBody, MailMessageDetail } from '@matcheck/contracts';

let breakpoint: 'mobile' | 'desktop' = 'desktop';

vi.mock('../../shared/hooks/useBreakpoint', () => ({
  useBreakpoint: () => breakpoint,
}));

const message: MailMessageDetail = {
  id: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222',
  accountName: 'Заявки',
  fromAddress: 'supplier@example.ru',
  subject: 'УПД по поставке',
  receivedAt: '2026-10-20T08:00:00Z',
  status: 'quarantined',
  rejectReason: null,
  suggestedSiteId: null,
  suggestedSiteCode: null,
  suggestedSiteName: null,
  attachmentsCount: 1,
  attachmentsTotal: 1,
  bundleId: null,
  lastError: null,
  createdAt: '2026-10-20T08:00:00Z',
  attachments: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      idx: 0,
      filename: 'upd.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1000,
      state: 'kept',
      skipReason: null,
      willBeIngested: true,
    },
  ],
};

vi.mock('../../services/api', () => ({
  api: {
    get: vi.fn((url: string) => {
      if (url.endsWith('/body')) {
        return Promise.resolve({ text: 'Объект — ЖК Примавера', truncated: false } satisfies MailMessageBody);
      }
      if (url.startsWith('/mail/messages/')) return Promise.resolve(message);
      return Promise.resolve({ items: [], total: 0 });
    }),
    post: vi.fn(),
  },
  apiDownload: vi.fn(),
}));

const { MailReviewModal } = await import('./MailReviewModal');

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

async function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MailReviewModal messageId={message.id} onClose={() => {}} />
    </QueryClientProvider>,
  );
  // Колонка решения — родитель подписи «Текст письма» (Typography.Text
  // рисует её как span > strong), ряд — родитель колонки.
  const label = await screen.findByText('Текст письма');
  const column = label.closest('.ant-typography')!.parentElement!;
  const row = column.parentElement!;
  const body = column.closest<HTMLElement>('.ant-modal-body')!;
  const content = column.closest<HTMLElement>('.ant-modal-content')!;
  return { column, row, body, content };
}

describe('Разбор письма: раскладка по ширине экрана', () => {
  it('на телефоне решение и документ идут стопкой, прокручивается тело', async () => {
    breakpoint = 'mobile';
    const { column, row, body, content } = await show();
    expect(row.style.flexDirection).toBe('column');
    expect(column.style.width).toBe('100%');
    expect(body.style.overflow).toBe('auto');
    // Высота по содержимому: фиксированные 85vh на телефоне отрезали бы стопку.
    expect(content.style.height).toBe('');
  });

  it('на десктопе — две колонки, высота задана окну', async () => {
    breakpoint = 'desktop';
    const { column, row, body, content } = await show();
    expect(row.style.flexDirection).toBe('row');
    expect(column.style.width).toBe('380px');
    expect(body.style.overflow).toBe('hidden');
    expect(content.style.height).toBe('85vh');
  });
});
