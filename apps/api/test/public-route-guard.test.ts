/**
 * Инвариант публичного периметра: без авторизации открыт РОВНО префикс
 * /api/v1/public/ — и ничего сверх него.
 *
 * Почему это отдельный тест. Отсутствие `preHandler: app.authenticate` роут
 * публичным не делает: глобальный onRequest-хук режет всё, чего нет в
 * whitelist. Ровно на этом однажды молча умерла share-фича — роут был объявлен
 * «публичным», а отвечал 401. И обратная ошибка тоже возможна: если матчить
 * сырой req.url вместо шаблона роута, приватный эндпоинт откроется всем,
 * стоит подсунуть `/api/v1/public/` в query или traversal.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, describe, expect, it } from 'vitest';
import authPlugin from '../src/plugins/auth.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Плагин auth читает access-токен из cookie как fallback для SSE —
  // без @fastify/cookie req.cookies не существует.
  await app.register(cookie);
  // Плагин пишет отказы в unauthorized_access_log — от БД нужен только insert.
  app.decorate('db', {
    insert: () => ({ values: async () => undefined }),
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
  } as never);
  await app.register(authPlugin);

  app.get('/api/v1/public/sites', async () => ({ ok: 'public' }));
  app.get('/api/v1/public/upload-documents/:ticket', async () => ({ ok: 'public-param' }));
  app.get('/api/v1/sites', async () => ({ ok: 'private' }));
  app.get('/api/v1/source-documents', async () => ({ ok: 'private-list' }));
  await app.ready();
  return app;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('публичный namespace /api/v1/public/', () => {
  it('роут под префиксом отвечает без токена', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/sites' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: 'public' });
  });

  it('параметризованный публичный роут тоже открыт', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/upload-documents/abcdefghij',
    });
    expect(res.statusCode).toBe(200);
  });

  it('обычный роут без токена по-прежнему 401', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/sites' });
    expect(res.statusCode).toBe(401);
  });

  it('публичный префикс в query приватный роут НЕ открывает', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/sites?next=/api/v1/public/sites',
    });
    expect(res.statusCode).toBe(401);
  });

  it('traversal через публичный префикс приватный роут НЕ открывает', async () => {
    app = await buildApp();
    // Fastify нормализует путь и приземляет запрос на приватный шаблон —
    // решение принимается по шаблону, а не по написанию в строке запроса.
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/../sites' });
    expect(res.statusCode).toBe(401);
  });

  it('несуществующий путь под публичным префиксом даёт 404, а не доступ', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/nope' });
    // routeOptions.url на 404 отсутствует → работает прежняя ветка (401).
    expect([401, 404]).toContain(res.statusCode);
  });

});
