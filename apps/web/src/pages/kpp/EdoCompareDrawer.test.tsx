// @vitest-environment jsdom
/**
 * Панель сверки УПД из ЭДО: PDF слева, фото приёмки справа.
 *
 * Проверяется то, что легко сломать незаметно: object URL освобождается,
 * ошибка сервера доходит до человека текстом и оставляет путь к XML, а пустой
 * фильтр по типу фото не утверждает, что документов не снимали.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';

class ApiErrorMock extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const apiDownload = vi.fn();
const saveBlobAsFile = vi.fn();

vi.mock('../../services/api', () => ({
  apiDownload,
  saveBlobAsFile,
  ApiError: ApiErrorMock,
}));

const { EdoCompareDrawer } = await import('./EdoCompareDrawer');
type Props = ComponentProps<typeof EdoCompareDrawer>;
type Photo = Props['photos'][number];

const PDF_PATH = '/deliveries/d1/edo-candidates/export/c1/pdf';

const candidate = {
  id: 'c1',
  docNumber: '201/211153699',
  docDate: '2026-10-05',
  supplierName: 'АО «ТД Электротехмонтаж»',
};

const photo = (id: string, over: Partial<Photo> = {}): Photo => ({
  id,
  kind: 'document',
  stage: 'before',
  takenAt: `2026-10-12T08:0${id.length}:00Z`,
  uploadedAt: '2026-10-12T08:10:00Z',
  ...over,
});

/** По умолчанию: PDF — PDF, фото — jpeg; переопределяется по пути. */
function serve(overrides: Record<string, () => Promise<unknown>> = {}) {
  apiDownload.mockImplementation((path: string) => {
    const custom = overrides[path];
    if (custom) return custom();
    if (path === PDF_PATH) {
      return Promise.resolve({
        blob: new Blob(['%PDF-1.7'], { type: 'application/pdf' }),
        filename: 'УПД.pdf',
      });
    }
    return Promise.resolve({ blob: new Blob(['jpg'], { type: 'image/jpeg' }), filename: '' });
  });
}

function show(over: Partial<Props> = {}) {
  const props: Props = {
    open: true,
    deliveryId: 'd1',
    candidate,
    photos: [photo('p1')],
    onClose: vi.fn(),
    afterClose: vi.fn(),
    onOpenXml: vi.fn(),
    ...over,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <EdoCompareDrawer {...props} />
    </QueryClientProvider>,
  );
  return { props, view };
}

beforeEach(() => {
  apiDownload.mockReset();
  saveBlobAsFile.mockReset();
  serve();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PDF', () => {
  it('просит PDF этого кандидата и показывает его в iframe по blob-ссылке', async () => {
    show();
    const frame = await screen.findByTitle('УПД 201/211153699');
    expect(frame.getAttribute('src')).toMatch(/^blob:.*#toolbar=1&navpanes=0$/);
    expect(apiDownload).toHaveBeenCalledWith(PDF_PATH);
    expect(screen.getByText(/УПД 201\/211153699 от 05\.10\.2026/)).toBeTruthy();
  });

  it('ссылку на PDF освобождает при закрытии панели', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const { view } = show();
    const frame = await screen.findByTitle('УПД 201/211153699');
    const url = frame.getAttribute('src')!.split('#')[0];
    view.unmount();
    expect(revoke).toHaveBeenCalledWith(url);
  });

  it('отказ сервера: его текст и путь к XML, повтор — только где он имеет смысл', async () => {
    serve({
      [PDF_PATH]: () =>
        Promise.reject(
          new ApiErrorMock(
            413,
            'http_error',
            'Документ слишком большой для просмотра — откройте XML',
          ),
        ),
    });
    const { props } = show();
    expect(
      await screen.findByText('Документ слишком большой для просмотра — откройте XML'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
    expect(screen.queryByTitle('УПД 201/211153699')).toBeNull();
    // «Открыть XML» есть и в шапке панели, и в сообщении — работают обе.
    const buttons = screen.getAllByRole('button', { name: 'Открыть XML' });
    expect(buttons.length).toBe(2);
    fireEvent.click(buttons[1]!);
    expect(props.onOpenXml).toHaveBeenCalledTimes(1);
  });

  it('сервер занят — можно повторить', async () => {
    let calls = 0;
    serve({
      [PDF_PATH]: () =>
        ++calls === 1
          ? Promise.reject(new ApiErrorMock(503, 'http_error', 'Сервер занят'))
          : Promise.resolve({
              blob: new Blob(['%PDF'], { type: 'application/pdf' }),
              filename: '',
            }),
    });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Повторить' }));
    expect(await screen.findByTitle('УПД 201/211153699')).toBeTruthy();
  });

  it('пришёл не PDF — не встраиваем, говорим об этом', async () => {
    serve({
      [PDF_PATH]: () =>
        Promise.resolve({ blob: new Blob(['<html>'], { type: 'text/html' }), filename: '' }),
    });
    show();
    expect(await screen.findByText('Сервер вернул не PDF — откройте XML')).toBeTruthy();
    expect(screen.queryByTitle('УПД 201/211153699')).toBeNull();
  });

  it('без кандидата — только фото, PDF не запрашивается', async () => {
    show({ candidate: null });
    expect(screen.getByText('Фото приёмки')).toBeTruthy();
    await screen.findByRole('button', { name: 'Фото 1' });
    expect(apiDownload).not.toHaveBeenCalledWith(PDF_PATH);
    expect(screen.queryByRole('button', { name: 'Открыть XML' })).toBeNull();
  });
});

describe('фото приёмки', () => {
  it('по умолчанию — документы, переключатель на все; сначала 1 этап', async () => {
    show({
      photos: [
        photo('after-doc', { stage: 'after' }),
        photo('cargo', { kind: 'cargo' }),
        photo('before-doc'),
      ],
    });
    expect(screen.getByText('Документы (2)')).toBeTruthy();
    expect(screen.getByText('Все фото (3)')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Фото \d$/ })).toHaveLength(2);
    // Выбрано первое — документ 1 этапа.
    expect(await screen.findByText(/^1 Этап · .* · Документ$/)).toBeTruthy();

    fireEvent.click(screen.getByText('Все фото (3)'));
    expect(screen.getAllByRole('button', { name: /^Фото \d$/ })).toHaveLength(3);
  });

  it('нет фото с типом «Документ» — показываем все и не утверждаем, что документов не снимали', async () => {
    show({ photos: [photo('a', { kind: 'cargo' }), photo('b', { kind: 'cargo' })] });
    expect(
      screen.getByText('Фото с типом «Документ» нет — показаны все фото приёмки.'),
    ).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Фото \d$/ })).toHaveLength(2);
    // Все «Груз/машина» — это тип по умолчанию у старых записей: не подписываем.
    const caption = await screen.findByText(/^1 Этап · /);
    expect(caption.textContent).not.toContain('Груз/машина');
  });

  it('незагруженные фото не показываются; нет загруженных — своя надпись', () => {
    show({ photos: [photo('orphan', { uploadedAt: null })] });
    expect(screen.getByText('У приёмки нет загруженных фото')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Фото \d$/ })).toBeNull();
  });

  it('HEIC браузер не покажет — плашка и скачивание вместо сломанной картинки', async () => {
    serve({
      '/photos/p1/content': () =>
        Promise.resolve({ blob: new Blob(['heic'], { type: 'image/heic' }), filename: '' }),
    });
    show();
    expect(
      await screen.findByText('Формат HEIC браузер не показывает — скачайте файл.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Скачать' }));
    expect(saveBlobAsFile).toHaveBeenCalledWith(expect.any(Blob), 'photo-p1.heic');
  });

  it('фото грузится через прокси API: миниатюра и выбранный оригинал', async () => {
    show();
    await waitFor(() => {
      expect(apiDownload).toHaveBeenCalledWith('/photos/p1/content?thumb=true');
      expect(apiDownload).toHaveBeenCalledWith('/photos/p1/content');
    });
  });
});

describe('закрытие', () => {
  it('крестик закрывает панель через onClose', () => {
    const { props } = show();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
