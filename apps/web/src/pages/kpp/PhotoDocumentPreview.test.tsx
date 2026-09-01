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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PhotoRecognition } from '@matcheck/contracts';
import type { ReactElement } from 'react';

const recognition: PhotoRecognition = {
  status: 'done',
  items: [
    { nameRaw: 'Профнастил С21', qty: 200, unit: 'м2', price: 451.68, sum: 90336.07, invNumber: null },
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

vi.mock('../../services/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue(recognition),
    post: vi.fn().mockResolvedValue(recognition),
  },
  apiDownload: vi.fn().mockResolvedValue(new Blob([''], { type: 'image/jpeg' })),
  ApiError: class ApiError extends Error {
    status = 500;
  },
}));

vi.mock('../../lib/thumbQueue', () => ({
  enqueueFullLoad: <T,>(fn: () => Promise<T>) => fn(),
}));

const { PhotoDocumentPreview } = await import('./PhotoDocumentPreview');

function wrap(node: ReactElement): ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

afterEach(cleanup);

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
  it('клик по фото разворачивает просмотрщик, а ESC гасит только его', async () => {
    const onClose = vi.fn();
    render(
      wrap(
        <PhotoDocumentPreview
          open
          onClose={onClose}
          photoId="11111111-1111-1111-1111-111111111111"
          imageSrc="blob:thumb"
        />,
      ),
    );

    // Подсказка при наведении — это ещё не доказательство: antd держит маску в
    // разметке всегда и прячет её только стилями. Поэтому кликаем по-настоящему
    // и ждём сам оверлей. (Перекрытие клика оверлеями — бейджем размеров,
    // Spin'ом — так не проверяется: в jsdom нет layout и pointer-events, это
    // только для живого браузера.)
    expect(await screen.findByText('Открыть для зума')).toBeTruthy();
    expect(document.querySelector('.ant-image-preview-wrap')).toBeNull();
    const imageWrapper = document.querySelector('.ant-image');
    expect(imageWrapper).toBeTruthy();
    fireEvent.click(imageWrapper as Element);

    const previewWrap = await waitFor(() => {
      const el = document.querySelector('.ant-image-preview-wrap');
      expect(el).toBeTruthy();
      return el as Element;
    });

    // ESC внутри просмотрщика не должен доходить до модалки под ним: rc-dialog
    // просмотрщика гасит событие (stopPropagation), иначе одно нажатие
    // закрывало бы сразу два окна — split-view схлопывалась бы вместе с зумом.
    fireEvent.keyDown(previewWrap, { key: 'Escape', keyCode: 27, which: 27 });
    expect(onClose).not.toHaveBeenCalled();
    // Сама split-view на месте: таблица позиций никуда не делась.
    expect(screen.getByText(/451,68/)).toBeTruthy();
  });
});
