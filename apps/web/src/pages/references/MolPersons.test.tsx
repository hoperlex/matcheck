// @vitest-environment jsdom
/**
 * Справочники → МОЛ, блок «Добавлены вручную».
 *
 *  - Переключатель архива: выключен — activeOnly=true, включён — параметра нет
 *    вовсе (activeOnly=false сервер прочитал бы как true).
 *  - Итог создания берётся из ответа сервера (`outcome`), а не из кэша списка:
 *    кэш выпадающих МОЛ здесь пуст.
 *  - 409 mol_archived: вернуть из архива можно только с правом «edit».
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { App } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const denied = new Set<string>();
vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({
    can: (_page: string, action: string) => !denied.has(action),
    canView: () => true,
    canViewGroup: () => true,
    hasCapability: () => true,
    enforced: true,
    loading: false,
  }),
}));

class MockApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public payload?: unknown,
  ) {
    super(message);
  }
}
const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();
vi.mock('../../services/api', () => ({
  api: { get: apiGet, post: apiPost, patch: apiPatch },
  ApiError: MockApiError,
}));

const { default: MolPersons } = await import('./MolPersons');

const LOSEV = {
  id: '33333333-3333-4333-8333-333333333333',
  fullName: 'Лосев Б.С.',
  phone: null,
  position: null,
  isActive: false,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-11-17T00:00:00Z',
};

function route(url: string) {
  if (url === '/mol')
    return Promise.resolve({ items: [], total: 0, stale: false, fetchedAt: null });
  if (url.startsWith('/responsible-persons')) return Promise.resolve({ items: [], total: 0 });
  return Promise.reject(new Error(`unexpected GET ${url}`));
}

function renderPage() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <App>
        <MemoryRouter>
          <MolPersons />
        </MemoryRouter>
      </App>
    </QueryClientProvider>,
  );
}

const manualUrls = () =>
  apiGet.mock.calls.map((c) => c[0] as string).filter((u) => u.startsWith('/responsible-persons'));

async function submitNew(fullName: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Добавить МОЛ' }));
  const drawer = within(await screen.findByRole('dialog'));
  const input = await drawer.findByLabelText('ФИО');
  // При создании переключателя «Активный» нет — новая запись всегда активна.
  expect(drawer.queryByLabelText('Активный')).toBeNull();
  fireEvent.change(input, { target: { value: fullName } });
  fireEvent.click(drawer.getByRole('button', { name: 'Сохранить' }));
}

beforeEach(() => {
  denied.clear();
  apiGet.mockReset();
  apiGet.mockImplementation(route);
  apiPost.mockReset();
  apiPatch.mockReset();
});
afterEach(cleanup);

describe('Справочники → МОЛ: добавленные вручную', () => {
  it('архивные: выключено — activeOnly=true, включено — без параметра', async () => {
    renderPage();
    await waitFor(() =>
      expect(manualUrls()).toContain('/responsible-persons?source=local&limit=500&activeOnly=true'),
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Показать архивные' }));
    await waitFor(() =>
      expect(manualUrls()).toContain('/responsible-persons?source=local&limit=500'),
    );
    expect(manualUrls().some((u) => u.includes('activeOnly=false'))).toBe(false);
  });

  it('пустой кэш: «existing» с сервера — «Уже есть», запись не создаётся заново', async () => {
    apiPost.mockResolvedValue({
      ...LOSEV,
      fullName: 'Пиронов Ф.Б.',
      isActive: true,
      outcome: 'existing',
    });
    renderPage();
    await submitNew('Пиронов Ф.Б.');
    expect(await screen.findByText('Уже есть в справочнике: Пиронов Ф.Б.')).toBeTruthy();
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost.mock.calls[0]![1]).not.toHaveProperty('isActive');
  });

  it('«created» с сервера — «МОЛ добавлен»', async () => {
    apiPost.mockResolvedValue({
      ...LOSEV,
      fullName: 'Доброход Н.О.',
      isActive: true,
      outcome: 'created',
    });
    renderPage();
    await submitNew('Доброход Н.О.');
    expect(await screen.findByText('МОЛ добавлен')).toBeTruthy();
  });

  it('409 mol_archived с правом edit: «Вернуть из архива» шлёт PATCH isActive=true', async () => {
    apiPost.mockRejectedValue(
      new MockApiError(409, 'mol_archived', 'в архиве', {
        error: 'mol_archived',
        message: 'в архиве',
        existing: LOSEV,
      }),
    );
    apiPatch.mockResolvedValue({ ...LOSEV, isActive: true });
    renderPage();
    await submitNew('Лосев Б.С.');
    expect(await screen.findByText('«Лосев Б.С.» есть в справочнике, но в архиве')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Вернуть из архива' }));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith(`/responsible-persons/${LOSEV.id}`, { isActive: true }),
    );
    expect(await screen.findByText('МОЛ «Лосев Б.С.» возвращён из архива')).toBeTruthy();
  });

  it('409 mol_archived без права edit: кнопки нет, PATCH не уходит', async () => {
    denied.add('edit');
    apiPost.mockRejectedValue(
      new MockApiError(409, 'mol_archived', 'в архиве', {
        error: 'mol_archived',
        message: 'в архиве',
        existing: LOSEV,
      }),
    );
    renderPage();
    await submitNew('Лосев Б.С.');
    expect(
      await screen.findByText(
        'Вернуть её может пользователь с правом редактирования справочника МОЛ.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Вернуть из архива' })).toBeNull();
    expect(apiPatch).not.toHaveBeenCalled();
  });
});
