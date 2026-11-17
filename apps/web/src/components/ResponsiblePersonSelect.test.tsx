// @vitest-environment jsdom
/**
 * Выбор МОЛ в документах: в списке все активные МОЛ — зеркало ФОТ и ручные
 * (кладовщики), без фильтра source=fot. Создать МОЛ из списка нельзя: только
 * в Справочники → МОЛ.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const FOT = { id: '11111111-1111-4111-8111-111111111111', fullName: 'Начальник Участка' };
const MANUAL = { id: '22222222-2222-4222-8222-222222222222', fullName: 'Пиронов Ф.Б.' };
const mk = (p: { id: string; fullName: string }) => ({
  ...p,
  phone: null,
  position: null,
  isActive: true,
  createdAt: '2026-11-17T00:00:00Z',
  updatedAt: '2026-11-17T00:00:00Z',
});

const get = vi.fn((_url: string) => Promise.resolve({ items: [mk(FOT), mk(MANUAL)], total: 2 }));
const post = vi.fn();

vi.mock('../services/api', () => ({
  api: {
    get: (...args: unknown[]) => get(...(args as [string])),
    post: (...args: unknown[]) => post(...args),
  },
  ApiError: class ApiError extends Error {},
}));

const { ResponsiblePersonSelect } = await import('./ResponsiblePersonSelect');

afterEach(() => {
  cleanup();
  get.mockClear();
  post.mockClear();
});

describe('ResponsiblePersonSelect', () => {
  it('запрос — все активные без source; в списке и ФОТ, и ручной МОЛ', async () => {
    const onChange = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ResponsiblePersonSelect value={null} onChange={onChange} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(get).toHaveBeenCalledWith('/responsible-persons?activeOnly=true&limit=500');
    expect(get.mock.calls.every(([url]) => !url.includes('source='))).toBe(true);

    const box = await screen.findByRole('combobox');
    fireEvent.mouseDown(box);
    expect(await screen.findByTitle(FOT.fullName)).toBeTruthy();
    fireEvent.click(await screen.findByTitle(MANUAL.fullName));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(MANUAL.id));
  });

  it('незнакомое ФИО в поиске не предлагает «Создать», POST не уходит', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ResponsiblePersonSelect value={null} onChange={vi.fn()} />
      </QueryClientProvider>,
    );
    const box = await screen.findByRole('combobox');
    fireEvent.mouseDown(box);
    fireEvent.change(box, { target: { value: 'Студзинский' } });

    expect(await screen.findByText('Ничего не найдено')).toBeTruthy();
    expect(screen.queryByText(/Создать/)).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });
});
