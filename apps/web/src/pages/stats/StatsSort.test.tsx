// @vitest-environment jsdom
/**
 * Статистика: клик по заголовку включает серверную сортировку.
 *
 * antd отдаёт в onChange `columnKey = column.key`, а у числовых колонок был
 * только dataIndex — клик по «Приёмкам» приходил с пустым ключом и сортировку
 * снимал. «№» слал sort=__num__, которого нет в enum сервера, — ответ 400.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
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
let searches: string[] = [];

function LocationProbe() {
  const { search } = useLocation();
  if (searches[searches.length - 1] !== search) searches.push(search);
  return null;
}

function renderPage(initial = ''): void {
  apiState.urls = [];
  searches = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/stats${initial}`]}>
        <StatsPage />
        <LocationProbe />
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

describe('Статистика: фильтры в адресе', () => {
  it('период, объекты, страница и сортировка восстанавливаются из адреса', async () => {
    renderPage(
      '?site=s1,s2&inspector=i1&dfrom=2026-10-01&dto=2026-10-19&page=3&sort=sumNoVat&order=asc',
    );
    await waitFor(() => expect(statsQueries().length).toBeGreaterThan(0));
    const qs = statsQueries()[0]!;
    expect(qs.get('siteId')).toBe('s1,s2');
    expect(qs.get('inspectorId')).toBe('i1');
    expect(qs.get('offset')).toBe('200');
    expect(qs.get('sort')).toBe('sumNoVat');
    expect(qs.get('order')).toBe('asc');
    expect(qs.has('dateFrom')).toBe(true);
    expect(qs.has('dateTo')).toBe(true);
    // Страница при заходе не сбрасывается и адрес не переписывается.
    expect(statsQueries().every((q) => q.get('offset') === '200')).toBe(true);
    expect(searches).toHaveLength(1);
    const summary = apiState.urls.find((u) => u.startsWith('/reports/stats-summary'))!;
    const summaryQs = new URLSearchParams(summary.slice(summary.indexOf('?') + 1));
    expect(summaryQs.get('from')).toBe('2026-10-01');
    expect(summaryQs.get('to')).toBe('2026-10-19');
  });

  it('мусор в периоде не уходит на сервер', async () => {
    renderPage('?dfrom=вчера');
    await waitFor(() => expect(statsQueries().length).toBeGreaterThan(0));
    expect(statsQueries()[0]!.has('dateFrom')).toBe(false);
  });

  it('«Сбросить» снимает фильтры и страницу, сортировку оставляет', async () => {
    renderPage('?site=s1&dfrom=2026-10-01&page=2&sort=date&order=asc');
    await waitFor(() => expect(statsQueries().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /Сбросить/ }));
    await waitFor(() => expect(searches).toHaveLength(2));
    expect(searches[1]).toBe('?sort=date&order=asc');
  });
});
