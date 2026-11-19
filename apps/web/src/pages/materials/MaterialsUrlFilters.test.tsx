// @vitest-environment jsdom
/**
 * История поступлений: фильтры живут в адресе и переживают уход со страницы.
 *
 * Раньше они были в useState: открыл приёмку из строки, закрыл — История
 * открывалась с нуля. Здесь проверяется, что адрес восстанавливает выдачу (и
 * страница не сбрасывается при заходе), а каждое действие пишет адрес ОДНИМ
 * изменением — два setSearchParams от одного снимка затирали бы друг друга.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGlobalFiltersStore } from '../../stores/globalFilters';

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
let searches: string[] = [];

function LocationProbe() {
  const { search } = useLocation();
  if (searches[searches.length - 1] !== search) searches.push(search);
  return null;
}

function renderPage(initial: string): void {
  apiState.urls = [];
  searches = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/materials${initial}`]}>
        <MaterialsPage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function movementQueries(): URLSearchParams[] {
  return apiState.urls
    .filter((u) => u.startsWith('/reports/movements?'))
    .map((u) => new URLSearchParams(u.slice(u.indexOf('?') + 1)));
}

function current(): URLSearchParams {
  return new URLSearchParams(searches[searches.length - 1] ?? '');
}

beforeEach(() => {
  useGlobalFiltersStore.getState().reset();
});

afterEach(async () => {
  cleanup();
  await client?.cancelQueries();
  client?.clear();
  client = null;
});

describe('История поступлений: фильтры в адресе', () => {
  it('адрес восстанавливает выдачу, страница при заходе не сбрасывается', async () => {
    renderPage(
      '?page=3&dfrom=2026-11-01&dto=2026-11-10&docFrom=2026-10-01&type=shipment&q=цемент&sort=sum&order=asc',
    );
    await waitFor(() => expect(movementQueries().length).toBeGreaterThan(0));
    const qs = movementQueries()[0]!;
    expect(qs.get('offset')).toBe('200');
    expect(qs.get('dateFrom')).toBe('2026-11-01T00:00:00.000Z');
    expect(qs.get('dateTo')).toBe('2026-11-10T23:59:59.999Z');
    expect(qs.get('docDateFrom')).toBe('2026-10-01');
    expect(qs.get('type')).toBe('shipment');
    expect(qs.get('q')).toBe('цемент');
    expect(qs.get('sort')).toBe('sum');
    expect(qs.get('order')).toBe('asc');
    // Ни одного запроса с первой страницы: эффект «setPage(1) при смене
    // фильтров» стирал восстановленную страницу.
    expect(movementQueries().every((q) => q.get('offset') === '200')).toBe(true);
    expect(searches).toHaveLength(1);
  });

  it('без параметров — только «Поступление», как раньше', async () => {
    renderPage('');
    await waitFor(() => expect(movementQueries().length).toBeGreaterThan(0));
    expect(movementQueries()[0]!.get('type')).toBe('intake');
  });

  it('мусор в датах не уходит на сервер', async () => {
    renderPage('?dfrom=yesterday&docTo=2026-13');
    await waitFor(() => expect(movementQueries().length).toBeGreaterThan(0));
    const qs = movementQueries()[0]!;
    expect(qs.has('dateFrom')).toBe(false);
    expect(qs.has('docDateTo')).toBe(false);
  });

  it('сортировка — одно изменение адреса со всеми полями', async () => {
    renderPage('?page=2&type=shipment');
    await waitFor(() => expect(movementQueries().length).toBeGreaterThan(0));
    const cells = Array.from(document.querySelectorAll<HTMLElement>('.ant-table-thead th'));
    fireEvent.click(cells.find((th) => th.textContent?.trim() === 'Сумма')!);
    await waitFor(() => expect(searches).toHaveLength(2));
    const q = current();
    expect(q.get('sort')).toBe('sum');
    expect(q.get('order')).toBe('asc');
    // Тип из воронки не потерялся рядом с сортировкой, страница — с первой.
    expect(q.get('type')).toBe('shipment');
    expect(q.has('page')).toBe(false);
  });

  it('«Сбросить» снимает фильтры и страницу, но не сортировку', async () => {
    renderPage('?site=s1&q=x&dfrom=2026-11-01&type=all&sort=sum&order=asc&page=2');
    await waitFor(() => expect(movementQueries().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /Сбросить/ }));
    await waitFor(() => expect(searches).toHaveLength(2));
    expect(current().toString()).toBe('sort=sum&order=asc');
    expect((screen.getByRole('button', { name: /Сбросить/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('общие объект и подрядчик подхватываются одним изменением адреса', async () => {
    useGlobalFiltersStore.getState().set({ siteIds: ['s1'], contractorIds: ['c1'] });
    renderPage('?page=4');
    await waitFor(() => expect(searches).toHaveLength(2));
    const q = current();
    expect(q.get('site')).toBe('s1');
    expect(q.get('contractor')).toBe('c1');
    expect(q.has('page')).toBe(false);
  });
});
