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
const { api } = await import('../../services/api');

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
    expect(screen.getByText(/сумма строк меньше итога на 16 838,11/)).toBeTruthy();
    // warnings: подозрение на код ОКЕИ в количестве.
    expect(screen.getByText(/код единицы измерения из бланка/)).toBeTruthy();
  });

  it('форма документа названа по-русски', async () => {
    renderPreview();

    expect(await screen.findByText('УПД')).toBeTruthy();
  });
});

/** Приёмка 22246, фото 1 этапа: «1б» прочитано как 16, УПД № 1820 — 204 пог.м. */
const stage1Recognition: PhotoRecognition = {
  ...updRecognition,
  docNumber: '1820',
  items: [
    {
      nameRaw: 'Швеллер 10П',
      qty: 16,
      unit: 'пог. м',
      price: 632.79,
      sum: 123508.52,
      rowNo: 1,
      vatRate: 22,
      vatSum: 22299.48,
    },
    {
      nameRaw: 'Швеллер 8П',
      qty: 300,
      unit: 'пог. м',
      price: 552.46,
      sum: 202200,
      rowNo: 2,
      vatRate: 22,
      vatSum: 36462.3,
    },
  ],
  validation: {
    hasMismatch: true,
    checkedAt: '2026-10-28T06:27:54.000Z',
    checks: [
      {
        name: 'row_vat_rate',
        scope: { row: 1 },
        expected: 22299.48,
        actual: 22272.03,
        diff: 27.45,
        tolerance: 22.27,
        ok: false,
      },
    ],
  },
  linkedDocument: {
    id: '469ac4ba-9b48-48a8-9201-8a32781868f0',
    docNumber: '1820',
    matchedBy: 'number',
    items: [
      { rowNo: 1, nameRaw: 'Швеллер 10П', qty: 204, unit: 'пог.м' },
      { rowNo: 2, nameRaw: 'Швеллер 8П', qty: 300, unit: 'пог.м' },
    ],
  },
};

describe('PhotoDocumentPreview — сверка с УПД операции', () => {
  it('строка, расходящаяся с УПД, красная и показывает значение из УПД', async () => {
    vi.mocked(api.get).mockResolvedValueOnce(stage1Recognition);
    renderPreview();

    const hint = await screen.findByText('в УПД: 204 пог.м');
    expect(hint.closest('tr')?.getAttribute('style')).toContain('background: rgb(255, 241, 240)');
    expect(
      screen.getByText('Сверено с УПД №1820 этой приёмки: строк 2, расходится 1'),
    ).toBeTruthy();
    // Вторая строка совпала с УПД («пог. м» = «пог.м») — без пометки.
    expect(screen.queryByText('в УПД: 300 пог.м')).toBeNull();
  });
});
