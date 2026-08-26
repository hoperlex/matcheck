// @vitest-environment jsdom
/**
 * Массовый выбор не переживает смену поиска.
 *
 * antd держит выбранные ключи через `preserveSelectedRowKeys`, поэтому после
 * нового запроса на экране других строк панель по-прежнему показывала «Выбрано:
 * 3», а «Удалить выбранные» отправляла id, которых пользователь уже не видит —
 * подтверждение при этом перечисляет только количество.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({
    can: () => true,
    canView: () => true,
    canViewGroup: () => true,
    hasCapability: () => true,
    enforced: true,
    loading: false,
  }),
}));

const SUPPLIER = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'ООО «Лютик»',
  inn: '7712345678',
  kpp: null,
  address: null,
  aliases: [],
  isActive: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

vi.mock('../../services/api', () => ({
  api: {
    get: async () => ({ items: [SUPPLIER], total: 1 }),
    post: async () => ({ ok: true }),
    patch: async () => ({}),
    delete: async () => ({}),
  },
  ApiError: class extends Error {},
}));

const { default: SuppliersPage } = await import('./Suppliers');

afterEach(cleanup);

describe('Справочник поставщиков: массовый выбор', () => {
  it('смена поиска снимает выбор', async () => {
    const { container } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <SuppliersPage />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('ООО «Лютик»')).toBeTruthy();

    // Отмечаем строку — появляется панель массовых действий.
    const rowCheckbox = container.querySelector(
      '.ant-table-tbody .ant-checkbox-input',
    ) as HTMLInputElement;
    fireEvent.click(rowCheckbox);
    expect(await screen.findByText('Выбрано:')).toBeTruthy();

    // Меняем поиск — выдача другая, значит и выбор больше не относится к ней.
    fireEvent.change(screen.getByPlaceholderText('ИНН или название'), {
      target: { value: 'Ромашка' },
    });

    await waitFor(() => expect(screen.queryByText('Выбрано:')).toBeNull());
  });
});
