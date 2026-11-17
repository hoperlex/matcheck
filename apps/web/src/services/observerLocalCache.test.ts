// @vitest-environment jsdom
/**
 * Наблюдатель (observer) и локальная база браузера.
 *
 * Наблюдатель видит только свои объекты, а IndexedDB переживает потерю
 * доступа: приёмку перенесли на чужой объект, сервер отвечает 404, а форма
 * подставила бы сохранённую копию. Поэтому:
 *  - снимки операций наблюдателю не пишутся и не читаются;
 *  - запоздалый ответ /sync в его базу не ложится;
 *  - база очищается, когда наблюдатель участвует в смене доступа (другой
 *    человек в том же браузере, смена роли или объектов) — и только тогда:
 *    у инспектора в очереди лежат неотправленные правки;
 *  - запомненный фильтр «Объект» сужается до его объектов.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Delivery, UserDto } from '@matcheck/contracts';

vi.mock('./api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  ApiError: class ApiError extends Error {},
}));

const { useAuthStore } = await import('../stores/auth');
const { useGlobalFiltersStore } = await import('../stores/globalFilters');
const { withDb, getSetting, setSetting } = await import('../lib/db');
const deliveries = await import('./deliveries');
const { reconcileLocalAccess, narrowStickySiteFilter } = await import('./localAccessKey');
const { pullSync } = await import('./sync');
const { api } = await import('./api');

const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SITE_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function userOf(role: UserDto['role'], id: string, siteIds: string[] = []): UserDto {
  return {
    id,
    email: `${id}@test`,
    role,
    isActive: true,
    siteId: null,
    siteIds,
    contractorCustomerId: null,
    phone: null,
    fullName: null,
    createdAt: '2026-11-17T00:00:00Z',
  };
}

const MANAGER = userOf('manager', '11111111-1111-4111-8111-111111111111');
const OBSERVER = userOf('observer', '22222222-2222-4222-8222-222222222222', [SITE_A, SITE_B]);

function deliveryOn(id: string, siteId: string): Delivery {
  return { id, siteId, version: 1 } as unknown as Delivery;
}

async function clearAll() {
  await withDb(async (dbi) => {
    for (const name of ['deliveries', 'shipments', 'source_documents', 'photos', 'mutations', 'references', 'settings'] as const) {
      await dbi.clear(name);
    }
  });
}

beforeEach(async () => {
  await clearAll();
  useAuthStore.getState().clear();
  useGlobalFiltersStore.getState().reset();
  vi.mocked(api.get).mockReset();
});

describe('наблюдатель не пользуется локальной базой', () => {
  it('снимок операции не пишется и не читается', async () => {
    useAuthStore.getState().setUser(OBSERVER);
    await deliveries.upsertServerSnapshot([deliveryOn('d-1', SITE_A)]);
    expect(await withDb((dbi) => dbi.count('deliveries'))).toBe(0);

    // Копия, оставшаяся от прежней роли, наружу не выдаётся: при 404 сервера
    // форма не подставит её вместо отказа.
    await withDb((dbi) =>
      dbi.put('deliveries', {
        id: 'd-old',
        server: deliveryOn('d-old', SITE_C),
        local: null,
        tombstone: false,
        version: 1,
        lastSyncedAt: 0,
      }),
    );
    expect(await deliveries.getDelivery('d-old')).toBeUndefined();
    expect(await deliveries.listLocalDeliveries()).toEqual([]);
  });

  it('у менеджера — как было', async () => {
    useAuthStore.getState().setUser(MANAGER);
    await deliveries.upsertServerSnapshot([deliveryOn('d-1', SITE_A)]);
    expect((await deliveries.getDelivery('d-1'))?.server?.id).toBe('d-1');
  });

  it('запоздалый ответ /sync в базу наблюдателя не ложится', async () => {
    // Запрос ушёл под менеджером, ответ пришёл, когда во вкладке уже наблюдатель.
    useAuthStore.getState().setUser(MANAGER);
    vi.mocked(api.get).mockImplementation(async () => {
      useAuthStore.getState().setUser(OBSERVER);
      return {
        deliveries: [deliveryOn('d-late', SITE_C)],
        shipments: [],
        sourceDocuments: [{ id: 'sd-late' }],
        counterparties: [],
        materials: [],
        sites: [],
        units: [],
        statuses: [],
        deletedIds: [],
        serverNow: '2026-11-17T10:00:00Z',
      } as never;
    });
    await pullSync();
    expect(await withDb((dbi) => dbi.count('deliveries'))).toBe(0);
    expect(await withDb((dbi) => dbi.count('source_documents'))).toBe(0);
    expect(await getSetting('sync_cursor')).toBeNull();
  });
});

describe('ключ доступа локальной базы', () => {
  async function seedManagerData() {
    useAuthStore.getState().setUser(MANAGER);
    await deliveries.upsertServerSnapshot([deliveryOn('d-1', SITE_C)]);
    await setSetting('sync_cursor', '2026-11-17T09:00:00Z');
  }

  it('менеджер → наблюдатель в том же браузере: база и курсор очищены', async () => {
    await seedManagerData();
    await reconcileLocalAccess(MANAGER);
    expect(await reconcileLocalAccess(OBSERVER)).toBe(true);
    expect(await withDb((dbi) => dbi.count('deliveries'))).toBe(0);
    expect(await getSetting('sync_cursor')).toBeNull();
  });

  it('смена объектов наблюдателя очищает; тот же ключ — нет', async () => {
    await reconcileLocalAccess(OBSERVER);
    expect(await reconcileLocalAccess(OBSERVER)).toBe(false);
    expect(await reconcileLocalAccess({ ...OBSERVER, siteIds: [SITE_A] })).toBe(true);
  });

  it('наблюдатель → менеджер: очищено (база наполнялась под другим доступом)', async () => {
    await reconcileLocalAccess(OBSERVER);
    expect(await reconcileLocalAccess(MANAGER)).toBe(true);
  });

  it('без наблюдателя в переходе — не трогаем: у инспектора могут лежать неотправленные правки', async () => {
    const inspector = { ...userOf('inspector_kpp', '33333333-3333-4333-8333-333333333333'), siteId: SITE_A };
    useAuthStore.getState().setUser(inspector);
    await reconcileLocalAccess(inspector);
    await withDb((dbi) =>
      dbi.put('mutations', { id: 'm-1', entityId: 'd-1' } as never),
    );
    expect(await reconcileLocalAccess({ ...inspector, siteId: SITE_B })).toBe(false);
    expect(await withDb((dbi) => dbi.count('mutations'))).toBe(1);
  });
});

describe('запомненный фильтр «Объект»', () => {
  it('у наблюдателя сужается до его объектов', () => {
    useGlobalFiltersStore.getState().set({ siteIds: [SITE_A, SITE_C] });
    narrowStickySiteFilter(OBSERVER);
    expect(useGlobalFiltersStore.getState().siteIds).toEqual([SITE_A]);
  });

  it('у менеджера не трогается', () => {
    useGlobalFiltersStore.getState().set({ siteIds: [SITE_C] });
    narrowStickySiteFilter(MANAGER);
    expect(useGlobalFiltersStore.getState().siteIds).toEqual([SITE_C]);
  });
});
