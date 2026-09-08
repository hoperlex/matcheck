/**
 * Исход сохранения должен относиться к КОНКРЕТНОЙ мутации.
 *
 * Раньше карточка судила об успехе по «мутации больше нет в очереди», и это
 * врало трижды: синк мог не начаться (шёл параллельный), ошибки гасились в
 * console.warn, а запись удалялась при любом 4xx. В результате конфликт версий
 * показывался зелёным «Приёмка сохранена» — сервер правку отклонил, а человек
 * уходил уверенным, что она записана.
 *
 * Локальная база здесь настоящая (fake-indexeddb), а не набор моков: отправка
 * разложена на фазы «чтение → запрос → фиксация», и проверять её имеет смысл
 * только по фактическому содержимому хранилища — в том числе когда браузер
 * закрывает соединение посреди работы.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModuleNs from './api';
import type { MutationRecord } from '../lib/db';

type ApiModule = typeof ApiModuleNs;

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
  token: { value: 'token' as string | null },
}));

vi.mock('./api', async () => {
  const actual = await vi.importActual<ApiModule>('./api');
  return {
    ...actual,
    api: { post: mocks.apiPost, delete: mocks.apiDelete },
  };
});

vi.mock('./deliveries', () => ({ buildUpsertPayload: () => ({ id: 'delivery-1' }) }));
vi.mock('./shipments', () => ({ buildUpsertPayload: () => ({ id: 'shipment-1' }) }));

vi.mock('../stores/auth', () => ({
  useAuthStore: { getState: () => ({ accessToken: mocks.token.value }) },
}));

const { ApiError, ConflictError } = await import('./api');
const { flushMutation, withQueueLock } = await import('./mutationQueue');
const { db } = await import('../lib/db');

const MUTATION_ID = 'mutation-1';

function mutation(over: Partial<MutationRecord> = {}): MutationRecord {
  return {
    id: MUTATION_ID,
    kind: 'delivery_upsert' as const,
    entityId: 'delivery-1',
    baseVersion: 3,
    payload: null,
    attempts: 0,
    createdAt: Date.now(),
    ...over,
  } as MutationRecord;
}

/** Кладёт в настоящее хранилище мутацию и черновик приёмки, на который она ссылается. */
async function seed(m: MutationRecord | null, withDraft = true): Promise<void> {
  const dbi = await db();
  await dbi.clear('mutations');
  await dbi.clear('deliveries');
  if (m) await dbi.put('mutations', m);
  if (withDraft) {
    await dbi.put('deliveries', {
      id: 'delivery-1',
      server: null,
      local: { comment: 'черновик' },
      tombstone: false,
      version: 3,
      lastSyncedAt: null,
    });
  }
}

async function readMutation(): Promise<MutationRecord | undefined> {
  const dbi = await db();
  return dbi.get('mutations', MUTATION_ID);
}

/**
 * Заставляет ОДНУ транзакцию упасть — так браузер сообщает о закрытом под нами
 * соединении. `when` выбирает момент: до сетевого вызова или после него.
 */
function breakOneTransaction(
  when: () => boolean,
  error: Error = Object.assign(
    new Error(
      "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
    ),
    { name: 'InvalidStateError' },
  ),
): { restore: () => void; thrown: () => boolean } {
  const proto = IDBDatabase.prototype as unknown as {
    transaction: (...args: unknown[]) => unknown;
  };
  const original = proto.transaction;
  let thrown = false;
  proto.transaction = function patched(this: unknown, ...args: unknown[]) {
    if (!thrown && when()) {
      thrown = true;
      throw error;
    }
    return original.apply(this, args as never);
  } as typeof original;
  return {
    restore: () => {
      proto.transaction = original;
    },
    thrown: () => thrown,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.token.value = 'token';
});

describe('flushMutation', () => {
  it('сервер принял — server_acked, мутация снята с очереди', async () => {
    await seed(mutation());
    mocks.apiPost.mockResolvedValue({});

    const result = await flushMutation(MUTATION_ID);

    expect(result.outcome).toBe('server_acked');
    expect(mocks.apiPost).toHaveBeenCalledWith('/deliveries', { id: 'delivery-1' });
    expect(await readMutation()).toBeUndefined();
  });

  it('409 — conflict, а не успех; мутация остаётся с пометкой', async () => {
    await seed(mutation());
    mocks.apiPost.mockRejectedValue(new ConflictError(9, {}));

    const result = await flushMutation(MUTATION_ID);

    expect(result.outcome).toBe('conflict');
    expect(await readMutation()).toMatchObject({ id: MUTATION_ID, conflictPending: true });
  });

  it.each([400, 403, 422])('%i — terminal_error, повтор не поможет', async (status) => {
    await seed(mutation());
    mocks.apiPost.mockRejectedValue(new ApiError(status, 'bad_request', 'Отказано'));

    const result = await flushMutation(MUTATION_ID);

    expect(result.outcome).toBe('terminal_error');
    expect(result.error?.message).toBe('Отказано');
    expect(await readMutation()).toBeUndefined();
  });

  it('нет сети — queued, запись остаётся в очереди', async () => {
    await seed(mutation());
    mocks.apiPost.mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await flushMutation(MUTATION_ID);

    expect(result.outcome).toBe('queued');
    expect(await readMutation()).toMatchObject({ id: MUTATION_ID, attempts: 1 });
  });

  it('без токена не отправляет — queued', async () => {
    await seed(mutation());
    mocks.token.value = null;

    const result = await flushMutation(MUTATION_ID);

    expect(result.outcome).toBe('queued');
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it('5xx — queued: сервер мог быть недоступен временно', async () => {
    await seed(mutation());
    mocks.apiPost.mockRejectedValue(new ApiError(503, 'unavailable', 'Сервис недоступен'));

    const result = await flushMutation(MUTATION_ID);

    expect(result.outcome).toBe('queued');
  });

  it('мутация уже помечена конфликтом — не отправляем повторно', async () => {
    await seed(mutation({ conflictPending: true } as Partial<MutationRecord>));

    const result = await flushMutation(MUTATION_ID);

    expect(result.outcome).toBe('conflict');
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it('черновика приёмки нет в хранилище — отказ, а не молчаливый успех', async () => {
    await seed(mutation(), false);

    const result = await flushMutation(MUTATION_ID);

    expect(result.outcome).toBe('terminal_error');
    expect(mocks.apiPost).not.toHaveBeenCalled();
    expect(await readMutation()).toBeUndefined();
  });

  it('ждёт занятую очередь, а не возвращается сразу', async () => {
    await seed(mutation());
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

  it('соединение закрылось ДО запроса — повтор читает заново, сервер зовём один раз', async () => {
    await seed(mutation());
    mocks.apiPost.mockResolvedValue({});
    const patch = breakOneTransaction(() => mocks.apiPost.mock.calls.length === 0);

    let result;
    try {
      result = await flushMutation(MUTATION_ID);
    } finally {
      patch.restore();
    }

    expect(patch.thrown()).toBe(true);
    expect(result.outcome).toBe('server_acked');
    expect(mocks.apiPost).toHaveBeenCalledTimes(1);
    expect(await readMutation()).toBeUndefined();
  });

  it('соединение закрылось на фиксации ПОСЛЕ ответа — повтор доводит запись', async () => {
    await seed(mutation());
    mocks.apiPost.mockResolvedValue({});
    const patch = breakOneTransaction(() => mocks.apiPost.mock.calls.length > 0);

    let result;
    try {
      result = await flushMutation(MUTATION_ID);
    } finally {
      patch.restore();
    }

    expect(patch.thrown()).toBe(true);
    expect(result.outcome).toBe('server_acked');
    // Ключевое: повторной отправки нет — сервер уже принял запись.
    expect(mocks.apiPost).toHaveBeenCalledTimes(1);
    expect(await readMutation()).toBeUndefined();
  });

  it('сбой фиксации после ответа не возвращает мутацию в очередь', async () => {
    // Не «closing» — такую ошибку withDb не повторяет. Раньше её разбирал общий
    // catch: исход становился queued с ростом attempts, и принятая сервером
    // мутация уходила бы повторно.
    await seed(mutation());
    mocks.apiPost.mockResolvedValue({});
    const patch = breakOneTransaction(
      () => mocks.apiPost.mock.calls.length > 0,
      Object.assign(new Error('локальная база недоступна'), { name: 'UnknownError' }),
    );

    let result;
    try {
      result = await flushMutation(MUTATION_ID);
    } finally {
      patch.restore();
    }

    expect(patch.thrown()).toBe(true);
    expect(result.outcome).toBe('server_acked');
    expect(mocks.apiPost).toHaveBeenCalledTimes(1);
    expect(await readMutation()).toMatchObject({ attempts: 0 });
  });
});
