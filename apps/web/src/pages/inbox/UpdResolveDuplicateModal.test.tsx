// @vitest-environment jsdom
/**
 * Окно решения по копии-дубликату: кнопки рисуются по ответу сервера
 * (duplicate-info), «Оставить» требует подтверждения и уносит комментарий,
 * «Изменить копию» открывает карточку.
 *
 * Правило «одна карточка на планшете» считает сервер; окно обязано только не
 * давать нажать то, что сервер откажет, и объяснить почему.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceDuplicateInfo } from '@matcheck/contracts';

const calls = vi.hoisted(() => ({
  info: null as unknown,
  post: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  api: {
    get: async () => calls.info,
    post: async (url: string, body: unknown) => calls.post(url, body),
  },
  ApiError: class extends Error {},
}));

const { UpdResolveDuplicateModal } = await import('./UpdResolveDuplicateModal');

const COPY_ID = '22222222-2222-2222-2222-222222222222';
const ORIGINAL_ID = '11111111-1111-1111-1111-111111111111';

function info(over: Partial<SourceDuplicateInfo> = {}): SourceDuplicateInfo {
  return {
    id: COPY_ID,
    supplierName: 'ООО «АЛЮПРОМ»',
    docNumber: 'НФНФ-000538',
    docDate: '2026-11-11',
    expectedDate: '2026-11-12',
    siteName: 'ЖК ДОМ 56',
    duplicateCheck: { verdict: 'confirmed', detail: 'совпали шапка и все позиции (14)' },
    existingId: ORIGINAL_ID,
    existingMissing: false,
    siblings: [
      {
        id: ORIGINAL_ID,
        status: 'parsed',
        parseErrorCode: null,
        docNumber: 'НФНФ-000538',
        expectedDate: '2026-11-11',
        siteName: 'ЖК ДОМ 56',
        isExisting: true,
        accepted: true,
        operations: [
          {
            kind: 'delivery',
            id: '33333333-3333-3333-3333-333333333333',
            displayId: 24827,
            statusLabel: 'Подтверждена МОЛ',
            at: '2026-11-11T14:35:50.144Z',
            pendingDeletion: false,
          },
        ],
        edoLinks: 0,
      },
    ],
    keep: { allowed: true, reason: null, message: null, missing: [], blockingIds: [] },
    replace: { allowed: false, reason: 'original_used' },
    ...over,
  };
}

function renderModal(onOpenDocument = vi.fn(), onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UpdResolveDuplicateModal
        id={COPY_ID}
        open
        onClose={onClose}
        onOpenDocument={onOpenDocument}
      />
    </QueryClientProvider>,
  );
  return { onOpenDocument, onClose };
}

const button = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

beforeEach(() => {
  calls.info = info();
  calls.post = vi.fn().mockResolvedValue({ status: 'parsed', expectedDate: '2026-11-12', siteId: 's' });
});
afterEach(cleanup);

describe('окно дубликата', () => {
  it('показывает, где уже принят документ, и гасит «Заменить» с объяснением', async () => {
    renderModal();
    expect(await screen.findByText(/приёмка №24827/)).toBeTruthy();
    expect(screen.getByText(/совпали шапка и все позиции/)).toBeTruthy();
    expect(button(/Заменить/).disabled).toBe(true);
    expect(screen.getByText(/заменить его нельзя/)).toBeTruthy();
    expect(button(/Оставить как новую поставку/).disabled).toBe(false);
  });

  it('«Оставить» — через подтверждение, с комментарием', async () => {
    renderModal();
    await screen.findByText(/приёмка №24827/);
    fireEvent.change(screen.getByPlaceholderText(/Комментарий/), {
      target: { value: 'вторая машина' },
    });
    fireEvent.click(button(/Оставить как новую поставку/));
    // Подтверждение называет приёмку, где документ уже принят.
    expect(await screen.findByText(/Оформить ещё одну поставку/)).toBeTruthy();
    expect(calls.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Оставить' }));
    await waitFor(() =>
      expect(calls.post).toHaveBeenCalledWith(`/source-documents/${COPY_ID}/resolve-duplicate`, {
        action: 'keep',
        comment: 'вторая машина',
      }),
    );
  });

  it('оригинал не принят — «Оставить» недоступна, причина видна', async () => {
    calls.info = info({
      siblings: [{ ...info().siblings[0]!, accepted: false, operations: [] }],
      keep: {
        allowed: false,
        reason: 'sibling_not_accepted',
        message: 'Такой же документ ещё не принят — его карточка уже есть на планшете.',
        missing: [],
        blockingIds: [ORIGINAL_ID],
      },
      replace: { allowed: true, reason: null },
    });
    renderModal();
    expect(await screen.findByText(/не принят — карточка на планшете/)).toBeTruthy();
    expect(button(/Оставить как новую поставку/).disabled).toBe(true);
    expect(screen.getByText(/его карточка уже есть на планшете/)).toBeTruthy();
    expect(button(/Заменить/).disabled).toBe(false);
  });

  it('неполная копия — перечислено, чего не хватает', async () => {
    calls.info = info({
      keep: {
        allowed: false,
        reason: 'incomplete',
        message: 'Копия распознана не полностью — допишите в карточке копии номер и материалы, затем повторите.',
        missing: ['itemsIncomplete'],
        blockingIds: [],
      },
    });
    renderModal();
    expect(await screen.findByText(/Не хватает: не все позиции/)).toBeTruthy();
  });

  it('«Изменить копию» открывает карточку копии', async () => {
    const { onOpenDocument } = renderModal();
    await screen.findByText(/приёмка №24827/);
    fireEvent.click(button(/Изменить копию/));
    expect(onOpenDocument).toHaveBeenCalledWith(COPY_ID);
  });
});
