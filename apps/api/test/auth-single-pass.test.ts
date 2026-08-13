/**
 * Аутентификация выполняется РОВНО ОДИН раз на запрос.
 *
 * Глобальный onRequest-хук плагина прогоняет attachUser и проставляет req.user,
 * а декоратор app.authenticate висит в preHandler на 159 маршрутах. Пока
 * authenticate не проверял req.user, он гонял attachUser второй раз: ещё одна
 * verifyAccessToken и ещё пара SELECT'ов (sessions + users) на КАЖДЫЙ вызов,
 * включая каждую миниатюру фото. БД внешняя (Yandex Managed PG), поэтому цена
 * дубля — лишний сетевой round-trip на запрос.
 *
 * Тест держит именно счётчик обращений к БД: «работает как раньше» здесь
 * недостаточно — важно, что работы стало вдвое меньше, и что регрессия
 * (кто-то уберёт ранний выход) будет поймана.
 *
 * Вторая половина набора закрывает риск ранней правки в auth-пути: отказы и
 * публичный периметр обязаны вести себя ровно как до неё.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import authPlugin from '../src/plugins/auth.js';
import { signAccessToken } from '../src/domain/auth/jwt.js';
// Имя cookie зависит от COOKIE_SECURE ('__Host-access' против 'access') —
// берём константу, а не литерал, иначе тест ломается от смены окружения.
import { ACCESS_COOKIE_NAME } from '../src/domain/auth/refresh.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const SESSION_ID = '22222222-2222-2222-2222-222222222222';

/** Сколько раз обработчик сходил в БД за строкой (sessions/users). */
let selectCalls = 0;
/** Сколько раз плагин записал отказ в unauthorized_access_log. */
let insertCalls = 0;

/**
 * attachUser делает два запроса подряд: sessions, затем users. Мок отвечает
 * по порядку обращений — так счётчик прямо показывает, сколько ПОЛНЫХ проходов
 * аутентификации случилось: 2 select'а = один проход, 4 = дубль.
 */
function makeDb() {
  return {
    insert: () => ({
      values: async () => {
        insertCalls++;
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            selectCalls++;
            // Нечётные обращения — sessions, чётные — users.
            return selectCalls % 2 === 1
              ? [{ id: SESSION_ID, invalidatedAt: null, userId: USER_ID }]
              : [
                  {
                    id: USER_ID,
                    role: 'manager',
                    isActive: true,
                    siteId: null,
                    contractorCustomerId: null,
                    sessionsInvalidatedAt: null,
                    passwordChangedAt: null,
                  },
                ];
          },
        }),
      }),
    }),
  } as never;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  app.decorate('db', makeDb());
  await app.register(authPlugin);

  // Типичный защищённый маршрут: preHandler дублирует то, что уже сделал
  // глобальный хук.
  app.get('/api/v1/sites', { preHandler: [app.authenticate] }, async (req) => ({
    role: req.user?.role,
  }));
  // Публичный периметр: глобальный хук выходит рано и req.user не ставит.
  app.get('/api/v1/public/sites', async () => ({ ok: 'public' }));
  // Публичный префикс, но маршрут всё же просит аутентификацию — единственная
  // ветка, где attachUser внутри authenticate обязан отработать сам.
  app.get(
    '/api/v1/public/whoami',
    { preHandler: [app.authenticate] },
    async (req) => ({ role: req.user?.role }),
  );
  await app.ready();
  return app;
}

let app: FastifyInstance | undefined;

beforeEach(() => {
  selectCalls = 0;
  insertCalls = 0;
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function validToken(): Promise<string> {
  return await signAccessToken({ sub: USER_ID, role: 'manager', sid: SESSION_ID, aal: 'aal1' });
}

describe('однократная аутентификация', () => {
  it('валидный токен на защищённом маршруте даёт РОВНО одну пару sessions+users', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/sites',
      headers: { authorization: `Bearer ${await validToken()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ role: 'manager' });
    // 2 — один проход. До правки здесь было 4.
    expect(selectCalls).toBe(2);
  });

  it('req.user доступен обработчику, как и раньше', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/sites',
      headers: { authorization: `Bearer ${await validToken()}` },
    });
    expect(res.json()).toEqual({ role: 'manager' });
  });

  it('токен в cookie (путь SSE) тоже проходит один раз', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/sites',
      cookies: { [ACCESS_COOKIE_NAME]: await validToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(selectCalls).toBe(2);
  });
});

describe('отказы не изменились', () => {
  it('без токена — 401 и запись в журнал', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/sites' });
    expect(res.statusCode).toBe(401);
    expect(insertCalls).toBeGreaterThan(0);
    // До БД дело не дошло: токена нет, verify не выполнялся.
    expect(selectCalls).toBe(0);
  });

  it('мусорный токен — 401', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/sites',
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('чужая подпись — 401', async () => {
    app = await buildApp();
    // Валидная структура JWT, но подписана не нашим ключом.
    const forged = [
      Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: USER_ID, sid: SESSION_ID, role: 'admin' })).toString(
        'base64url',
      ),
      Buffer.from('signature').toString('base64url'),
    ].join('.');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/sites',
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('публичный периметр не изменился', () => {
  it('публичный маршрут отвечает без токена и не ходит в БД', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/sites' });
    expect(res.statusCode).toBe(200);
    expect(selectCalls).toBe(0);
  });

  it('публичный маршрут с preHandler сам поднимает пользователя', async () => {
    // Здесь глобальный хук req.user не проставил, поэтому ранний выход не
    // срабатывает и attachUser обязан отработать — ровно один раз.
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/whoami',
      headers: { authorization: `Bearer ${await validToken()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ role: 'manager' });
    expect(selectCalls).toBe(2);
  });

  it('публичный маршрут с preHandler без токена — 401, как и прежде', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/whoami' });
    expect(res.statusCode).toBe(401);
  });
});
