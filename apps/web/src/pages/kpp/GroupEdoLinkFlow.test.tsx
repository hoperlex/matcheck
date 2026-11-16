// @vitest-environment jsdom
/**
 * «Привязать УПД из ЭДО» в строке группы: состав — с сервера целиком.
 *
 * Обещания: поток начинается только с полным составом группы и передаёт его
 * дальше (участники не снимаются, сервер сверит состав); неполный состав —
 * понятная ошибка, привязки нет; помеха (например, удаляемая) — предупреждение.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Antd from 'antd';

const get = vi.fn();
vi.mock('../../services/api', () => ({ api: { get }, ApiError: class extends Error {} }));

const flow = vi.fn();
vi.mock('./BulkEdoLinkFlow', () => ({
  BulkEdoLinkFlow: (props: {
    deliveries: { id: string }[];
    deliveryGroup: { id: string; memberIds: string[] };
  }) => {
    flow(props);
    return (
      <div>
        поток: {props.deliveries.length} · {props.deliveryGroup.id}
      </div>
    );
  },
}));

const warning = vi.fn();
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof Antd>();
  return { ...actual, message: { ...actual.message, warning: (t: string) => warning(t) } };
});

const { GroupEdoLinkFlow } = await import('./GroupEdoLinkFlow');

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  siteId: 'site-1',
  pendingDeletionAt: null,
  sourceShipmentId: null,
  ...over,
});

function show() {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <GroupEdoLinkFlow groupId="g-1" onClose={onClose} onDone={vi.fn()} />
    </QueryClientProvider>,
  );
  return { onClose };
}

beforeEach(() => {
  get.mockReset();
  flow.mockReset();
  warning.mockReset();
});
afterEach(cleanup);

describe('GroupEdoLinkFlow', () => {
  it('полный состав — поток привязки со всеми участниками и группой', async () => {
    get.mockResolvedValue({
      groupId: 'g-1',
      siteId: 'site-1',
      memberIds: ['a', 'b', 'c'],
      items: [item('a'), item('b'), item('c')],
    });
    show();
    expect(await screen.findByText('поток: 3 · g-1')).toBeTruthy();
    expect(get).toHaveBeenCalledWith('/delivery-groups/g-1/members');
    expect(flow.mock.calls.at(-1)![0].deliveryGroup).toEqual({
      id: 'g-1',
      memberIds: ['a', 'b', 'c'],
    });
  });

  it('неполный состав — ошибка, привязки нет', async () => {
    get.mockResolvedValue({
      groupId: 'g-1',
      siteId: 'site-1',
      memberIds: ['a', 'b', 'c'],
      items: [item('a'), item('b')],
    });
    show();
    expect(await screen.findByText(/Не удалось загрузить состав группы целиком/)).toBeTruthy();
    expect(flow).not.toHaveBeenCalled();
  });

  it('помеха (участник на удалении) — предупреждение и закрытие', async () => {
    get.mockResolvedValue({
      groupId: 'g-1',
      siteId: 'site-1',
      memberIds: ['a', 'b'],
      items: [item('a'), item('b', { pendingDeletionAt: '2026-11-16T10:00:00Z' })],
    });
    const { onClose } = show();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/на удаление/));
    expect(flow).not.toHaveBeenCalled();
  });
});
