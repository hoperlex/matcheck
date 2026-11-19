// @vitest-environment jsdom
/**
 * Подсветка строки, где количество и цена похожи на переставленные.
 *
 * Данные фото через серверную сверку не проходят — подозрение считается прямо
 * в компоненте, и проверить его можно только рендером. Заодно фиксируется
 * показ полной точности цены: округление до копеек прячет ровно тот признак,
 * из-за которого строка и помечена (боевой УПД № 848: «66,294 м² × 8 114,75 ₽»
 * распозналось как qty 8114.75 / price 66.294).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoRecognition } from '@matcheck/contracts';
import type { ReactElement } from 'react';

const recognition: PhotoRecognition = {
  status: 'done',
  items: [
    {
      nameRaw: 'Профнастил С21',
      qty: 200,
      unit: 'м2',
      price: 451.68,
      sum: 90336.07,
      invNumber: null,
    },
    {
      nameRaw: 'Триплекс 6 Crystal Vision',
      qty: 8114.75,
      unit: 'м2',
      price: 66.294,
      sum: 537959.51,
      invNumber: null,
    },
  ],
  docForm: 'other',
  docNumber: '848',
  docDate: '2026-08-18',
  totalSum: 656310.6,
  confidence: 0.95,
  model: 'gemini',
  errorMessage: null,
  recognizedAt: '2026-08-18T12:59:22.000Z',
  // Прежний путь: сумма БЕЗ налога, НДС не извлекается, сверки нет.
  parser: 'photo_v1',
  vatSum: null,
  itemsCount: null,
  validation: null,
};

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  download: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  api: { get: apiMock.get, post: apiMock.post },
  apiDownload: apiMock.download,
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

vi.mock('../../lib/thumbQueue', () => ({
  enqueueFullLoad: <T,>(fn: () => Promise<T>) => fn(),
}));

let breakpoint: 'mobile' | 'desktop' = 'desktop';

vi.mock('../../shared/hooks/useBreakpoint', () => ({
  useBreakpoint: () => breakpoint,
}));

const { PhotoDocumentPreview } = await import('./PhotoDocumentPreview');
const { ApiError } = await import('../../services/api');

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrap(node: ReactElement, qc: QueryClient = newClient()): ReactElement {
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

const PHOTO_A = '11111111-1111-1111-1111-111111111111';
const PHOTO_B = '22222222-2222-2222-2222-222222222222';
const notFound = () => new ApiError(404, 'not_found', 'нет распознавания');

beforeEach(() => {
  apiMock.get.mockReset().mockResolvedValue(recognition);
  apiMock.post.mockReset().mockResolvedValue(recognition);
  apiMock.download.mockReset().mockResolvedValue({ blob: new Blob([''], { type: 'image/jpeg' }) });
});

afterEach(() => {
  cleanup();
  breakpoint = 'desktop';
});

describe('PhotoDocumentPreview — подозрительная строка', () => {
  it('цена показывается со всеми знаками, а обычная строка — как раньше', async () => {
    render(
      wrap(
        <PhotoDocumentPreview
          open
          onClose={() => {}}
          photoId="11111111-1111-1111-1111-111111111111"
          imageSrc="blob:thumb"
        />,
      ),
    );

    // Подозрительная строка: 66.294 остаётся при своих трёх знаках.
    expect(await screen.findByText(/66,294/)).toBeTruthy();
    // Обычная строка не трогается: копейки как обычно.
    expect(screen.getByText(/451,68/)).toBeTruthy();
  });

  it('строка помечена подсказкой про перепутанные колонки', async () => {
    render(
      wrap(
        <PhotoDocumentPreview
          open
          onClose={() => {}}
          photoId="11111111-1111-1111-1111-111111111111"
          imageSrc="blob:thumb"
        />,
      ),
    );
    const marked = await screen.findByText(/66,294/);
    // Tooltip antd вешает подсказку на обёртку строки — проверяем сам факт
    // выделения: у подозрительной ячейки есть подчёркивание-намёк.
    expect(marked.getAttribute('style')).toContain('dashed');
  });
});

describe('PhotoDocumentPreview — зум скана', () => {
  it('зум — сразу в панели: маски «Открыть для зума» нет, колесо масштабирует, ESC закрывает окно', async () => {
    // Раскладки в jsdom нет — размер панели зума задаём руками.
    const restore = stubPanelSize(800, 600);
    try {
      const onClose = vi.fn();
      render(
        wrap(
          <PhotoDocumentPreview open onClose={onClose} photoId={PHOTO_A} imageSrc="blob:thumb" />,
        ),
      );
      await screen.findByText(/451,68/);
      expect(screen.queryByText('Открыть для зума')).toBeNull();
      expect(document.querySelector('.ant-image')).toBeNull();

      const img = screen.getByAltText('Документ');
      Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 1536 });
      Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 2048 });
      fireEvent.load(img);
      const panel = img.closest<HTMLElement>('[data-zoomable-image]')!;
      const wheel = new WheelEvent('wheel', {
        deltaY: -300,
        clientX: 400,
        clientY: 300,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        panel.dispatchEvent(wheel);
      });
      // Колесо съедено зумом — без единого клика по фото.
      expect(wheel.defaultPrevented).toBe(true);
      expect(screen.getByLabelText('Масштаб').textContent).not.toBe('100%');

      // Второго окна поверх больше нет — ESC закрывает само окно документа.
      fireEvent.keyDown(document.querySelector('.ant-modal-wrap')!, {
        key: 'Escape',
        keyCode: 27,
        which: 27,
      });
      expect(onClose).toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

describe('PhotoDocumentPreview — листание документов', () => {
  it('стрелки и ←/→ листают; на краях неактивны; в поле ввода стрелки не перехватываются', async () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const { rerender } = render(
      wrap(
        <PhotoDocumentPreview
          open
          onClose={() => {}}
          photoId={PHOTO_A}
          imageSrc="blob:thumb"
          nav={{ index: 1, total: 3, onPrev, onNext }}
        />,
      ),
    );
    expect(await screen.findByText('Документ 2 из 3')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Предыдущий документ'));
    expect(onPrev).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(onNext).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(onPrev).toHaveBeenCalledTimes(2);

    // Фокус в поле ввода: стрелки — его, не листания.
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    input.remove();
    // С модификатором — тоже мимо (браузерные сочетания).
    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true });
    expect(onNext).toHaveBeenCalledTimes(1);

    const qc = newClient();
    rerender(
      wrap(
        <PhotoDocumentPreview
          open
          onClose={() => {}}
          photoId={PHOTO_A}
          imageSrc="blob:thumb"
          nav={{ index: 0, total: 3, onPrev, onNext }}
        />,
        qc,
      ),
    );
    const prev = await screen.findByLabelText('Предыдущий документ');
    expect((prev as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(onPrev).toHaveBeenCalledTimes(2);
  });

  it('без nav стрелок и счётчика нет', async () => {
    render(
      wrap(
        <PhotoDocumentPreview open onClose={() => {}} photoId={PHOTO_A} imageSrc="blob:thumb" />,
      ),
    );
    await screen.findByText(/451,68/);
    expect(screen.queryByLabelText('Следующий документ')).toBeNull();
    expect(screen.queryByText(/^Документ \d+ из/)).toBeNull();
  });

  it('ушли с нераспознанного фото раньше паузы — LLM по нему не запускается', async () => {
    apiMock.get.mockImplementation(async (path: string) => {
      if (path.includes(PHOTO_A) || path.includes(PHOTO_B)) throw notFound();
      return recognition;
    });
    const qc = newClient();
    const { rerender } = render(
      wrap(<PhotoDocumentPreview open onClose={() => {}} photoId={PHOTO_A} />, qc),
    );
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith(`/photos/${PHOTO_A}/recognition`));
    // Дождались ответа 404 по A — пошёл отсчёт паузы. Листаем дальше сразу.
    await waitFor(() =>
      expect(qc.getQueryState(['photo-recognition', PHOTO_A])?.status).toBe('success'),
    );
    rerender(wrap(<PhotoDocumentPreview open onClose={() => {}} photoId={PHOTO_B} />, qc));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        `/photos/${PHOTO_B}/recognize`,
        {},
        expect.anything(),
      ),
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(apiMock.post).not.toHaveBeenCalledWith(
      `/photos/${PHOTO_A}/recognize`,
      expect.anything(),
      expect.anything(),
    );
  });

  it('ответ распознавания по прежнему фото не попадает в кэш нового', async () => {
    const recognitionA = { ...recognition, docNumber: 'A-1' };
    const recognitionB = { ...recognition, docNumber: 'B-2' };
    let resolveA!: (v: PhotoRecognition) => void;
    apiMock.get.mockImplementation(async (path: string) => {
      if (path.includes(PHOTO_A)) throw notFound();
      return recognitionB;
    });
    apiMock.post.mockImplementation(
      (path: string) =>
        new Promise<PhotoRecognition>((resolve) => {
          if (path.includes(PHOTO_A)) resolveA = resolve;
          else resolve(recognitionB);
        }),
    );
    const qc = newClient();
    const { rerender } = render(
      wrap(<PhotoDocumentPreview open onClose={() => {}} photoId={PHOTO_A} />, qc),
    );
    // Распознавание A ушло и висит.
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        `/photos/${PHOTO_A}/recognize`,
        {},
        expect.anything(),
      ),
    );
    rerender(wrap(<PhotoDocumentPreview open onClose={() => {}} photoId={PHOTO_B} />, qc));
    await waitFor(() =>
      expect(qc.getQueryData<PhotoRecognition>(['photo-recognition', PHOTO_B])?.docNumber).toBe(
        'B-2',
      ),
    );
    // Ответ по A пришёл уже после перехода на B.
    await act(async () => {
      resolveA(recognitionA);
    });
    expect(qc.getQueryData<PhotoRecognition>(['photo-recognition', PHOTO_B])?.docNumber).toBe(
      'B-2',
    );
    expect(qc.getQueryData<PhotoRecognition>(['photo-recognition', PHOTO_A])?.docNumber).toBe(
      'A-1',
    );
  });

  it('пролистанный недокачанный оригинал обрывается', async () => {
    const signals = new Map<string, AbortSignal>();
    apiMock.download.mockImplementation(
      (path: string, opts?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const signal = opts?.signal;
          if (signal) signals.set(path, signal);
          if (path.includes(PHOTO_B)) {
            resolve({ blob: new Blob(['b'], { type: 'image/jpeg' }) });
            return;
          }
          // Оригинал A «качается» долго — до отмены.
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const qc = newClient();
    const { rerender } = render(
      wrap(<PhotoDocumentPreview open onClose={() => {}} photoId={PHOTO_A} />, qc),
    );
    await waitFor(() => expect(signals.has(`/photos/${PHOTO_A}/content`)).toBe(true));
    rerender(wrap(<PhotoDocumentPreview open onClose={() => {}} photoId={PHOTO_B} />, qc));
    await waitFor(() => expect(signals.get(`/photos/${PHOTO_A}/content`)?.aborted).toBe(true));
    // Отменённый запрос не оставил в кэше ни данных, ни ошибки.
    expect(qc.getQueryState(['photo-blob', PHOTO_A, 'full'])?.status).not.toBe('error');
    expect(signals.get(`/photos/${PHOTO_B}/content`)?.aborted).toBe(false);
  });

  it('«оригинал на экране» сообщается только для оригинала, не для миниатюры', async () => {
    let resolveFull!: (v: { blob: Blob }) => void;
    apiMock.download.mockImplementation(() => new Promise((resolve) => (resolveFull = resolve)));
    const onOriginalDisplayed = vi.fn();
    render(
      wrap(
        <PhotoDocumentPreview
          open
          onClose={() => {}}
          photoId={PHOTO_A}
          imageSrc="blob:thumb"
          onOriginalDisplayed={onOriginalDisplayed}
        />,
      ),
    );
    const thumb = await screen.findByAltText('Документ');
    expect(thumb.getAttribute('src')).toBe('blob:thumb');
    fireEvent.load(thumb);
    expect(onOriginalDisplayed).not.toHaveBeenCalled();

    await act(async () => {
      resolveFull({ blob: new Blob(['full'], { type: 'image/jpeg' }) });
    });
    const full = await waitFor(() => {
      const el = screen.getByAltText('Документ');
      expect(el.getAttribute('src')).not.toBe('blob:thumb');
      return el;
    });
    fireEvent.load(full);
    expect(onOriginalDisplayed).toHaveBeenCalledWith(PHOTO_A);
  });

  // Правый клик по снимку — меню картинки браузера («Сохранить картинку
  // как…»). Пока на экране миниатюра, меню закрыто: иначе сохранилась бы она.
  it('меню картинки — только у оригинала, у миниатюры закрыто', async () => {
    let resolveFull!: (v: { blob: Blob }) => void;
    apiMock.download.mockImplementation(() => new Promise((resolve) => (resolveFull = resolve)));
    render(
      wrap(
        <PhotoDocumentPreview open onClose={() => {}} photoId={PHOTO_A} imageSrc="blob:thumb" />,
      ),
    );
    const thumb = await screen.findByAltText('Документ');
    expect(thumb.getAttribute('src')).toBe('blob:thumb');
    expect(thumb.style.pointerEvents).toBe('none');

    await act(async () => {
      resolveFull({ blob: new Blob(['full'], { type: 'image/jpeg' }) });
    });
    await waitFor(() => {
      const el = screen.getByAltText('Документ');
      expect(el.getAttribute('src')).not.toBe('blob:thumb');
      expect(el.style.pointerEvents).toBe('auto');
    });
  });

  it('оригинал не загрузился — миниатюра на экране, меню картинки закрыто', async () => {
    apiMock.download.mockRejectedValue(new Error('s3_unavailable'));
    render(
      wrap(
        <PhotoDocumentPreview open onClose={() => {}} photoId={PHOTO_A} imageSrc="blob:thumb" />,
      ),
    );
    // У запроса оригинала свои два повтора (0,5 с + 1 с) — ждём дольше дефолта.
    await screen.findByText('Оригинал не загрузился — показана миниатюра', undefined, {
      timeout: 4000,
    });
    const thumb = screen.getByAltText('Документ');
    expect(thumb.getAttribute('src')).toBe('blob:thumb');
    expect(thumb.style.pointerEvents).toBe('none');
  });
});

/** clientWidth/clientHeight панели зума — в jsdom они нулевые. */
function stubPanelSize(w: number, h: number): () => void {
  const restore: Array<() => void> = [];
  for (const [prop, value] of [
    ['clientWidth', w],
    ['clientHeight', h],
  ] as const) {
    const prev = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute('data-zoomable-image') ? value : 0;
      },
    });
    restore.push(() => {
      if (prev) Object.defineProperty(HTMLElement.prototype, prop, prev);
    });
  }
  return () => restore.forEach((r) => r());
}

describe('PhotoDocumentPreview — телефон', () => {
  // Таблица распознавания не уже 360px, и рядом с ней фото на телефоне
  // схлопывалось до нулевой ширины. Ниже порога портала — стопка.
  it('фото и таблица идут стопкой, таблица прокручивается вбок', async () => {
    breakpoint = 'mobile';
    render(
      wrap(
        <PhotoDocumentPreview
          open
          onClose={() => {}}
          photoId="11111111-1111-1111-1111-111111111111"
          imageSrc="blob:thumb"
        />,
      ),
    );
    const cell = await screen.findByText(/451,68/);
    const body = cell.closest<HTMLElement>('.ant-modal-body')!;
    expect(body.style.flexDirection).toBe('column');
    expect(body.style.overflow).toBe('auto');
    expect(cell.closest<HTMLElement>('table')!.style.width).toBe('528px');
  });

  it('на десктопе — рядом, ширина таблицы по панели', async () => {
    render(
      wrap(
        <PhotoDocumentPreview
          open
          onClose={() => {}}
          photoId="11111111-1111-1111-1111-111111111111"
          imageSrc="blob:thumb"
        />,
      ),
    );
    const cell = await screen.findByText(/451,68/);
    expect(cell.closest<HTMLElement>('.ant-modal-body')!.style.flexDirection).toBe('row');
    expect(cell.closest<HTMLElement>('table')!.style.width).toBe('');
  });
});
