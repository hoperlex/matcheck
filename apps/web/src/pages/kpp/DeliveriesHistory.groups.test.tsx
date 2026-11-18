// @vitest-environment jsdom
/**
 * Группы приёмок в «Принятых»: строка группы и скобка слева, как в Excel.
 *
 * Обещания (план 16.11, ред. 4):
 *   - группы видят те, у кого есть «Проверять» (менеджер, мониторинг, админ),
 *     только в Операциях (showGroups) и не в корзине; запрос — с grouped=1;
 *   - строку группы нельзя отметить; свернуть — скрыть приёмки и снять с них
 *     отметки;
 *   - «Объединить в группу» открывает окно с отмеченными (пополнение, если одна
 *     из них уже в группе), «Убрать из группы» и «Разгруппировать» зовут сервер;
 *   - «Привязать УПД из ЭДО» и счёт «у N из M» — только при праве привязки:
 *     мониторинг без него группирует, но не привязывает.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const can = vi.fn();
const hasCapability = vi.fn();
vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({ can, hasCapability, canView: () => true, loading: false }),
}));

const authUser = { id: 'u-1', email: 'monitor@test.com', role: 'manager' };
vi.mock('../../stores/auth', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: authUser }),
}));

const SITE = '33333333-3333-3333-3333-333333333333';
const group = {
  id: 'g-1',
  siteId: SITE,
  members: [
    { deliveryId: 'd-18', displayId: 25518 },
    { deliveryId: 'd-15', displayId: 25515 },
  ],
  edoLinkedCount: 0,
};
const make = (id: string, displayId: number, plate: string, inGroup: boolean) => ({
  id,
  displayId,
  status: { code: 'filled', label: 'Оформлена', color: null },
  siteId: SITE,
  siteName: 'ЖК Садовническая',
  supplierId: null,
  contractorId: null,
  supplierName: null,
  contractorName: null,
  vehiclePlate: plate,
  driverName: null,
  arrivedAt: '2026-11-16T11:24:00.000Z',
  inTransit: false,
  isAssets: false,
  pendingDeletionAt: null,
  pendingDeletionByUserId: null,
  sourceShipmentId: null,
  reviewState: null,
  items: [],
  photos: [],
  sourceDocumentIds: [],
  primarySourceDocument: null,
  itemCount: 0,
  photoCount: 0,
  deliveryGroup: inGroup ? group : null,
  createdAt: '2026-11-16T11:24:00.000Z',
  updatedAt: '2026-11-16T11:24:00.000Z',
});
const rows = [
  make('d-18', 25518, 'Т036ВК550', true),
  make('d-15', 25515, 'Т036ВК551', true),
  make('d-16', 25516, 'О082КЕ977', false),
];

const urls: string[] = [];
const post = vi.fn();
const del = vi.fn();
vi.mock('../../services/api', () => ({
  ApiError: class extends Error {},
  api: {
    get: async (url: string) => {
      urls.push(url);
      return url.startsWith('/deliveries') ? { items: rows, total: 3 } : { items: [], total: 0 };
    },
    post: (...args: unknown[]) => post(...args),
    delete: (...args: unknown[]) => del(...args),
  },
}));
vi.mock('../../services/deliveries', () => ({
  hardDeleteDelivery: vi.fn(),
  markDeletion: vi.fn(),
  unmarkDeletion: vi.fn(),
}));
vi.mock('./DeliveryViewModal', () => ({ DeliveryViewModal: () => null }));
vi.mock('../../components/ShareLinkModal', () => ({ ShareLinkModal: () => null }));
vi.mock('./BulkEdoLinkFlow', () => ({ BulkEdoLinkFlow: () => null }));
// Окна групп — свои тесты; здесь — что и с чем они открываются.
vi.mock('./DeliveryGroupModal', () => ({
  DeliveryGroupModal: ({ groupId, initial }: { groupId: string | null; initial: unknown[] }) => (
    <div>
      окно группы: {groupId ?? 'новая'} · {initial.length}
    </div>
  ),
}));
vi.mock('./GroupEdoLinkFlow', () => ({
  GroupEdoLinkFlow: ({ groupId }: { groupId: string | null }) =>
    groupId ? <div>поток группы: {groupId}</div> : null,
}));

import { DeliveriesHistory } from './DeliveriesHistory';

async function show(opts: { showGroups?: boolean; route?: string } = {}): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <MemoryRouter initialEntries={[opts.route ?? '/operations']}>
      <QueryClientProvider client={client}>
        <DeliveriesHistory onOpen={() => {}} showGroups={opts.showGroups ?? true} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('О082КЕ977')).toBeDefined());
  return container;
}

const listUrl = () => urls.filter((u) => u.startsWith('/deliveries?')).at(-1) ?? '';
const headRow = (c: HTMLElement) => c.querySelector<HTMLElement>('tr.mc-group-head');
const rowOf = (plate: string) => screen.getByText(plate).closest('tr') as HTMLElement;
const checkbox = (tr: HTMLElement) => tr.querySelector<HTMLInputElement>('input[type="checkbox"]');

/** Менеджер: «Проверять», правка и привязка ЭДО. */
function asManager() {
  can.mockReturnValue(true);
  hasCapability.mockReturnValue(true);
}
/** Мониторинг на дефолтах: «Проверять» есть, правки и привязки нет. */
function asMonitor() {
  can.mockImplementation(
    (_page: string, action: string) => action === 'review' || action === 'view',
  );
  hasCapability.mockReturnValue(false);
}

beforeEach(() => {
  can.mockReset();
  hasCapability.mockReset();
  post.mockReset();
  del.mockReset();
  urls.length = 0;
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe('Принятые: группы приёмок', () => {
  it('строка группы над приёмками, скобка head/mid/end; запрос с grouped=1', async () => {
    asManager();
    const container = await show();
    expect(listUrl()).toContain('grouped=1');
    const head = headRow(container)!;
    expect(head).not.toBeNull();
    expect(head.textContent).toContain('Группа · 2 приёмки');
    expect(head.textContent).toContain('ЖК Садовническая');
    expect(head.textContent).toContain('УПД из ЭДО: у 0 из 2');
    // Строку группы отметить нельзя: ячейки выбора нет, заголовок на всю ширину.
    expect(checkbox(head)).toBeNull();
    const order = [...container.querySelectorAll('tbody tr.ant-table-row')].map((tr) =>
      tr.classList.contains('mc-group-head') ? 'head' : tr.textContent?.match(/\d{5}/)?.[0],
    );
    expect(order).toEqual(['head', '25518', '25515', '25516']);
    const gutter = (tr: HTMLElement) => tr.querySelector('td.mc-group-gutter')!.className;
    expect(gutter(head)).toContain('mc-gutter-head');
    expect(gutter(rowOf('Т036ВК550'))).toContain('mc-gutter-mid');
    expect(gutter(rowOf('Т036ВК551'))).toContain('mc-gutter-end');
    expect(gutter(rowOf('О082КЕ977'))).not.toMatch(/mc-gutter-(head|mid|end)/);
  });

  it('без showGroups (список инспектора) и в корзине — групп нет, grouped не уходит', async () => {
    asManager();
    const container = await show({ showGroups: false });
    expect(listUrl()).not.toContain('grouped');
    expect(headRow(container)).toBeNull();
    cleanup();
    urls.length = 0;
    const trash = await show({ route: '/operations?trash=1' });
    expect(listUrl()).not.toContain('grouped');
    expect(headRow(trash)).toBeNull();
  });

  it('без «Проверять» групп нет', async () => {
    can.mockImplementation((_page: string, action: string) => action !== 'review');
    hasCapability.mockReturnValue(true);
    const container = await show();
    expect(listUrl()).not.toContain('grouped');
    expect(headRow(container)).toBeNull();
  });

  it('свернуть — приёмки группы скрыты и сняты с отметки; развернуть — вернулись', async () => {
    asManager();
    const container = await show();
    fireEvent.click(checkbox(rowOf('Т036ВК550'))!);
    expect(await screen.findByText(/Выбрано/)).toBeTruthy();
    fireEvent.click(within(headRow(container)!).getByRole('button', { name: 'Свернуть группу' }));
    await waitFor(() => expect(screen.queryByText('Т036ВК550')).toBeNull());
    expect(screen.queryByText(/Выбрано/)).toBeNull();
    expect(screen.getByText('О082КЕ977')).toBeTruthy();
    fireEvent.click(within(headRow(container)!).getByRole('button', { name: 'Развернуть группу' }));
    expect(await screen.findByText('Т036ВК550')).toBeTruthy();
  });

  it('«Объединить в группу»: одиночная с приёмкой группы — пополнение этой группы', async () => {
    asManager();
    await show();
    fireEvent.click(checkbox(rowOf('Т036ВК550'))!);
    fireEvent.click(checkbox(rowOf('О082КЕ977'))!);
    fireEvent.click(await screen.findByRole('button', { name: /Объединить в группу/ }));
    expect(await screen.findByText('окно группы: g-1 · 2')).toBeTruthy();
  });

  it('«Убрать из группы» и «Разгруппировать» зовут сервер', async () => {
    asManager();
    post.mockResolvedValue({
      removed: [{ deliveryId: 'd-15', displayId: 25515 }],
      dissolvedGroupIds: ['g-1'],
    });
    del.mockResolvedValue({ removed: [] });
    const container = await show();
    fireEvent.click(checkbox(rowOf('Т036ВК551'))!);
    fireEvent.click(await screen.findByRole('button', { name: /Убрать из группы/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Убрать' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/delivery-groups/leave', { deliveryIds: ['d-15'] }),
    );

    fireEvent.click(within(headRow(container)!).getByRole('button', { name: /Разгруппировать/ }));
    const confirm = await screen.findAllByRole('button', { name: 'Разгруппировать' });
    fireEvent.click(confirm.at(-1)!);
    await waitFor(() => expect(del).toHaveBeenCalledWith('/delivery-groups/g-1'));
    // Две модалки подтверждения поверх полной таблицы: в одиночку ~3 с, в общем
    // прогоне под нагрузкой упирался в 5 с по умолчанию.
  }, 15_000);

  it('«Изменить состав» и «Привязать УПД из ЭДО» в строке группы', async () => {
    asManager();
    const container = await show();
    fireEvent.click(within(headRow(container)!).getByRole('button', { name: /Изменить состав/ }));
    expect(await screen.findByText('окно группы: g-1 · 0')).toBeTruthy();
    fireEvent.click(
      within(headRow(container)!).getByRole('button', { name: /Привязать УПД из ЭДО/ }),
    );
    expect(await screen.findByText('поток группы: g-1')).toBeTruthy();
  });

  it('мониторинг без права привязки: группирует, но без привязки и счёта ЭДО', async () => {
    asMonitor();
    const container = await show();
    const head = headRow(container)!;
    expect(within(head).getByRole('button', { name: /Изменить состав/ })).toBeTruthy();
    expect(within(head).queryByRole('button', { name: /Привязать УПД из ЭДО/ })).toBeNull();
    expect(head.textContent).not.toContain('УПД из ЭДО: у');
    fireEvent.click(checkbox(rowOf('О082КЕ977'))!);
    expect(await screen.findByRole('button', { name: /Объединить в группу/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Привязать УПД из ЭДО/ })).toBeNull();
  });
});
