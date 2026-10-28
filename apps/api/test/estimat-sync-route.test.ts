/**
 * Кнопка «Обновить» (POST /api/v1/estimat/sync): выключенная синхронизация,
 * отсутствующий воркер, повторное нажатие. BullMQ при занятом jobId молча не
 * ставит задачу — маршрут обязан это распознать, а не ответить «поставлено».
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/plugins/auth.js';

const TOKEN = 'estm_routetest.' + 'r'.repeat(46);
const ORIGINAL = { ...process.env };

type FakeQueue = {
  getWorkersCount: ReturnType<typeof vi.fn>;
  getJob: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
};

let app: FastifyInstance | undefined;

async function build(env: Record<string, string | undefined>, queue: FakeQueue): Promise<FastifyInstance> {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // loadEnv кеширует разбор окружения — свежий экземпляр модулей на каждый вариант.
  vi.resetModules();
  const { estimatRoutes } = await import('../src/routes/estimat.js');
  const instance = Fastify({ logger: false });
  instance.setValidatorCompiler(validatorCompiler);
  instance.setSerializerCompiler(serializerCompiler);
  instance.decorate('db', {} as never);
  instance.decorate('queues', { estimatSync: queue } as never);
  instance.decorate('authenticate', async (req: { user?: AuthUser }) => {
    req.user = { id: '00000000-0000-4000-8000-000000000001', role: 'manager', siteId: null, contractorCustomerId: null, sessionId: 's' };
  });
  instance.decorate('authorize', () => async () => {});
  await instance.register(estimatRoutes);
  await instance.ready();
  return instance;
}

function queue(patch: Partial<FakeQueue> = {}): FakeQueue {
  return {
    getWorkersCount: vi.fn(async () => 1),
    getJob: vi.fn(async () => undefined),
    add: vi.fn(async () => ({})),
    ...patch,
  };
}

const post = (a: FastifyInstance) => a.inject({ method: 'POST', url: '/api/v1/estimat/sync' });

afterEach(async () => {
  await app?.close();
  app = undefined;
  process.env = { ...ORIGINAL };
});

describe('POST /api/v1/estimat/sync', () => {
  it('нет токена — 409 estimat_sync_disabled, задача не ставится', async () => {
    const q = queue();
    app = await build({ ESTIMAT_SYNC_ENABLED: '1', ESTIMAT_API_TOKEN: undefined }, q);
    const res = await post(app);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'estimat_sync_disabled' });
    expect(q.add).not.toHaveBeenCalled();
  });

  it('флаг выключен — 409 estimat_sync_disabled', async () => {
    app = await build({ ESTIMAT_SYNC_ENABLED: '0', ESTIMAT_API_TOKEN: TOKEN }, queue());
    expect((await post(app)).json()).toMatchObject({ error: 'estimat_sync_disabled' });
  });

  it('воркера нет — 409 worker_unavailable, задача не ставится', async () => {
    const q = queue({ getWorkersCount: vi.fn(async () => 0) });
    app = await build({ ESTIMAT_SYNC_ENABLED: '1', ESTIMAT_API_TOKEN: TOKEN }, q);
    const res = await post(app);
    expect(res.json()).toMatchObject({ error: 'worker_unavailable' });
    expect(q.add).not.toHaveBeenCalled();
  });

  it('ручная задача уже стоит — 200 already_queued без постановки', async () => {
    const q = queue({ getJob: vi.fn(async () => ({ data: { requestId: 'other' } })) });
    app = await build({ ESTIMAT_SYNC_ENABLED: '1', ESTIMAT_API_TOKEN: TOKEN }, q);
    const res = await post(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'already_queued' });
    expect(q.add).not.toHaveBeenCalled();
  });

  it('поставлена — 202 queued, постоянный jobId и задача без хранения', async () => {
    let stored: { data: { requestId: string } } | undefined;
    const q = queue({
      getJob: vi.fn(async () => stored),
      add: vi.fn(async (_name: string, data: { requestId: string }) => {
        stored = { data };
        return { data };
      }),
    });
    app = await build({ ESTIMAT_SYNC_ENABLED: '1', ESTIMAT_API_TOKEN: TOKEN }, q);
    const res = await post(app);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'queued' });
    const [name, data, opts] = q.add.mock.calls[0]!;
    expect(name).toBe('manual');
    expect(data).toMatchObject({ trigger: 'manual', userId: '00000000-0000-4000-8000-000000000001' });
    expect(opts).toMatchObject({ jobId: 'estimat-sync-manual', attempts: 1, removeOnComplete: true, removeOnFail: true });
  });

  it('гонка двух нажатий: в очереди чужая задача — already_queued', async () => {
    let calls = 0;
    const q = queue({
      // Первая проверка — пусто, после add — уже лежит чужая постановка.
      getJob: vi.fn(async () => (calls++ === 0 ? undefined : { data: { requestId: 'чужая' } })),
    });
    app = await build({ ESTIMAT_SYNC_ENABLED: '1', ESTIMAT_API_TOKEN: TOKEN }, q);
    expect((await post(app)).json()).toEqual({ status: 'already_queued' });
  });
});
