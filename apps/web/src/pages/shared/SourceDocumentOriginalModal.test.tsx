// @vitest-environment jsdom
/**
 * Окно «Оригинал документа» поверх карточки операции.
 *
 * Состояния разведены намеренно: «документ закрыт для роли» и «карточка
 * открылась, но файла у неё нет» — разные новости для человека, и сводить их
 * к одной строке нельзя. Отдельно от них живёт сбой запроса, который можно
 * повторить.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceDocumentDetail } from '@matcheck/contracts';
import type { ReactElement } from 'react';

class ApiErrorMock extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const apiGet = vi.fn();

vi.mock('../../services/api', () => ({
  api: { get: apiGet },
  apiDownload: vi.fn(),
  ApiError: ApiErrorMock,
}));

const { SourceDocumentOriginalModal } = await import('./SourceDocumentOriginalModal');

const detail = (over: Partial<SourceDocumentDetail> = {}): SourceDocumentDetail =>
  ({
    id: 'd1',
    kind: 'upd',
    docNumber: 'БС-32139',
    docDate: '2026-09-14',
    totalSum: '34560.00',
    vatSum: '5760.00',
    attachments: [
      {
        id: 'a1',
        s3Key: 'k/1.jpg',
        filename: 'IMG_20260915_084249_144.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 797246,
        role: 'original',
      },
    ],
    items: [
      {
        id: 'i1',
        lineNo: 1,
        nameRaw: 'Труба профильная 40х20',
        qty: '12',
        unit: 'шт',
        price: '2880.00',
        sum: '34560.00',
        vatRate: '20',
        inventoryNumber: null,
      },
    ],
    ...over,
  }) as unknown as SourceDocumentDetail;

function show(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/**
 * После размонтирования в мок прилетает «хвостовой» вызов без аргумента
 * (react-query добирает запрос уже без url). Отвечаем на него пустым успехом:
 * иначе в тестах отказа его отклонённый промис остаётся без слушателя и
 * роняет соседний тест как unhandled rejection.
 */
const answer = (byUrl: (url: string) => Promise<unknown>) => (url?: unknown) =>
  typeof url === 'string' ? byUrl(url) : Promise.resolve({ attachments: [] });

const props = {
  documentId: 'd1',
  open: true,
  onClose: () => {},
  afterClose: () => {},
};

beforeEach(() => apiGet.mockReset());
afterEach(cleanup);

describe('SourceDocumentOriginalModal', () => {
  it('показывает оригинал и позиции документа рядом', async () => {
    apiGet.mockImplementation(
      answer((url) =>
        url.endsWith('/pages') ? Promise.resolve({ attachments: [] }) : Promise.resolve(detail()),
      ),
    );

    show(<SourceDocumentOriginalModal {...props} />);

    await waitFor(() => expect(screen.getByText(/IMG_20260915_084249_144.jpg/)).toBeTruthy());
    // Заголовок называет документ, чтобы окно не путалось с соседним.
    expect(screen.getByText(/Оригинал · УПД БС-32139/)).toBeTruthy();
    expect(screen.getByText(/Позиции документа \(1\)/)).toBeTruthy();
    expect(screen.getByText('Труба профильная 40х20')).toBeTruthy();
    expect(document.body.querySelector('img')!.getAttribute('src')).toContain(
      '/source-documents/d1/file/raw?attachmentId=a1',
    );
    // Карточка берётся по id документа — общий с разделом «Документы» ключ.
    expect(apiGet).toHaveBeenCalledWith('/source-documents/d1');
  });

  it('карточка без вложений — честное «оригинал недоступен», а не пустая панель', async () => {
    apiGet.mockImplementation(
      answer((url) =>
        url.endsWith('/pages')
          ? Promise.resolve({ attachments: [] })
          : Promise.resolve(detail({ attachments: [] })),
      ),
    );

    show(<SourceDocumentOriginalModal {...props} />);

    await waitFor(() => expect(screen.getByText('Оригинал файла недоступен')).toBeTruthy());
    // Позиции при этом на месте: сверять по ним всё ещё можно.
    expect(screen.getByText('Труба профильная 40х20')).toBeTruthy();
  });

  it('404 и 403 читаются как «документ недоступен»', async () => {
    apiGet.mockImplementation(
      answer(() => Promise.reject(new ApiErrorMock(404, 'not_found', 'not found'))),
    );

    show(<SourceDocumentOriginalModal {...props} />);

    await waitFor(() => expect(screen.getByText('Документ недоступен')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Повторить/ })).toBeNull();
  });

  it('сбой запроса предлагает повторить, а не выдаёт себя за «нет документа»', async () => {
    apiGet.mockImplementation(
      answer(() => Promise.reject(new ApiErrorMock(500, 'internal', 'boom'))),
    );

    show(<SourceDocumentOriginalModal {...props} />);

    await waitFor(() => expect(screen.getByText('Не удалось загрузить документ')).toBeTruthy());
    expect(screen.getByRole('button', { name: /Повторить/ })).toBeTruthy();
    expect(screen.queryByText('Документ недоступен')).toBeNull();
  });

  it('пока документ не выбран — запроса нет', () => {
    show(<SourceDocumentOriginalModal {...props} documentId={null} open={false} />);
    expect(apiGet).not.toHaveBeenCalled();
  });
});
