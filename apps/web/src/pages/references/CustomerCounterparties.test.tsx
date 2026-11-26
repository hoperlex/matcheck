// @vitest-environment jsdom
/**
 * Справочник «Контрагенты»: колонка «Объекты и вид» (0159, 0160).
 * - список грузится с withSites=1, метки «код · вид», ручной вид помечен ✎;
 *   ручной «Материалы подрядчика» — зелёная метка;
 * - воронка колонки фильтрует по метке «ЗИЛ18 · Давальческий»;
 * - карточка шлёт `sites` только если список изменили, и тогда — с версией;
 * - 409 по версии — понятное сообщение, а не текст ошибки сервера.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CustomerCounterparty, CustomerCounterpartySite } from '@matcheck/contracts';
import { contractorSitesChanged } from './contractorSites';

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

const ID = (i: number) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;

function site(
  i: number,
  code: string,
  kind: CustomerCounterpartySite['kind'],
  manual = false,
  onec: Partial<NonNullable<CustomerCounterpartySite['onec']>> | null = null,
): CustomerCounterpartySite {
  return {
    siteId: ID(100 + i),
    siteCode: code,
    siteName: `Объект ${code}`,
    siteActive: true,
    kind,
    manual,
    onec: onec
      ? {
          // У 1С нет вида «Материалы подрядчика» — по умолчанию реализация.
          kind: kind === 'contractor_materials' ? 'realization' : kind,
          realizationDocs: 0,
          tollingDocs: 0,
          realizationSum: '0.00',
          tollingSum: '0.00',
          objects: [],
          loadedAt: '2026-11-25T12:00:00.000Z',
          ...onec,
        }
      : null,
  };
}

function cc(i: number, name: string, sites: CustomerCounterpartySite[]): CustomerCounterparty {
  return {
    id: ID(i),
    inn: '',
    name,
    aliases: [],
    address: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    sites,
    sitesVersion: `v${i}`,
  };
}

const ITEMS = [
  cc(1, 'ООО «ФОРТЭКС»', [
    site(1, 'Д56', 'realization_tolling', false, {
      realizationDocs: 51,
      tollingDocs: 8,
      realizationSum: '79470451.57',
      tollingSum: '47075287.96',
    }),
    site(2, 'ПРИМ13', 'tolling_act', true),
  ]),
  cc(2, 'ООО «СУ - 90»', [
    site(3, 'ЗИЛ18', 'tolling_act', false, { tollingDocs: 1 }),
    // 0160: ручной «Материалы подрядчика» поверх реализации из 1С.
    site(4, 'СОБ62', 'contractor_materials', true, { realizationDocs: 3 }),
  ]),
  cc(3, 'Абакаров Халид Сапижуллаевич', []),
];

const apiState = vi.hoisted(() => ({
  urls: [] as string[],
  patches: [] as Array<{ url: string; body: Record<string, unknown> }>,
  patchError: null as Error | null,
}));

vi.mock('../../services/api', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      get: async (url: string) => {
        apiState.urls.push(url);
        if (url.startsWith('/sites')) return { items: [], total: 0 };
        return { items: ITEMS, total: ITEMS.length };
      },
      post: async () => ({}),
      patch: async (url: string, body: Record<string, unknown>) => {
        apiState.patches.push({ url, body });
        if (apiState.patchError) throw apiState.patchError;
        return {};
      },
      delete: async () => ({}),
    },
  };
});

const { default: CustomerCounterpartiesPage } = await import('./CustomerCounterparties');
const { ApiError } = await import('../../services/api');

afterEach(() => {
  cleanup();
  apiState.urls = [];
  apiState.patches = [];
  apiState.patchError = null;
});

function renderPage() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <CustomerCounterpartiesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function th(container: HTMLElement, title: string): HTMLElement {
  return Array.from(container.querySelectorAll<HTMLElement>('.ant-table-thead th')).find(
    (el) => el.textContent?.trim() === title,
  )!;
}

function shownRows(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.ant-table-tbody > tr.ant-table-row')).map(
    (tr) => tr.textContent ?? '',
  );
}

async function openCard(name: string) {
  fireEvent.click(await screen.findByText(name));
  return screen.findByRole('dialog');
}

describe('Контрагенты: колонка «Объекты и вид»', () => {
  it('список с withSites=1, метки «код · вид», ручной вид помечен', async () => {
    renderPage();
    await screen.findByText('ООО «ФОРТЭКС»');
    expect(apiState.urls.some((u) => u.includes('withSites=1'))).toBe(true);
    const tags = screen.getAllByTestId('contractor-site-tag').map((t) => t.textContent);
    expect(tags).toEqual([
      'Д56 · Реализация + давальческий',
      'ПРИМ13 · Давальческий ✎',
      'ЗИЛ18 · Давальческий',
      'СОБ62 · Материалы подрядчика ✎',
    ]);
    const own = screen.getAllByTestId('contractor-site-tag')[3]!;
    expect(own.className).toContain('ant-tag-green');
  });

  it('воронка колонки фильтрует по метке', async () => {
    const { container } = renderPage();
    await screen.findByText('ООО «ФОРТЭКС»');
    fireEvent.click(th(container, 'Объекты и вид').querySelector('.ant-table-filter-trigger')!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      within(dialog).getByText('ЗИЛ18 · Давальческий').closest('label')!.querySelector('input')!,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(shownRows(container)).toHaveLength(1));
    expect(shownRows(container)[0]).toContain('ООО «СУ - 90»');
  });

  it('карточка: без правки объектов `sites` не уходит; после правки — с версией', async () => {
    renderPage();
    let dialog = await openCard('ООО «ФОРТЭКС»');
    expect(within(dialog).getByText(/по 1С: 51 реал\. \/ 8 дав\./)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /Сохранить/ }));
    await waitFor(() => expect(apiState.patches).toHaveLength(1));
    expect(apiState.patches[0]!.body).not.toHaveProperty('sites');
    expect(apiState.patches[0]!.body).not.toHaveProperty('sitesVersion');

    dialog = await openCard('ООО «ФОРТЭКС»');
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Убрать объект' })[0]!);
    fireEvent.click(within(dialog).getByRole('button', { name: /Сохранить/ }));
    await waitFor(() => expect(apiState.patches).toHaveLength(2));
    expect(apiState.patches[1]!.body).toMatchObject({
      sites: [{ siteId: ID(102), kind: 'tolling_act' }],
      sitesVersion: 'v1',
    });
  });

  it('409 по версии — сообщение «откройте карточку заново»', async () => {
    apiState.patchError = new ApiError(409, 'contractor_sites_conflict', 'Conflict');
    renderPage();
    const dialog = await openCard('ООО «ФОРТЭКС»');
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Убрать объект' })[0]!);
    fireEvent.click(within(dialog).getByRole('button', { name: /Сохранить/ }));
    expect(await screen.findByText(/успели изменить — откройте карточку заново/)).toBeTruthy();
  });
});

describe('contractorSitesChanged', () => {
  const a = { siteId: ID(1), kind: 'realization' as const };
  const b = { siteId: ID(2), kind: 'tolling_act' as const };
  it('порядок не важен, вид и состав — важны', () => {
    expect(contractorSitesChanged([a, b], [b, a])).toBe(false);
    expect(contractorSitesChanged([a, b], [a])).toBe(true);
    expect(contractorSitesChanged([a], [{ ...a, kind: 'tolling_act' }])).toBe(true);
    expect(contractorSitesChanged([], [{}])).toBe(true);
  });
});
