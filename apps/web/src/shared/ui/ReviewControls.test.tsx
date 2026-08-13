// @vitest-environment jsdom
/**
 * Render-тесты permission-aware контрола: право снято — контрола нет в DOM.
 *
 * Чистые функции (`can`, `hasCapability`) покрыты отдельно, но они не
 * доказывают, что компонент их СПРАШИВАЕТ и что кнопка действительно исчезает
 * из разметки. Именно этот класс ошибок и всплыл в ревью: восемь контролов
 * гейтились не тем признаком, а тесты оставались зелёными.
 *
 * Здесь проверяется отметка проверки качества — то право, ради которого
 * заводилось отдельное действие `review`.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';

const can = vi.fn();
vi.mock('../hooks/usePermissions', () => ({
  usePermissions: () => ({ can, hasCapability: () => true, loading: false }),
}));

import { ReviewControls } from './ReviewControls';

const props = {
  entityType: 'delivery' as const,
  id: '11111111-1111-1111-1111-111111111111',
  // Оформленная приёмка: гейт зрелости на сервере пропускает только такие,
  // и компонент повторяет это условие.
  statusCode: 'filled',
  reviewState: null,
  reviewNote: null,
  reviewedByUserEmail: null,
  reviewedAt: null,
  updatedAt: new Date('2026-08-13T10:00:00Z').toISOString(),
  pendingDeletion: false,
};

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  can.mockReset();
});

// Без globals: true vitest не подключает авто-очистку testing-library, и
// разметка предыдущего теста осталась бы в document — screen находил бы чужие
// кнопки, а проверка «контрола нет» проходила бы ложно.
afterEach(() => {
  cleanup();
});

describe('ReviewControls: контрол следует праву «Проверять»', () => {
  it('право есть — кнопки отметки в DOM', () => {
    can.mockReturnValue(true);
    renderWithQuery(<ReviewControls {...props} />);
    expect(screen.getByRole('button', { name: /Проверено/i })).toBeDefined();
  });

  it('право снято — контрола нет вовсе', () => {
    // Не «disabled», а именно отсутствует: иначе человек жал бы кнопку,
    // получая 403 от сервера.
    can.mockReturnValue(false);
    const { container } = renderWithQuery(<ReviewControls {...props} />);
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('спрашивается именно действие review, а не edit', () => {
    // Регресс, который тут ловится: вернуть проверку к `edit` — и монитор со
    // снятой отметкой снова смог бы её ставить.
    can.mockReturnValue(true);
    renderWithQuery(<ReviewControls {...props} />);
    expect(can).toHaveBeenCalledWith('operations.deliveries', 'review');
  });

  it('для отгрузки спрашивается своя страница', () => {
    can.mockReturnValue(true);
    renderWithQuery(<ReviewControls {...props} entityType="shipment" statusCode="shipped" />);
    expect(can).toHaveBeenCalledWith('operations.shipments', 'review');
  });
});
