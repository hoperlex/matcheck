import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { registerErrorHandler } from '../src/lib/error-handler.js';
import { badRequest, HttpError } from '../src/lib/http-error.js';

/**
 * Lightweight-приложение: только компилятор валидации + наш обработчик.
 * Поднимать весь server.ts не нужно — проверяем ровно выбор статуса.
 */
function buildApp() {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  registerErrorHandler(app);

  app.get('/throws-400', async () => {
    throw badRequest('Некорректная дата в параметре arrivedTo');
  });

  app.get('/throws-plain', async () => {
    throw new Error('boom');
  });

  /** Чужая ошибка со statusCode — НЕ HttpError. Статус брать не должны. */
  app.get('/throws-foreign-400', async () => {
    const err = new Error('foreign') as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  });

  app.get(
    '/validated',
    { schema: { querystring: z.object({ arrivedTo: z.string().datetime().optional() }) } },
    async () => ({ ok: true }),
  );

  app.get('/reply-403', async (_req, reply) => {
    reply.code(403);
    throw new Error('forbidden');
  });

  app.get('/throws-409-details', async () => {
    throw new HttpError(409, 'конфликт', { conflicts: [{ page: 'stats', action: 'view' }] });
  });

  app.get('/throws-500-details', async () => {
    throw new HttpError(500, 'сломалось', { sql: 'select * from users where token = $1' });
  });

  /** Чужая ошибка с 4xx и полем details — деталей отдавать не должны. */
  app.get('/foreign-with-details', async (_req, reply) => {
    reply.code(400);
    const err = new Error('foreign') as Error & { details: unknown };
    err.details = { secret: 'не для клиента' };
    throw err;
  });

  return app;
}

describe('errorHandler', () => {
  it('HttpError(400) отдаётся как 400, а не 500', async () => {
    // Регресс: старый обработчик смотрел ТОЛЬКО на reply.statusCode
    // (`if (reply.statusCode < 400) reply.code(500)`), поэтому валидация
    // дат физически не могла ответить 400.
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/throws-400' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('arrivedTo');
    await app.close();
  });

  it('невалидный .datetime()-параметр ОСТАЁТСЯ 500 — совместимость с мобилой', async () => {
    // Намеренно не 400. Мобильный MutationProcessor.kt:256 на 4xx делает
    // Drop (мутация удаляется вместе с данными приёмки), на 5xx — Backoff.
    // Замерено: до этих правок валидация отдавала 500. Меняем — теряем
    // мутации у инспекторов. Статус берём только у своих HttpError.
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/validated?arrivedTo=abc' });
    expect(res.statusCode).toBe(500);
    await app.close();
  });

  it('чужая ошибка со statusCode 400 не меняет статус — остаётся 500', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/throws-foreign-400' });
    expect(res.statusCode).toBe(500);
    await app.close();
  });

  it('валидный .datetime()-параметр проходит', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/validated?arrivedTo=2026-07-13T21:00:00.000Z',
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('ошибка без статуса остаётся 500', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/throws-plain' });
    expect(res.statusCode).toBe(500);
    await app.close();
  });

  it('уже выставленный reply.statusCode имеет приоритет', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/reply-403' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('4xx HttpError отдаёт details — клиенту нужен разбор, а не фраза', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/throws-409-details' });
    expect(res.statusCode).toBe(409);
    expect(res.json().details).toEqual({ conflicts: [{ page: 'stats', action: 'view' }] });
    await app.close();
  });

  it('5xx не отдаёт details никогда — в них попадает SQL с параметрами', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/throws-500-details' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).not.toHaveProperty('details');
    await app.close();
  });

  it('чужая ошибка с 4xx деталей не получает', async () => {
    // Поле `details` у произвольной ошибки нам не принадлежит: отдавая его
    // наружу, мы бы публиковали внутренности библиотек.
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/foreign-with-details' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).not.toHaveProperty('details');
    await app.close();
  });
});
