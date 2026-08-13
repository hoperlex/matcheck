// @vitest-environment jsdom
/**
 * Колокольчик уведомлений гейтится возможностью `operations.share.messages`.
 *
 * Два разных требования, и оба проверяются здесь:
 *
 *   1) нет возможности — нет колокольчика (у переписки свой allow-list: ссылку
 *      инспектор создаёт, а треды ему закрыты);
 *   2) пока права не приехали — колокольчика тоже нет. Это исключение из общего
 *      правила «нет данных ≠ нет прав»: обычно мы показываем контрол авансом,
 *      но здесь запрос уходит САМ, без клика, и подрядчик получал бы
 *      гарантированный 403 на каждой загрузке портала.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const hasCapability = vi.fn();
const loadingRef = { value: false };

vi.mock('../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({
    can: () => true,
    hasCapability,
    loading: loadingRef.value,
  }),
}));

// Сеть в этом тесте не предмет проверки: важно, дошло ли дело до запроса.
const apiGet = vi.fn(async () => ({ count: 0 }));
vi.mock('../services/api', () => ({
  api: { get: (...args: unknown[]) => apiGet(...(args as [])) },
}));

import { NotificationsBell } from './NotificationsBell';

function renderBell(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // MemoryRouter нужен вложенному ShareThreadDrawer: он зовёт useNavigate.
  const ui: ReactElement = (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <NotificationsBell />
      </QueryClientProvider>
    </MemoryRouter>
  );
  return render(ui);
}

beforeEach(() => {
  hasCapability.mockReset();
  apiGet.mockClear();
  loadingRef.value = false;
});

afterEach(() => {
  cleanup();
});

describe('NotificationsBell: возможность переписки', () => {
  it('возможность есть — колокольчик виден', () => {
    hasCapability.mockReturnValue(true);
    renderBell();
    expect(screen.getByRole('button')).toBeDefined();
    expect(hasCapability).toHaveBeenCalledWith('operations.share.messages');
  });

  it('возможности нет — колокольчика нет', () => {
    hasCapability.mockReturnValue(false);
    const { container } = renderBell();
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('права ещё не загрузились — колокольчик не показываем авансом', () => {
    // Иначе подрядчик слал бы заведомо запрещённый запрос на каждой загрузке.
    loadingRef.value = true;
    hasCapability.mockReturnValue(true);
    const { container } = renderBell();
    expect(container.textContent).toBe('');
    expect(apiGet).not.toHaveBeenCalled();
  });
});
