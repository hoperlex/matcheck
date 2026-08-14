// @vitest-environment jsdom
/**
 * Тип документа в админке промптов.
 *
 * До этой правки `DOC_KIND_LABEL` не содержал ключа `m15`, хотя
 * `PromptDocKindSchema` его знает: обе версии промпта накладных М-15
 * отображались в таблице с ПУСТЫМ типом, а в форме создания такого варианта не
 * было вовсе. Активация промпта — ручное действие оператора («Администрирование
 * → Промпты»), и выбирать версию между одинаково безымянными строками нельзя.
 *
 * Проверяется именно то, чего не поймает typecheck: `tsc --noEmit` в apps/web
 * анализирует пустой проект (tsconfig.json со списком `files: []`), поэтому
 * пропущенный ключ Record'а там не виден.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({ can: () => true, hasCapability: () => true, loading: false }),
}));

const PROMPTS = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    docKind: 'upd',
    name: 'default v8',
    content: 'текст УПД',
    isActive: true,
    createdAt: '2026-06-19T13:48:09.726Z',
    updatedAt: '2026-06-19T13:48:09.726Z',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    docKind: 'm15',
    name: 'default v1',
    content: 'текст М-15',
    isActive: true,
    createdAt: '2026-06-30T14:54:35.301Z',
    updatedAt: '2026-06-30T14:54:35.301Z',
  },
  {
    id: '33333333-3333-3333-3333-333333333333',
    docKind: 'm15',
    name: 'default v2',
    content: 'текст М-15 + грузополучатель',
    isActive: false,
    createdAt: '2026-08-14T10:00:00.000Z',
    updatedAt: '2026-08-14T10:00:00.000Z',
  },
];

vi.mock('../../services/api', () => ({
  api: {
    get: async () => PROMPTS,
    post: async () => ({}),
    patch: async () => ({}),
  },
}));

const { default: AdminPromptsPage } = await import('./Prompts');

function renderPage(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui: ReactElement = (
    <QueryClientProvider client={client}>
      <AdminPromptsPage />
    </QueryClientProvider>
  );
  return render(ui);
}

afterEach(cleanup);

describe('Администрирование → Промпты: тип М-15', () => {
  it('строки промптов М-15 показаны с читаемым типом, а не пустой ячейкой', async () => {
    renderPage();

    // Обе версии промпта накладных должны быть видны и различимы по имени.
    expect(await screen.findByText('default v1')).toBeTruthy();
    expect(await screen.findByText('default v2')).toBeTruthy();

    const labels = await screen.findAllByText(/Накладная М-15/);
    expect(labels.length).toBeGreaterThanOrEqual(2);
  });

  it('тип УПД по-прежнему подписан (анти-регресс существующих строк)', async () => {
    renderPage();
    expect(await screen.findByText('default v8')).toBeTruthy();
    expect((await screen.findAllByText(/УПД \(PDF\)/)).length).toBeGreaterThanOrEqual(1);
  });
});
