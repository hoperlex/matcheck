// @vitest-environment jsdom
/**
 * Отметка «Диспетчер»: следует праву «Проверять», ставится одним нажатием и
 * снимается только через подтверждение.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const can = vi.fn();
vi.mock('../hooks/usePermissions', () => ({
  usePermissions: () => ({ can, hasCapability: () => true, loading: false }),
}));

const patch = vi.fn((_path: string, _body?: unknown) => Promise.resolve({}));
vi.mock('../../services/api', () => ({
  api: { patch: (...args: unknown[]) => patch(...(args as [string, unknown])) },
}));

const { DispatcherCheckControl } = await import('./DispatcherCheckControl');

const ID = '11111111-1111-1111-1111-111111111111';
const props = {
  id: ID,
  statusCode: 'filled',
  checkedAt: null,
  checkedByUserEmail: null,
  pendingDeletion: false,
};

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  can.mockReset();
  patch.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('DispatcherCheckControl', () => {
  it('спрашивает действие review страницы приёмок; без права контрола нет', () => {
    can.mockReturnValue(false);
    const { container } = renderWithQuery(<DispatcherCheckControl {...props} />);
    expect(can).toHaveBeenCalledWith('operations.deliveries', 'review');
    expect(container.textContent).toBe('');
  });

  it('ставится одним нажатием', async () => {
    can.mockReturnValue(true);
    renderWithQuery(<DispatcherCheckControl {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /Диспетчер/ }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(`/deliveries/${ID}/dispatcher-check`, { checked: true }),
    );
  });

  it('снимается только после подтверждения', async () => {
    can.mockReturnValue(true);
    renderWithQuery(
      <DispatcherCheckControl
        {...props}
        checkedAt="2026-10-29T09:27:00.000Z"
        checkedByUserEmail="disp@su10.ru"
      />,
    );
    expect(screen.getByText(/disp@su10\.ru/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Диспетчер/ }));
    expect(patch).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Снять' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(`/deliveries/${ID}/dispatcher-check`, { checked: false }),
    );
  });

  it('неоформленная приёмка — кнопка неактивна', () => {
    can.mockReturnValue(true);
    renderWithQuery(<DispatcherCheckControl {...props} statusCode="not_filled" />);
    const btn = screen.getByRole('button', { name: /Диспетчер/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
