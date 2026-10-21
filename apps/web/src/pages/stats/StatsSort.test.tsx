// @vitest-environment jsdom
/**
 * Статистика: клик по заголовку включает серверную сортировку.
 *
 * antd отдаёт в onChange `columnKey = column.key`, а у числовых колонок был
 * только dataIndex — клик по «Приёмкам» приходил с пустым ключом и сортировку
 * снимал. «№» слал sort=__num__, которого нет в enum сервера, — ответ 400.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiState = vi.hoisted(() => ({ urls: [] as string[] }));

vi.mock('../../services/api', () => ({
  api: {
    get: async (url: string) => {
      apiState.urls.push(url);
      // Шапке сводки нужен период; остальное ей не читается (виджеты заглушены).
      if (url.startsWith('/reports/stats-summary')) {
        return { range: { from: '2026-10-01', to: '2026-10-19', days: 19 } };
      }
      return { items: [], total: 0 };
    },
  },
  ApiError: class extends Error {},
}));

// Сводка и графики — не предмет теста, а @ant-design/plots в jsdom не нужен.
vi.mock('./widgets/KpiStrip', () => ({ KpiStrip: () => null }));
vi.mock('./widgets/DailyBarChart', () => ({ DailyBarChart: () => null }));
vi.mock('./widgets/AttentionCounters', () => ({ AttentionCounters: () => null }));

const { default: StatsPage } = await import('./StatsPage');

let client: QueryClient | null = null;

function renderPage(): void {
  apiState.urls = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StatsPage />
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

function statsQueries(): URLSearchParams[] {
  return apiState.urls
    .filter((u) => u.startsWith('/reports/inspector-stats?'))
    .map((u) => new URLSearchParams(u.slice(u.indexOf('?') + 1)));
}

async function expectSort(sort: string, order: string): Promise<void> {
  await waitFor(() => {
    const hit = statsQueries().some((qs) => qs.get('sort') === sort && qs.get('order') === order);
    if (!hit) throw new Error(`нет запроса sort=${sort}&order=${order}`);
  });
}

describe('Статистика: серверная сортировка', () => {
  it('колонка с одним dataIndex («Приёмки») включает сортировку', async () => {
    renderPage();
    await waitFor(() => expect(statsQueries().length).toBeGreaterThan(0));
    fireEvent.click(headerCell('Приёмки'));
    await expectSort('deliveries', 'asc');
  });

  it('«Объект» сортирует по site', async () => {
    renderPage();
    await waitFor(() => expect(statsQueries().length).toBeGreaterThan(0));
    fireEvent.click(headerCell('Объект'));
    await expectSort('site', 'asc');
  });

  it('«№» не сортируется и не шлёт sort=__num__', async () => {
    renderPage();
    await waitFor(() => expect(statsQueries().length).toBeGreaterThan(0));
    const num = headerCell('№');
    expect(num.classList.contains('ant-table-column-has-sorters')).toBe(false);
    fireEvent.click(num);
    expect(statsQueries().some((qs) => qs.get('sort') === '__num__')).toBe(false);
  });
});
