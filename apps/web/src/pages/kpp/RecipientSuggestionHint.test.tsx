// @vitest-environment jsdom
/**
 * Подсказка «Получатель» в карточке приёмки (приёмка 21514).
 *
 * Тест держит связку: что уходит на сервер при «Подставить», что карточка
 * получает в ответ, и чего она НЕ получает — ответа для другой приёмки и
 * контрагента с чужим ИНН.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type * as Antd from 'antd';

const DELIVERY = '22222222-2222-4222-8222-222222222222';
const OTHER_DELIVERY = '33333333-3333-4333-8333-333333333333';
const SUGGESTION = {
  customerCounterpartyId: 'cc-ss',
  name: 'ООО "Стройсервис"',
  inn: '9728074050',
  from: 'buyer',
  sourceDocumentId: '11111111-1111-4111-8111-111111111111',
};

const get = vi.fn((_url: string) => Promise.resolve({ suggestion: SUGGESTION }));
let resolvePost: (v: unknown) => void = () => undefined;
const post = vi.fn(
  (_url: string, _body?: unknown) =>
    new Promise((resolve) => {
      resolvePost = resolve;
    }),
);
const warning = vi.fn();

vi.mock('../../services/api', () => ({
  api: {
    get: (...args: unknown[]) => get(...(args as [string])),
    post: (...args: unknown[]) => post(...(args as [string, unknown])),
  },
  ApiError: class ApiError extends Error {},
}));
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof Antd>();
  return { ...actual, message: { ...actual.message, warning, error: vi.fn() } };
});

const { RecipientSuggestionHint } = await import('./RecipientSuggestionHint');

function wrap(node: ReactElement): ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  get.mockClear();
  post.mockClear();
  warning.mockClear();
});

describe('RecipientSuggestionHint', () => {
  it('«Подставить» — from-directory с context=delivery, карточка получает контрагента', async () => {
    const onApply = vi.fn();
    render(
      wrap(
        <RecipientSuggestionHint
          deliveryId={DELIVERY}
          sourceDocumentIds={['d1']}
          onApply={onApply}
        />,
      ),
    );

    const button = await screen.findByRole('button', { name: 'Подставить' });
    expect(screen.getByText(/по документу: ООО "Стройсервис"/)).toBeTruthy();
    expect(get).toHaveBeenCalledWith(`/deliveries/${DELIVERY}/recipient-suggestion`);

    fireEvent.click(button);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/counterparties/from-directory', {
        customerCounterpartyId: 'cc-ss',
        context: 'delivery',
      }),
    );
    // Пока запрос в полёте — второй клик невозможен.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Подставить' }).hasAttribute('disabled')).toBe(
        true,
      ),
    );

    const cp = { id: 'op-1', name: 'ООО «СТРОЙСЕРВИС»', inn: '9728074050' };
    await act(async () => resolvePost(cp));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(cp));
  });

  it('ответ для другой приёмки не применяется', async () => {
    const onApply = vi.fn();
    // Один клиент на оба рендера: компонент тот же, меняется только приёмка.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <RecipientSuggestionHint
          deliveryId={DELIVERY}
          sourceDocumentIds={['d1']}
          onApply={onApply}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Подставить' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    // Карточку переключили на другую приёмку, пока запрос был в полёте.
    rerender(
      <QueryClientProvider client={qc}>
        <RecipientSuggestionHint
          deliveryId={OTHER_DELIVERY}
          sourceDocumentIds={['d2']}
          onApply={onApply}
        />
      </QueryClientProvider>,
    );
    await act(async () =>
      resolvePost({ id: 'op-1', name: 'ООО «СТРОЙСЕРВИС»', inn: '9728074050' }),
    );
    expect(onApply).not.toHaveBeenCalled();
  });

  it('контрагент с чужим ИНН не подставляется — просьба выбрать вручную', async () => {
    const onApply = vi.fn();
    render(
      wrap(
        <RecipientSuggestionHint
          deliveryId={DELIVERY}
          sourceDocumentIds={['d1']}
          onApply={onApply}
        />,
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Подставить' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await act(async () => resolvePost({ id: 'op-x', name: 'Чужой', inn: '7709938569' }));

    await waitFor(() =>
      expect(warning).toHaveBeenCalledWith('Не удалось подставить — выберите подрядчика вручную'),
    );
    expect(onApply).not.toHaveBeenCalled();
  });

  it('подсказки нет — ничего не рисуется', async () => {
    get.mockResolvedValueOnce({ suggestion: null } as never);
    const { container } = render(
      wrap(
        <RecipientSuggestionHint
          deliveryId={DELIVERY}
          sourceDocumentIds={['d1']}
          onApply={vi.fn()}
        />,
      ),
    );
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
