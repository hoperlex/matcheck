// @vitest-environment jsdom
/**
 * Фото, разобранное УПД-веткой, показывается иначе, чем разобранное прежним
 * промптом.
 *
 * Причина не косметическая: у 'upd_vision' сумма строки — стоимость С налогом
 * (графа 9 бланка), у 'photo_v1' — без него (графа 5). Одна и та же подпись
 * «Сумма» над двумя разными базами занижала бы строку ровно на ставку, а
 * пустая колонка НДС у прежнего пути читалась бы как «налога в документе нет».
 *
 * Здесь же проверяется, что сверка показывается ОБЕИМИ группами: расхождение
 * строки с итогом живёт в checks, а подозрение на съехавшую колонку — в
 * warnings, и показать только вторые значит скрыть доказанное расхождение.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PhotoRecognition } from '@matcheck/contracts';
import type { ReactElement } from 'react';

const updRecognition: PhotoRecognition = {
  status: 'done',
  items: [
    {
      nameRaw: 'Пена монтажная Империал 65 UNIVERSAL',
      qty: 249,
      unit: 'шт',
      invNumber: null,
      price: 307.38,
      sum: 93375,
      rowNo: 1,
      vatRate: 22,
      vatSum: 16838.11,
    },
  ],
  docForm: 'upd',
  docNumber: '2788',
  docDate: '2026-08-31',
  totalSum: 93375,
  confidence: 0.95,
  model: 'gemini',
  errorMessage: null,
  recognizedAt: '2026-09-01T05:18:14.000Z',
  parser: 'upd_vision',
  vatSum: 16838.11,
  itemsCount: null,
  validation: {
    hasMismatch: true,
    checkedAt: '2026-09-01T05:18:14.000Z',
    checks: [
      {
        name: 'sum_total',
        scope: 'document',
        expected: 93375,
        actual: 76536.89,
        diff: 16838.11,
        tolerance: 0.01,
        ok: false,
      },
    ],
    warnings: [{ name: 'unit_code_as_qty', scope: { row: 1 } }],
  },
};

vi.mock('../../services/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue(updRecognition),
    post: vi.fn().mockResolvedValue(updRecognition),
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

function renderPreview() {
  render(
    wrap(
      <PhotoDocumentPreview
        open
        onClose={() => {}}
        photoId="22222222-2222-2222-2222-222222222222"
        imageSrc="blob:thumb"
      />,
    ),
  );
}

afterEach(cleanup);

describe('PhotoDocumentPreview — фото, разобранное УПД-веткой', () => {
  it('сумма подписана как «с НДС», а налог виден отдельной колонкой', async () => {
    renderPreview();

    expect(await screen.findByText('Сумма с НДС')).toBeTruthy();
    expect(screen.getByText('НДС')).toBeTruthy();
    // Налог документа — чипом в шапке, рядом с итогом.
    expect(screen.getByText(/НДС: 16 838,11/)).toBeTruthy();
  });

  it('показывает и расхождение, и подозрение — обе группы сверки', async () => {
    renderPreview();

    // checks: доказанное расхождение, с объяснением знака разницы.
    expect(await screen.findByText(/сумма позиций vs итог документа/)).toBeTruthy();
    expect(screen.getByText(/не хватает 16 838,11/)).toBeTruthy();
    // warnings: подозрение на код ОКЕИ в количестве.
    expect(screen.getByText(/код единицы измерения из бланка/)).toBeTruthy();
  });

  it('форма документа названа по-русски', async () => {
    renderPreview();

    expect(await screen.findByText('УПД')).toBeTruthy();
  });
});
