// @vitest-environment jsdom
/**
 * Выбор подрядчика из справочника заказчика.
 *
 * Тест держит контракт с маршрутом from-directory: контекст формы уходит в тело
 * (по нему сервер решает, какое право проверять), без контекста тело прежнее —
 * окна загрузки и карточка документа проверяются старой ячейкой. Родитель
 * получает операционного контрагента целиком, чтобы сразу показать его имя.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const CC = '11111111-1111-4111-8111-111111111111';
const OP = '22222222-2222-4222-8222-222222222222';

const directory = [{ id: CC, inn: '7714468005', name: 'ООО «СУ - 90»', aliases: [] }];
const resolved = { id: OP, inn: '7714468005', name: 'ООО «СУ - 90»', isContractor: true };

const get = vi.fn((url: string) => {
  if (url.startsWith('/customer-counterparties')) {
    return Promise.resolve({ items: directory, total: directory.length });
  }
  return Promise.reject(new Error(`unexpected GET ${url}`));
});
const post = vi.fn((_url: string, _body?: unknown) => Promise.resolve(resolved));

vi.mock('../../services/api', () => ({
  api: {
    get: (...args: unknown[]) => get(...(args as [string])),
    post: (...args: unknown[]) => post(...(args as [string, unknown])),
  },
  ApiError: class ApiError extends Error {},
}));

const { CustomerCounterpartySelect } = await import('./CustomerCounterpartySelect');

function wrap(node: ReactElement): ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

async function choose(): Promise<void> {
  const box = await screen.findByRole('combobox');
  fireEvent.mouseDown(box);
  fireEvent.click(await screen.findByTitle('ООО «СУ - 90» (ИНН 7714468005)'));
}

afterEach(() => {
  cleanup();
  get.mockClear();
  post.mockClear();
});

describe('CustomerCounterpartySelect', () => {
  it('контекст формы уходит в тело, родитель получает контрагента', async () => {
    const onChange = vi.fn();
    render(
      wrap(<CustomerCounterpartySelect value={null} onChange={onChange} context="delivery" />),
    );

    await choose();

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(OP, resolved));
    expect(post).toHaveBeenCalledWith('/counterparties/from-directory', {
      customerCounterpartyId: CC,
      context: 'delivery',
    });
  });

  it('без контекста тело прежнее', async () => {
    const onChange = vi.fn();
    render(wrap(<CustomerCounterpartySelect value={null} onChange={onChange} />));

    await choose();

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith('/counterparties/from-directory', {
      customerCounterpartyId: CC,
    });
  });

  it('выбранный показывается по имени из displayName, а не служебным id', async () => {
    render(
      wrap(
        <CustomerCounterpartySelect
          value={OP}
          displayName="ООО «СУ - 90»"
          onChange={vi.fn()}
          context="shipment"
        />,
      ),
    );
    expect(await screen.findByTitle('ООО «СУ - 90»')).toBeTruthy();
    expect(screen.queryByText(OP)).toBeNull();
  });
});
