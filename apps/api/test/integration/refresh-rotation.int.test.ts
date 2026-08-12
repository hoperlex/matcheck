/**
 * Ротация refresh-токена: потерянный ответ не должен разлогинивать человека,
 * но кража по-прежнему обязана убивать сессию.
 *
 * Зачем интеграционные: всё требование держится на поведении Postgres —
 * блокировке строки сессии, условном UPDATE (CAS) и на времени, которое считает
 * сама БД через clock_timestamp(). На моках проверялась бы выдумка: гонка двух
 * ротаций и «кто победил» существуют только при настоящих транзакциях.
 *
 * Запуск (та же тестовая БД, что у auth-login.int.test.ts; нужна миграция 0093):
 *   docker run -d --name matcheck-test-pg -e POSTGRES_USER=postgres \
 *     -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=matcheck_test \
 *     -p 5444:5432 postgres:16-alpine
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test \
 *     npx tsx scripts/migrate.ts
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test \
 *     npx vitest run test/integration/refresh-rotation.int.test.ts
 *
 * Про выключенный grace см. соседний refresh-rotation-grace-off.int.test.ts:
 * значение читается один раз на импорте модуля, поэтому живёт отдельным файлом.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { vi, afterAll, beforeAll, describe, expect, it } from 'vitest';

// Выполняется ДО импортов приложения: db/client.ts открывает пул на импорте,
// а domain/auth/refresh.ts работает именно через этот модульный db.
vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { authRoutes } from '../../src/routes/auth.js';
import { authEvents, refreshTokens, sessions, users } from '../../src/db/schema.js';
import { hashPassword } from '../../src/domain/auth/password.js';
import { sha256Hex } from '../../src/domain/auth/crypto.js';
import { createSessionAndRefresh, rotateRefreshToken } from '../../src/domain/auth/refresh.js';
import { registerErrorHandler } from '../../src/lib/error-handler.js';
import { rateLimitErrorResponse } from '../../src/plugins/security.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const PASSWORD = 'Correct-Horse-9!';
const IP = '10.0.0.1';
const UA = 'vitest';

suite('POST /auth/refresh — повтор потерянного ответа против кражи (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;

  const userId = randomUUID();
  const email = `refresh-${userId}@example.com`;

  /** Свежая сессия: возвращает первый (ещё не ротированный) refresh-токен. */
  const freshSession = async () => {
    const issued = await createSessionAndRefresh(userId, IP, UA);
    return { sessionId: issued.sessionId, token: issued.token };
  };

  const sessionAlive = async (sessionId: string) => {
    const [row] = await sql<{ invalidated_at: Date | null }[]>`
      SELECT invalidated_at FROM sessions WHERE id = ${sessionId}`;
    return row!.invalidated_at === null;
  };

  const activeTokenCount = async (sessionId: string) => {
    const [row] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM refresh_tokens
      WHERE session_id = ${sessionId} AND revoked_at IS NULL`;
    return Number(row!.n);
  };

  const eventCount = async (sessionId: string, event: string) => {
    const [row] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM auth_events
      WHERE event = ${event} AND meta->>'sessionId' = ${sessionId}`;
    return Number(row!.n);
  };

  const replacementIdOf = async (token: string) => {
    const [row] = await sql<{ replaced_by_id: string | null }[]>`
      SELECT replaced_by_id FROM refresh_tokens WHERE token_hash = ${sha256Hex(token)}`;
    return row!.replaced_by_id;
  };

  /** Отодвигает отзыв токена в прошлое — иначе пришлось бы ждать окно вживую. */
  const ageRevocation = async (token: string, interval: string) => {
    await sql`UPDATE refresh_tokens SET revoked_at = revoked_at - ${interval}::interval
      WHERE token_hash = ${sha256Hex(token)}`;
  };

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    const db = drizzle(sql, { schema: { users, authEvents, sessions, refreshTokens } });

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerErrorHandler(app);
    await app.register(cookie);
    await app.register(rateLimit, {
      global: false,
      keyGenerator: () => 'test-ip',
      errorResponseBuilder: (_req, ctx) => rateLimitErrorResponse(ctx),
    });
    app.decorate('db', db as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = undefined;
    });
    app.decorate('redis', {
      incr: async () => 1,
      expire: async () => 1,
      ttl: async () => -1,
    } as never);
    await app.register(authRoutes);
    await app.ready();

    const hash = await hashPassword(PASSWORD);
    await sql`INSERT INTO users (id, email, password_hash, role, is_active)
      VALUES (${userId}, ${email}, ${hash}, 'manager', true)`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM refresh_tokens WHERE session_id IN
      (SELECT id FROM sessions WHERE user_id = ${userId})`;
    await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
    await sql`DELETE FROM auth_events WHERE user_id = ${userId}`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  it('главное: два параллельных refresh одним токеном дают ОДИН и тот же новый токен', async () => {
    // Ровно случай, из-за которого всё затевалось: клиент (мобильный без
    // mutex'а либо вкладка, не дождавшаяся ответа) шлёт refresh дважды.
    const { sessionId, token } = await freshSession();

    const [a, b] = await Promise.all([
      rotateRefreshToken(token, IP, UA),
      rotateRefreshToken(token, IP, UA),
    ]);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.newToken).toBe(b!.newToken);
    // Ровно один победил ротацию, второй получил повтор.
    expect([a!.replayed, b!.replayed].sort()).toEqual([false, true]);
    expect(await activeTokenCount(sessionId)).toBe(1);
    expect(await sessionAlive(sessionId)).toBe(true);
    expect(await eventCount(sessionId, 'refresh_reuse_detected')).toBe(0);
    expect(await eventCount(sessionId, 'refresh_success')).toBe(1);
    expect(await eventCount(sessionId, 'refresh_grace_replay')).toBe(1);
  });

  it('выданный при повторе токен — настоящий: проходит следующую ротацию', async () => {
    // Иначе повтор возвращал бы «успокоительную» строку, которая развалится
    // на следующем же обновлении — через 15 минут, уже вне теста.
    const { sessionId, token } = await freshSession();
    const [a, b] = await Promise.all([
      rotateRefreshToken(token, IP, UA),
      rotateRefreshToken(token, IP, UA),
    ]);
    const replayed = (a!.replayed ? a : b)!;

    const next = await rotateRefreshToken(replayed.newToken, IP, UA);

    expect(next).not.toBeNull();
    expect(next!.replayed).toBe(false);
    expect(next!.newToken).not.toBe(replayed.newToken);
    expect(await sessionAlive(sessionId)).toBe(true);
  });

  it('повтор старого токена внутри окна: 200, та же замена, сессия жива', async () => {
    const { sessionId, token } = await freshSession();
    const first = await rotateRefreshToken(token, IP, UA);

    const again = await rotateRefreshToken(token, IP, UA);

    expect(again).not.toBeNull();
    expect(again!.replayed).toBe(true);
    expect(again!.newToken).toBe(first!.newToken);
    // Повтор не продлевает жизнь: срок остаётся от исходной ротации.
    expect(again!.expiresAt.getTime()).toBe(first!.expiresAt.getTime());
    expect(await sessionAlive(sessionId)).toBe(true);
    expect(await activeTokenCount(sessionId)).toBe(1);
  });

  it('повтор ПОСЛЕ окна: 401 и сессия убита — защита от кражи на месте', async () => {
    const { sessionId, token } = await freshSession();
    await rotateRefreshToken(token, IP, UA);
    await ageRevocation(token, '10 minutes');

    const late = await rotateRefreshToken(token, IP, UA);

    expect(late).toBeNull();
    expect(await sessionAlive(sessionId)).toBe(false);
    expect(await eventCount(sessionId, 'refresh_reuse_detected')).toBe(1);
  });

  it('клиент отстал на два шага (замена уже ротирована): 401 и сессия убита', async () => {
    // Принятая граница: повтор обслуживается ровно на один шаг цепочки.
    const { sessionId, token } = await freshSession();
    const second = await rotateRefreshToken(token, IP, UA);
    await rotateRefreshToken(second!.newToken, IP, UA);

    const stale = await rotateRefreshToken(token, IP, UA);

    expect(stale).toBeNull();
    expect(await sessionAlive(sessionId)).toBe(false);
    expect(await eventCount(sessionId, 'refresh_reuse_detected')).toBe(1);
  });

  it('замена просрочена по обычному TTL: повтора нет', async () => {
    const { sessionId, token } = await freshSession();
    await rotateRefreshToken(token, IP, UA);
    const replacementId = await replacementIdOf(token);
    await sql`UPDATE refresh_tokens SET expires_at = now() - interval '1 minute'
      WHERE id = ${replacementId}`;

    expect(await rotateRefreshToken(token, IP, UA)).toBeNull();
    expect(await sessionAlive(sessionId)).toBe(false);
  });

  it('замена просрочена по абсолютному пределу: повтора нет', async () => {
    // Отдельным случаем от rolling TTL: именно absolute ограничивает
    // бесконечное продление сессии, и повтор не должен его обходить.
    const { sessionId, token } = await freshSession();
    await rotateRefreshToken(token, IP, UA);
    const replacementId = await replacementIdOf(token);
    await sql`UPDATE refresh_tokens SET absolute_expires_at = now() - interval '1 minute'
      WHERE id = ${replacementId}`;

    expect(await rotateRefreshToken(token, IP, UA)).toBeNull();
    expect(await sessionAlive(sessionId)).toBe(false);
  });

  it('замена числится за другой сессией: повтора нет', async () => {
    const { sessionId, token } = await freshSession();
    const other = await freshSession();
    await rotateRefreshToken(token, IP, UA);
    const replacementId = await replacementIdOf(token);
    await sql`UPDATE refresh_tokens SET session_id = ${other.sessionId} WHERE id = ${replacementId}`;

    expect(await rotateRefreshToken(token, IP, UA)).toBeNull();
    expect(await sessionAlive(sessionId)).toBe(false);
  });

  it('замена выпущена не из этого токена (чужой ключ вывода): повтора нет', async () => {
    // Страховка на случай, если строка-замена появилась мимо нашей схемы:
    // ручная правка, легаси до этой версии, другой keyring.
    const { sessionId, token } = await freshSession();
    await rotateRefreshToken(token, IP, UA);
    const replacementId = await replacementIdOf(token);
    await sql`UPDATE refresh_tokens SET token_hash = ${sha256Hex('чужой-токен')}
      WHERE id = ${replacementId}`;

    expect(await rotateRefreshToken(token, IP, UA)).toBeNull();
    expect(await sessionAlive(sessionId)).toBe(false);
  });

  it('гонка «повтор против ротации потомка»: исход зависит от порядка, оба детерминированы', async () => {
    // Порядок 1 — повтор успел раньше: клиент получает ту же замену.
    const first = await freshSession();
    const firstChild = await rotateRefreshToken(first.token, IP, UA);
    const replayFirst = await rotateRefreshToken(first.token, IP, UA);
    expect(replayFirst!.newToken).toBe(firstChild!.newToken);
    expect(await sessionAlive(first.sessionId)).toBe(true);
    await rotateRefreshToken(firstChild!.newToken, IP, UA);
    expect(await sessionAlive(first.sessionId)).toBe(true);

    // Порядок 2 — ротация потомка успела раньше: цепочка ушла на два шага,
    // и повтор уже неотличим от кражи.
    const second = await freshSession();
    const secondChild = await rotateRefreshToken(second.token, IP, UA);
    await rotateRefreshToken(secondChild!.newToken, IP, UA);
    expect(await rotateRefreshToken(second.token, IP, UA)).toBeNull();
    expect(await sessionAlive(second.sessionId)).toBe(false);
  });

  it('серия повторов: один refresh_success, остальные — refresh_grace_replay', async () => {
    const { sessionId, token } = await freshSession();

    await rotateRefreshToken(token, IP, UA);
    await rotateRefreshToken(token, IP, UA);
    await rotateRefreshToken(token, IP, UA);

    expect(await eventCount(sessionId, 'refresh_success')).toBe(1);
    expect(await eventCount(sessionId, 'refresh_grace_replay')).toBe(2);
    expect(await eventCount(sessionId, 'refresh_reuse_detected')).toBe(0);
    expect(await sessionAlive(sessionId)).toBe(true);
  });

  it('совместимость: сессия, выпущенная ДО обновления, продолжает работать', async () => {
    // Строка ровно в том виде, в каком она лежит в проде прямо сейчас: токен
    // выдан прежним кодом (случайные 32 байта), никакого вывода из ключа. Так
    // выглядят все живые сессии планшетов в момент выката — они обязаны
    // ротироваться дальше, а не оказаться разлогинены обновлением.
    const legacySessionId = randomUUID();
    const legacyToken = randomBytes(32).toString('base64url');
    await sql`INSERT INTO sessions (id, user_id) VALUES (${legacySessionId}, ${userId})`;
    await sql`INSERT INTO refresh_tokens (session_id, token_hash, expires_at, absolute_expires_at)
      VALUES (${legacySessionId}, ${sha256Hex(legacyToken)},
              now() + interval '14 days', now() + interval '90 days')`;

    const rotated = await rotateRefreshToken(legacyToken, IP, UA);

    expect(rotated).not.toBeNull();
    expect(rotated!.replayed).toBe(false);
    expect(rotated!.newToken).toBeTruthy();
    expect(await sessionAlive(legacySessionId)).toBe(true);
    expect(await activeTokenCount(legacySessionId)).toBe(1);
    // И следующая ротация тоже проходит — клиент вошёл в новую схему без входа заново.
    expect(await rotateRefreshToken(rotated!.newToken, IP, UA)).not.toBeNull();
  });

  it('совместимость: цепочка, ротированная старым кодом, ведёт себя как раньше', async () => {
    // До обновления замена выпускалась случайным токеном, вывести её из
    // родителя нечем — повтор обслужить невозможно. Проверяем, что это ровно
    // ПРЕЖНЕЕ поведение (401 + инвалидация), а не новая поломка: клиент,
    // потерявший ответ ещё до выката, и раньше получал разлогин.
    const legacySessionId = randomUUID();
    const legacyParent = randomBytes(32).toString('base64url');
    const legacyChild = randomBytes(32).toString('base64url');
    const childId = randomUUID();
    await sql`INSERT INTO sessions (id, user_id) VALUES (${legacySessionId}, ${userId})`;
    await sql`INSERT INTO refresh_tokens (id, session_id, token_hash, expires_at, absolute_expires_at)
      VALUES (${childId}, ${legacySessionId}, ${sha256Hex(legacyChild)},
              now() + interval '14 days', now() + interval '90 days')`;
    await sql`INSERT INTO refresh_tokens (session_id, token_hash, expires_at, absolute_expires_at,
              revoked_at, replaced_by_id)
      VALUES (${legacySessionId}, ${sha256Hex(legacyParent)},
              now() + interval '14 days', now() + interval '90 days', now(), ${childId})`;

    expect(await rotateRefreshToken(legacyParent, IP, UA)).toBeNull();
    expect(await sessionAlive(legacySessionId)).toBe(false);
  });

  it('чужая блокировка сессии: ошибка вместо null — сессия и токен остаются рабочими', async () => {
    // Худший случай новой транзакции: строка сессии кем-то занята (замерший
    // event-loop, зависшая транзакция). Ждать вечно нельзя — стоит lock_timeout.
    // Проверяем главное: по таймауту функция БРОСАЕТ, а не возвращает null.
    // null означал бы «сессия мертва» → 401 → разлогин, то есть ровно та беда,
    // которую вся правка и убирает. Исключение уходит клиенту как 500, а его ни
    // web, ни мобильный клиент смертью сессии не считают.
    const { sessionId, token } = await freshSession();

    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = sql.begin(async (tx) => {
      await tx`SELECT id FROM sessions WHERE id = ${sessionId} FOR UPDATE`;
      markLocked();
      await held;
    });
    await locked;

    await expect(rotateRefreshToken(token, IP, UA)).rejects.toThrow();

    release();
    await blocker;

    // Ничего не сгорело: сессия жива, токен не отозван — клиент повторит и войдёт.
    expect(await sessionAlive(sessionId)).toBe(true);
    expect(await activeTokenCount(sessionId)).toBe(1);
    const afterRelease = await rotateRefreshToken(token, IP, UA);
    expect(afterRelease).not.toBeNull();
    expect(afterRelease!.replayed).toBe(false);
  }, 20_000);

  it('инвалидированная сессия повтором не оживает: смена пароля и админ по-прежнему выкидывают', async () => {
    // Обратная регресс-защита: окно повтора не должно стать лазейкой в обход
    // принудительного выхода (смена пароля, снятие доступа админом).
    const { sessionId, token } = await freshSession();
    const child = await rotateRefreshToken(token, IP, UA);
    await sql`UPDATE sessions SET invalidated_at = now() WHERE id = ${sessionId}`;

    // Ни живой токен, ни повтор старого не проходят.
    expect(await rotateRefreshToken(child!.newToken, IP, UA)).toBeNull();
    expect(await rotateRefreshToken(token, IP, UA)).toBeNull();
  });

  it('через HTTP (web, cookie): повтор отдаёт 200 и ту же cookie, а не выкидывает на логин', async () => {
    // Боевая форма веб-ветки: токен приходит и уходит только через cookie —
    // именно там и терялся Set-Cookie у клиентов с оборванным запросом.
    const { sessionId, token } = await freshSession();
    const call = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { refresh: token },
      });

    const first = await call();
    const again = await call();

    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    const cookieOf = (res: Awaited<ReturnType<typeof call>>) =>
      res.cookies.find((c) => c.name === 'refresh')?.value;
    expect(cookieOf(again)).toBe(cookieOf(first));
    expect(again.json().accessToken).toBeTruthy();
    expect(await sessionAlive(sessionId)).toBe(true);
  });

  it('через HTTP (mobile, Bearer): повтор возвращает тот же refreshToken в теле', async () => {
    const { token } = await freshSession();
    const call = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { 'x-client-type': 'mobile', authorization: `Bearer ${token}` },
      });

    const first = await call();
    const again = await call();

    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    expect(again.json().refreshToken).toBe(first.json().refreshToken);
  });
});
