/**
 * Сжатие ответов: жмём JSON и НЕ трогаем всё остальное.
 *
 * До появления @fastify/compress крупные списки портала (/source-documents,
 * /counterparties?limit=5000) уходили в браузер сырыми — у /api/v1/* не было
 * ни content-encoding, ни Vary: Accept-Encoding, тогда как статику жмёт nginx
 * web-контейнера.
 *
 * Набор фиксирует ровно те границы, на которых включение сжатия могло что-то
 * сломать:
 *  • SSE (/api/v1/events) — поток обязан идти без сжатия, иначе живые события
 *    залипнут в буфере компрессора;
 *  • фото (/photos/:id/content) — image/* уже сжаты, второй проход только жжёт
 *    CPU на контейнере с лимитом в одно ядро;
 *  • мелкие ответы — ниже threshold накладные расходы больше выигрыша.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import compress from '@fastify/compress';

/** Крупный правдоподобный список — как выдача справочника. */
const BIG_LIST = Array.from({ length: 200 }, (_, i) => ({
  id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
  name: `Контрагент № ${i} с достаточно длинным наименованием`,
  inn: `770${String(i).padStart(7, '0')}`,
}));

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Та же конфигурация, что в src/server.ts.
  await app.register(compress, { threshold: 1024, globalDecompression: false });

  app.get('/api/v1/counterparties', async () => BIG_LIST);
  app.get('/api/v1/small', async () => ({ ok: true }));
  app.get('/api/v1/photo', async (_req, reply) => {
    reply.header('content-type', 'image/jpeg');
    // Достаточно крупный «бинарник», чтобы порог не был причиной отказа.
    return reply.send(Buffer.alloc(64 * 1024, 7));
  });
  // Зеркало объявления SSE-маршрута из routes/events.ts.
  app.get('/api/v1/events', { compress: false }, async (_req, reply) => {
    reply.header('content-type', 'text/event-stream');
    return reply.send(`:ok\n\n${'event: ping\ndata: {}\n\n'.repeat(200)}`);
  });

  await app.ready();
  return app;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const GZIP = { 'accept-encoding': 'gzip' };

describe('сжатие ответов', () => {
  it('крупный JSON сжимается', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/counterparties', headers: GZIP });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('сжатый ответ ощутимо меньше исходного', async () => {
    app = await buildApp();
    const raw = await app.inject({
      method: 'GET',
      url: '/api/v1/counterparties',
      headers: { 'accept-encoding': 'identity' },
    });
    const gz = await app.inject({ method: 'GET', url: '/api/v1/counterparties', headers: GZIP });
    expect(gz.headers['content-encoding']).toBe('gzip');
    // Ради этого всё и делалось: списки портала жмутся в разы.
    expect(gz.rawPayload.length).toBeLessThan(raw.rawPayload.length / 3);
  });

  it('ответ помечен Vary: Accept-Encoding — иначе прокси отдадут не тот вариант', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/counterparties', headers: GZIP });
    expect(String(res.headers['vary'] ?? '').toLowerCase()).toContain('accept-encoding');
  });

  it('клиент без accept-encoding получает несжатое', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/counterparties' });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.json()).toHaveLength(BIG_LIST.length);
  });

  it('мелкий ответ ниже threshold не сжимается', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/small', headers: GZIP });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.json()).toEqual({ ok: true });
  });

  it('фото (image/jpeg) НЕ сжимается повторно', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/photo', headers: GZIP });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('SSE-поток НЕ сжимается', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/events', headers: GZIP });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.payload.startsWith(':ok')).toBe(true);
  });
});
