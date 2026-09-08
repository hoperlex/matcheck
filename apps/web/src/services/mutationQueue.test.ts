/**
 * Исход сохранения должен относиться к КОНКРЕТНОЙ мутации.
 *
 * Раньше карточка судила об успехе по «мутации больше нет в очереди», и это
 * врало трижды: синк мог не начаться (шёл параллельный), ошибки гасились в
 * console.warn, а запись удалялась при любом 4xx. В результате конфликт версий
 * показывался зелёным «Приёмка сохранена» — сервер правку отклонил, а человек
 * уходил уверенным, что она записана.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModuleNs from './api';

type ApiModule = typeof ApiModuleNs;

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
  dbGet: vi.fn(),
  dbPut: vi.fn(),
  dbDelete: vi.fn(),
  dbGetAll: vi.fn(),
  token: { value: 'token' as string | null },
}));

vi.mock('./api', async () => {
  const actual = await vi.importActual<ApiModule>('./api');
  return {
    ...actual,
    api: { post: mocks.apiPost, delete: mocks.apiDelete },
  };
});

vi.mock('../lib/db', () => ({
  db: async () => ({
    get: mocks.dbGet,
    put: mocks.dbPut,
    delete: mocks.dbDelete,
    getAll: mocks.dbGetAll,
  }),
}));

vi.mock('./deliveries', () => ({ buildUpsertPayload: () => ({ id: 'delivery-1' }) }));
vi.mock('./shipments', () => ({ buildUpsertPayload: () => ({ id: 'shipment-1' }) }));

vi.mock('../stores/auth', () => ({
  useAuthStore: { getState: () => ({ accessToken: mocks.token.value }) },
}));

const { ApiError, ConflictError } = await import('./api');
const { flushMutation, withQueueLock } = await import('./mutationQueue');

const MUTATION_ID = 'mutation-1';

function mutation(over: Record<string, unknown> = {}) {
  return {
    id: MUTATION_ID,
    kind: 'delivery_upsert' as const,
    entityId: 'delivery-1',
    baseVersion: 3,
    payload: null,
    attempts: 0,
    createdAt: Date.now(),
    ...over,
  };
}

/** Хранилище отвечает по имени таблицы: мутация, запись приёмки. */
function storeWith(m: ReturnType<typeof mutation> | undefined) {
  mocks.dbGet.mockImplementation(async (store: string) => {
    if (store === 'mutations') return m;
    if (store === 'deliveries') return { id: 'delivery-1', server: null, local: {}, version: 3 };
    return undefined;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.token.value = 'token';
  mocks.dbGetAll.mockResolvedValue([]);
});

describe('flushMutation', () => {
  it('сервер принял — server_acked, мутация снята с очереди', async () => {
    storeWith(mutation());
    mocks.apiPost.mockResolvedValue({});

    const result = await flushMutation(MUTATION_ID);

    expect(result.outcome).toBe('server_acked');
    expect(mocks.apiPost).toHaveBeenCalledWith('/deliveries', { id: 'delivery-1' });
    expect(mocks.dbDelete).toHaveBeenCalledWith('mutations', MUTATION_ID);
  });

  it('409 — conflict, а не успех; мутация остаётся с пометкой', async () => {
    storeWith(mutation());
    mocks.apiPost.mockRejectedValue(new ConflictError(9, {}));

    const result = await flushMutation(MUTATION_ID);

    expect(result.outcome).toBe('conflict');
    expect(mocks.dbPut).toHaveBeenCalledWith(
      'mutations',
      expect.objectContaining({ id: MUTATION_ID, conflictPending: true }),
    );
    expect(mocks.dbDelete).not.toHaveBeenCalledWith('mutations', MUTATION_ID);
  });

  it.each([400, 403, 422])('%i — terminal_error, повтор не поможет', async (status) => {
    storeWith(mutation());
    mocks.apiPost.mockRejectedValue(new ApiError(status, 'bad_request', 'Отказано'));

    const result = await flushMutation(MUTATION_ID);

    expect(result.outcome).toBe('terminal_error');
    expect(result.error?.message).toBe('Отказано');
    expect(mocks.dbDelete).toHaveBeenCalledWith('mutations', MUTATION_ID);
  });

  it('нет сети — queued, запись остаётся в очереди', async () => {
    storeWith(mutation());
    mocks.apiPost.mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await flushMutation(MUTATION_ID);

    expect(result.outcome).toBe('queued');
    expect(mocks.dbPut).toHaveBeenCalledWith(
      'mutations',
      expect.objectContaining({ id: MUTATION_ID, attempts: 1 }),
    );
    expect(mocks.dbDelete).not.toHaveBeenCalledWith('mutations', MUTATION_ID);
  });

  it('без токена не отправляет — queued', async () => {
    storeWith(mutation());
    mocks.token.value = null;

    const result = await flushMutation(MUTATION_ID);

    expect(result.outcome).toBe('queued');
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it('5xx — queued: сервер мог быть недоступен временно', async () => {
    storeWith(mutation());
    mocks.apiPost.mockRejectedValue(new ApiError(503, 'unavailable', 'Сервис недоступен'));

    const result = await flushMutation(MUTATION_ID);

    expect(result.outcome).toBe('queued');
  });

  it('мутация уже помечена конфликтом — не отправляем повторно', async () => {
    storeWith(mutation({ conflictPending: true }));

    const result = await flushMutation(MUTATION_ID);

    expect(result.outcome).toBe('conflict');
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it('черновика приёмки нет в хранилище — отказ, а не молчаливый успех', async () => {
    mocks.dbGet.mockImplementation(async (store: string) =>
      store === 'mutations' ? mutation() : undefined,
    );

    const result = await flushMutation(MUTATION_ID);

    expect(result.outcome).toBe('terminal_error');
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it('ждёт занятую очередь, а не возвращается сразу', async () => {
    storeWith(mutation());
    mocks.apiPost.mockResolvedValue({});

    // Захватываем очередь заранее — как это делает фоновый синк.
    let release!: () => void;
    const busy = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const holder = withQueueLock(async () => {
      await busy;
      order.push('sync');
    });

    const pending = flushMutation(MUTATION_ID).then((r) => {
      order.push('flush');
      return r;
    });

    // Пока очередь занята, отправки не происходит.
    await Promise.resolve();
    expect(mocks.apiPost).not.toHaveBeenCalled();

    release();
    const [, result] = await Promise.all([holder, pending]);

    expect(order).toEqual(['sync', 'flush']);
    expect(result.outcome).toBe('server_acked');
  });
});
