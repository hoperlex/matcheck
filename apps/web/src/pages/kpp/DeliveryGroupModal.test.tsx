// @vitest-environment jsdom
/**
 * Окно «Группа приёмок»: создать группу или поменять состав.
 *
 * Обещания: выбор в поиске переживает листание (рейсы одной поставки бывают на
 * разных страницах списка); приёмки из других групп и из отгрузки не
 * добавить; «Убрать» ничего не шлёт до «Сохранить», и все правки уходят одним
 * запросом — замена в группе из двух не распускает её; отказ сервера — в окне.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();

class FakeApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
vi.mock('../../services/api', () => ({
  api: { get, post, delete: vi.fn() },
  ApiError: FakeApiError,
}));

const { DeliveryGroupModal } = await import('./DeliveryGroupModal');

const SITE = 'site-1';
const d = (id: string, displayId: number, over: Record<string, unknown> = {}) => ({
  id,
  displayId,
  vehiclePlate: `А${displayId}`,
  arrivedAt: '2026-11-16T10:00:00.000Z',
  supplierName: 'ООО «Рейс»',
  siteId: SITE,
  sourceShipmentId: null,
  status: { code: 'filled', label: 'Оформлена', color: null },
  deliveryGroup: null,
  ...over,
});

/** Поиск: две страницы по одной приёмке, плюс «чужая группа» и «из отгрузки». */
function serveSearch() {
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/delivery-groups/')) {
      return {
        groupId: 'g-1',
        siteId: SITE,
        memberIds: ['m-1', 'm-2'],
        items: [d('m-1', 25518), d('m-2', 25515)],
      };
    }
    const offset = Number(new URL(`http://x${url}`).searchParams.get('offset'));
    const page1 = [
      d('s-1', 25520),
      d('busy', 25521, {
        deliveryGroup: {
          id: 'g-9',
          siteId: SITE,
          members: [
            { deliveryId: 'busy', displayId: 25521 },
            { deliveryId: 'x', displayId: 25400 },
          ],
        },
      }),
      d('ship', 25522, { sourceShipmentId: 'sh-1' }),
    ];
    return offset === 0 ? { items: page1, total: 25 } : { items: [d('s-2', 25300)], total: 25 };
  });
}

function show(props: Partial<Parameters<typeof DeliveryGroupModal>[0]> = {}) {
  const onDone = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DeliveryGroupModal
        open
        groupId={null}
        siteId={SITE}
        siteName="ЖК Садовническая"
        initial={[d('a', 25519)] as never}
        onClose={vi.fn()}
        onDone={onDone}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onDone };
}

const searchRow = async (displayId: number) => {
  const cells = await screen.findAllByText(String(displayId));
  return cells.at(-1)!.closest('tr') as HTMLElement;
};
const save = () => screen.getByRole('button', { name: 'Сохранить' });

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  serveSearch();
});
afterEach(cleanup);

describe('DeliveryGroupModal', () => {
  it('новая группа: выбор переживает листание поиска, уходит одним запросом', async () => {
    post.mockResolvedValue({
      groupId: 'g-new',
      members: [],
      added: [],
      removed: [],
      dissolved: false,
    });
    const { onDone } = show();
    // Одной отмеченной мало — нужна вторая.
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(await searchRow(25520)).getByRole('checkbox'));
    // Вторая страница поиска.
    fireEvent.click(document.querySelector('.ant-pagination-item-2')!);
    fireEvent.click(within(await searchRow(25300)).getByRole('checkbox'));
    expect(screen.getByText('В группе: 3 приёмки')).toBeTruthy();
    // Окно поиска по умолчанию — вокруг отмеченных (±3 дня).
    const searchUrl = get.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.startsWith('/deliveries?'))!;
    expect(searchUrl).toContain(`siteIds=${SITE}`);
    expect(searchUrl).toContain('grouped=1');
    expect(searchUrl).toContain('arrivedFrom=');
    fireEvent.click(save());
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/delivery-groups', { add: ['a', 's-1', 's-2'] }),
    );
    expect(onDone).toHaveBeenCalled();
  });

  it('из другой группы и из отгрузки — не добавить, с причиной', async () => {
    show();
    const busy = await searchRow(25521);
    expect(within(busy).getByRole('checkbox')).toHaveProperty('disabled', true);
    expect(busy.textContent).toContain('в группе с 25400');
    const ship = await searchRow(25522);
    expect(within(ship).getByRole('checkbox')).toHaveProperty('disabled', true);
    expect(ship.textContent).toContain('из отгрузки');
  });

  it('замена в группе из двух: «Убрать» без запроса, затем один запрос с add и remove', async () => {
    post.mockResolvedValue({
      groupId: 'g-1',
      members: [],
      added: [],
      removed: [],
      dissolved: false,
    });
    show({ groupId: 'g-1', initial: [] });
    const member = (await screen.findAllByText('25515'))[0]!.closest('tr') as HTMLElement;
    fireEvent.click(within(member).getByRole('button', { name: 'Убрать' }));
    expect(post).not.toHaveBeenCalled();
    expect(member.textContent).toContain('будет убрана');
    expect(screen.getByText(/группа будет распущена/)).toBeTruthy();
    fireEvent.click(within(await searchRow(25520)).getByRole('checkbox'));
    expect(screen.queryByText(/группа будет распущена/)).toBeNull();
    fireEvent.click(save());
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/delivery-groups', {
        groupId: 'g-1',
        expectedMemberIds: ['m-1', 'm-2'],
        add: ['s-1'],
        remove: ['m-2'],
      }),
    );
  });

  it('состав изменился — текст сервера в окне, окно открыто', async () => {
    post.mockRejectedValue(
      new FakeApiError(409, 'group_changed', 'Состав группы изменился — откройте её заново.'),
    );
    const { onDone } = show({ groupId: 'g-1', initial: [] });
    fireEvent.click(within(await searchRow(25520)).getByRole('checkbox'));
    fireEvent.click(save());
    expect(await screen.findByText(/Состав группы изменился/)).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });
});
