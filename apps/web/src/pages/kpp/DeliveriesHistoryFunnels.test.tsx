// @vitest-environment jsdom
/**
 * Принятые (приёмка): воронки в шапке — те же фильтры, что в панели и чипах.
 *
 * Значение живёт в адресе и меняется тем же updateFilters: воронка «Статус»
 * ставит тот же ?status, что раньше задавался только дип-линком, и снимается
 * тем же чипом; id и объект уходят на сервер вместе с датами из панели.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({
    can: () => true,
    hasCapability: () => true,
    canView: () => true,
    loading: false,
  }),
}));
vi.mock('../../stores/auth', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ user: { id: 'u-1', email: 'manager@test.com', role: 'manager' } }),
}));

const SITE_ID = '33333333-3333-3333-3333-333333333333';
const row = {
  id: '11111111-1111-1111-1111-111111111111',
  displayId: 7,
  status: { code: 'draft', label: 'Черновик', color: null },
  siteId: SITE_ID,
  siteName: 'Объект 1',
  supplierId: null,
  contractorId: null,
  supplierName: null,
  contractorName: null,
  vehiclePlate: 'А123ВС77',
  driverName: null,
  arrivedAt: '2026-08-13T10:00:00.000Z',
  inTransit: false,
  isAssets: false,
  pendingDeletionAt: null,
  pendingDeletionByUserId: null,
  reviewState: null,
  items: [],
  photos: [],
  sourceDocumentIds: [],
  primarySourceDocument: null,
  itemCount: 0,
  photoCount: 0,
  createdAt: '2026-08-13T10:00:00.000Z',
  updatedAt: '2026-08-13T10:00:00.000Z',
};

const apiState = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock('../../services/api', () => ({
  ApiError: class extends Error {},
  api: {
    get: async (url: string) => {
      apiState.urls.push(url);
      if (url.startsWith('/deliveries')) return { items: [row], total: 1 };
      if (url.startsWith('/statuses')) {
        return {
          items: [
            {
              id: 's1',
              entityType: 'delivery',
              code: 'draft',
              label: 'Черновик',
              color: null,
              sortOrder: 20,
            },
            {
              id: 's2',
              entityType: 'delivery',
              code: 'filled',
              label: 'Оформлена',
              color: null,
              sortOrder: 30,
            },
          ],
        };
      }
      if (url.startsWith('/sites')) {
        return { items: [{ id: SITE_ID, code: 'АЛ13', name: 'ЖК АЛИЯ' }], total: 1 };
      }
      return { items: [], total: 0 };
    },
  },
}));
vi.mock('../../services/deliveries', () => ({
  hardDeleteDelivery: vi.fn(),
  markDeletion: vi.fn(),
  unmarkDeletion: vi.fn(),
}));
vi.mock('./DeliveryViewModal', () => ({ DeliveryViewModal: () => null }));
vi.mock('../../components/ShareLinkModal', () => ({ ShareLinkModal: () => null }));

const { DeliveriesHistory } = await import('./DeliveriesHistory');
const { useGlobalFiltersStore } = await import('../../stores/globalFilters');

let search = '';
function UrlSpy(): null {
  search = useLocation().search;
  return null;
}

async function renderHistory(initial = '/operations'): Promise<void> {
  apiState.urls = [];
  render(
    <MemoryRouter initialEntries={[initial]}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <DeliveriesHistory onOpen={() => {}} />
        <UrlSpy />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('А123ВС77')).toBeDefined());
}

afterEach(() => {
  cleanup();
  useGlobalFiltersStore.getState().reset();
});

function th(title: string): HTMLElement {
  return Array.from(document.querySelectorAll<HTMLElement>('.ant-table-thead th')).find(
    (el) => el.textContent?.trim() === title,
  )!;
}

function listQueries(): URLSearchParams[] {
  return apiState.urls
    .filter((u) => u.startsWith('/deliveries?'))
    .map((u) => new URLSearchParams(u.slice(u.indexOf('?') + 1)));
}

async function expectListRequest(expected: Record<string, string>): Promise<void> {
  await waitFor(() => {
    const hit = listQueries().some((qs) =>
      Object.entries(expected).every(([k, v]) => qs.get(k) === v),
    );
    if (!hit)
      throw new Error(`нет запроса с ${JSON.stringify(expected)}: ${apiState.urls.join(' ; ')}`);
  });
}

describe('Принятые (приёмка): воронки в шапке', () => {
  it('«Статус» — тот же ?status, что у чипа; чип снимает и воронку', async () => {
    await renderHistory();
    fireEvent.click(th('Статус').querySelector('.ant-table-filter-trigger')!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      within(dialog).getByText('Оформлена').closest('label')!.querySelector('input')!,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Применить' }));

    await waitFor(() => expect(search).toContain('status=filled'));
    await expectListRequest({ status: 'filled' });
    expect(th('Статус').querySelector('.ant-table-filter-trigger.active')).toBeTruthy();

    // Чип «Статус: …» над таблицей снимает тот же фильтр.
    const chip = await screen.findByText(/^Статус:/);
    fireEvent.click(chip.closest('.ant-tag')!.querySelector('.ant-tag-close-icon')!);
    await waitFor(() => expect(search).not.toContain('status='));
    expect(th('Статус').querySelector('.ant-table-filter-trigger.active')).toBeNull();
  });

  it('«id» — только цифры, точный ?displayId на сервер', async () => {
    await renderHistory();
    fireEvent.click(th('id').querySelector('.ant-table-filter-trigger')!);
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByPlaceholderText('Точный id') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '12а3' } });
    expect(input.value).toBe('123');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Применить' }));
    await expectListRequest({ displayId: '123' });
  });

  it('«Объект» из воронки уходит вместе с датами из адреса', async () => {
    await renderHistory('/operations?dfrom=2026-08-01&dto=2026-08-31');
    await waitFor(() =>
      expect(th('Объект').querySelector('.ant-table-filter-trigger')).toBeTruthy(),
    );
    fireEvent.click(th('Объект').querySelector('.ant-table-filter-trigger')!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      within(dialog).getByText('АЛ13 · ЖК АЛИЯ').closest('label')!.querySelector('input')!,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Применить' }));

    await waitFor(() => expect(search).toContain(`site=${SITE_ID}`));
    expect(search).toContain('dfrom=2026-08-01');
    expect(search).toContain('dto=2026-08-31');
    await waitFor(() => {
      const hit = listQueries().some(
        (qs) => qs.get('siteIds') === SITE_ID && qs.has('arrivedFrom') && qs.has('arrivedTo'),
      );
      if (!hit) throw new Error('объект и даты не ушли одним запросом');
    });
  });

  it('«Диспетчер» из панели — ?dispatcher в адресе и dispatcherCheck на сервер', async () => {
    await renderHistory();
    const select = (await screen.findByText('Диспетчер: все')).closest('.ant-select')!;
    fireEvent.mouseDown(select.querySelector('.ant-select-selector')!);
    fireEvent.click(await screen.findByTitle('Диспетчер не отметил'));

    await waitFor(() => expect(search).toContain('dispatcher=none'));
    await expectListRequest({ dispatcherCheck: 'none' });
  });
});
