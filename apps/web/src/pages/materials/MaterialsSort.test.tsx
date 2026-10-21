// @vitest-environment jsdom
/**
 * История поступлений: клик по заголовку включает серверную сортировку.
 *
 * Было два дефекта сразу. antd отдаёт в onChange `columnKey = column.key`, а у
 * большинства колонок был только dataIndex — клик приходил с пустым ключом и
 * сортировку снимал. «Объект» же нёс key 'site', которого нет в enum сервера,
 * и «№» слал sort=__num__ — оба запроса сервер отклонял с 400.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiState = vi.hoisted(() => ({ urls: [] as string[] }));

vi.mock('../../services/api', () => ({
  api: {
    get: async (url: string) => {
      apiState.urls.push(url);
      return { items: [], total: 0 };
    },
    post: async () => ({}),
    patch: async () => ({}),
    delete: async () => ({}),
  },
  ApiError: class extends Error {},
}));

const { default: MaterialsPage } = await import('./MaterialsPage');

let client: QueryClient | null = null;

function renderPage(): void {
  apiState.urls = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MaterialsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  cleanup();
  await client?.cancelQueries();
  client?.clear();
  client = null;
});

function headerCell(title: string): HTMLElement {
  const cells = Array.from(document.querySelectorAll<HTMLElement>('.ant-table-thead th'));
  const cell = cells.find((th) => th.textContent?.trim() === title);
  if (!cell) throw new Error(`нет колонки «${title}»`);
  return cell;
}

function movementQueries(): URLSearchParams[] {
  return apiState.urls
    .filter((u) => u.startsWith('/reports/movements?'))
    .map((u) => new URLSearchParams(u.slice(u.indexOf('?') + 1)));
}

async function expectSort(sort: string, order: string): Promise<void> {
  await waitFor(() => {
    const hit = movementQueries().some(
      (qs) => qs.get('sort') === sort && qs.get('order') === order,
    );
    if (!hit) throw new Error(`нет запроса sort=${sort}&order=${order}`);
  });
}

describe('История поступлений: серверная сортировка', () => {
  it('«Объект» сортирует по siteName — полю из enum сервера', async () => {
    renderPage();
    await waitFor(() => expect(movementQueries().length).toBeGreaterThan(0));
    fireEvent.click(headerCell('Объект'));
    await expectSort('siteName', 'asc');
  });

  it('колонка с одним dataIndex («Сумма») включает сортировку, а не снимает её', async () => {
    renderPage();
    await waitFor(() => expect(movementQueries().length).toBeGreaterThan(0));
    fireEvent.click(headerCell('Сумма'));
    await expectSort('sum', 'asc');
    fireEvent.click(headerCell('Сумма'));
    await expectSort('sum', 'desc');
  });

  it('«№» не сортируется и не шлёт sort=__num__', async () => {
    renderPage();
    await waitFor(() => expect(movementQueries().length).toBeGreaterThan(0));
    const num = headerCell('№');
    expect(num.classList.contains('ant-table-column-has-sorters')).toBe(false);
    fireEvent.click(num);
    expect(movementQueries().some((qs) => qs.get('sort') === '__num__')).toBe(false);
  });
});
