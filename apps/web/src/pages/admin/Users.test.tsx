// @vitest-environment jsdom
/**
 * Таблица пользователей следует матрице, а не факту открытия страницы.
 *
 * `admin.users:view` выдать можно, а `admin.users:edit|delete` — нельзя никому
 * (NEVER_GRANTABLE: через PATCH пользователя выдаётся роль admin). Значит
 * «страница открыта, правка закрыта» — не экзотика, а штатное состояние для
 * любой роли, кроме администратора. До этой правки страница рисовала рабочие на
 * вид селект роли, переключатель активности и сброс пароля, каждый из которых
 * отвечал 403.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const can = vi.fn();
vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({ can, hasCapability: () => true, canView: () => true, loading: false }),
}));

const user = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'inspector@test.com',
  role: 'inspector_kpp',
  isActive: true,
  siteId: null,
  contractorCustomerId: null,
  phone: null,
  fullName: 'Петров П. П.',
  createdAt: '2026-08-01T10:00:00.000Z',
};

vi.mock('../../services/api', () => ({
  ApiError: class extends Error {},
  api: {
    get: async (url: string) => {
      if (url.startsWith('/admin/users')) return [user];
      if (url.startsWith('/admin/password-resets')) return { items: [] };
      return { items: [], total: 0 };
    },
    patch: async () => ({}),
    post: async () => ({}),
  },
}));
vi.mock('./UserEditModal', () => ({ UserEditModal: () => null }));
vi.mock('./PasswordResetLinkModal', () => ({ PasswordResetLinkModal: () => null }));

import AdminUsersPage from './Users';

async function renderPage(): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AdminUsersPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('inspector@test.com')).toBeDefined());
  return container;
}

/** Селекты и переключатели antd помечают запрет отдельным классом. */
const disabledSelects = (c: HTMLElement) => c.querySelectorAll('.ant-select-disabled').length;
const disabledSwitches = (c: HTMLElement) => c.querySelectorAll('.ant-switch-disabled').length;

beforeEach(() => can.mockReset());
afterEach(() => cleanup());

describe('AdminUsersPage: правка по матрице', () => {
  it('право есть — контролы активны, кнопки действий на месте', async () => {
    can.mockReturnValue(true);
    const c = await renderPage();
    expect(disabledSelects(c)).toBe(0);
    expect(disabledSwitches(c)).toBe(0);
    expect(c.querySelector('.anticon-edit')).not.toBeNull();
    expect(c.querySelector('.anticon-link')).not.toBeNull();
    expect(can).toHaveBeenCalledWith('admin.users', 'edit');
  });

  it('права нет — таблица полностью read-only', async () => {
    can.mockReturnValue(false);
    const c = await renderPage();
    // Роль и объект — селекты; оба обязаны быть заперты.
    expect(disabledSelects(c)).toBeGreaterThan(0);
    expect(c.querySelectorAll('.ant-select:not(.ant-select-disabled)').length).toBe(0);
    // Переключатель активности.
    expect(disabledSwitches(c)).toBeGreaterThan(0);
    // Обе кнопки ведут к правке: сброс пароля — тоже POST.
    expect(c.querySelector('.anticon-edit')).toBeNull();
    expect(c.querySelector('.anticon-link')).toBeNull();
  });

  it('данные при этом видны — просмотр не отбирается', async () => {
    can.mockReturnValue(false);
    await renderPage();
    expect(screen.getByText('inspector@test.com')).toBeDefined();
    expect(screen.getByText('Петров П. П.')).toBeDefined();
  });
});
