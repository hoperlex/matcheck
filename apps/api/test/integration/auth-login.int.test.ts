/**
 * Вход на портал: верные логин и пароль пускают ВСЕГДА.
 *
 * Зачем интеграционные: требование держится на связке «SQL-инкремент серии
 * неудач + порядок проверок в хендлере + отсутствие отклоняющих лимитов».
 * На моках проверялась бы выдумка — счётчик серии считает сам Postgres, а
 * cookie и обработчик ошибок влияют на то, каким клиент увидит ответ.
 *
 * Запуск (та же тестовая БД, что у foreign-site.int.test.ts; нужна миграция 0089):
 *   docker run -d --name matcheck-test-pg -e POSTGRES_USER=postgres \
 *     -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=matcheck_test \
 *     -p 5444:5432 postgres:16-alpine
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test \
 *     npx tsx scripts/migrate.ts
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test \
 *     npx vitest run test/integration/auth-login.int.test.ts
 *
 * DATABASE_URL проставляется ниже автоматически: createSessionAndRefresh
 * пишет сессию через модульный db (domain/auth/refresh.ts), а db/client.ts
 * создаёт пул на импорте — то есть до любого beforeAll.
 */
import { randomUUID } from 'node:crypto';
import { vi, afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Выполняется ДО импортов модулей приложения (иначе loadEnv успеет закэшировать
// боевые значения, а db/client.ts — открыть пул к чужой базе).
vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  // Иначе полтора десятка неудач подряд честно проспали бы минуты.
  process.env.AUTH_BACKOFF_BASE_MS = '1';
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
import { registerErrorHandler } from '../../src/lib/error-handler.js';
import { rateLimitErrorResponse } from '../../src/plugins/security.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const PASSWORD = 'Correct-Horse-9!';
const WRONG = 'Wrong-Horse-9!';

suite('POST /auth/login — верный пароль пускает всегда (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let redisCalls: string[];

  const userId = randomUUID();
  const inactiveId = randomUUID();
  const contractorId = randomUUID();
  // Домен обязан быть валидным: LoginRequestSchema проверяет email через
  // zod.email(), а errorHandler намеренно отдаёт на ошибки валидации 500.
  const email = `login-${userId}@example.com`;
  const inactiveEmail = `inactive-${inactiveId}@example.com`;
  const contractorEmail = `contractor-${contractorId}@example.com`;

  const login = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: body, headers });

  const userRow = async (id: string) => {
    const [row] = await sql<
      { failed_login_count: number; locked_until: Date | null; last_failed_login_at: Date | null }[]
    >`SELECT failed_login_count, locked_until, last_failed_login_at FROM users WHERE id = ${id}`;
    return row!;
  };

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    const db = drizzle(sql, { schema: { users, authEvents, sessions, refreshTokens } });

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // Боевая форма, иначе набор зеленел бы при сломанном проде:
    // без cookie веб-вход падает на setCookie, без обработчика ошибок 429
    // отдавался бы не тем, чем в бою.
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
    // Обращения к Redis идут только от burst-лимитера: rate-limit плагин здесь
    // зарегистрирован с in-memory store. Пустой массив = лимитера на login нет.
    redisCalls = [];
    const track =
      (op: string) =>
      async (key: string, ...rest: unknown[]) => {
        redisCalls.push(`${op} ${key}`);
        return op === 'ttl' ? -1 : rest.length;
      };
    app.decorate('redis', {
      incr: track('incr'),
      expire: track('expire'),
      ttl: track('ttl'),
    } as never);
    await app.register(authRoutes);
    await app.ready();

    const hash = await hashPassword(PASSWORD);
    await sql`INSERT INTO users (id, email, password_hash, role, is_active) VALUES
      (${userId}, ${email}, ${hash}, 'manager', true),
      (${inactiveId}, ${inactiveEmail}, ${hash}, 'manager', false),
      (${contractorId}, ${contractorEmail}, ${hash}, 'contractor', true)`;
  });

  beforeEach(async () => {
    redisCalls.length = 0;
    await sql`UPDATE users SET failed_login_count = 0, last_failed_login_at = NULL,
      locked_until = NULL WHERE id = ${userId}`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    const ids = [userId, inactiveId, contractorId];
    await sql`DELETE FROM refresh_tokens WHERE session_id IN
      (SELECT id FROM sessions WHERE user_id = ANY(${ids}))`;
    await sql`DELETE FROM sessions WHERE user_id = ANY(${ids})`;
    await sql`DELETE FROM auth_events WHERE user_id = ANY(${ids})`;
    await sql`DELETE FROM users WHERE id = ANY(${ids})`;
    await sql.end({ timeout: 5 });
  });

  it('главное: залоченный аккаунт с накопленной серией пускает верный пароль', async () => {
    // Ровно состояние, из-за которого всё затевалось: 10 неудач и блокировка
    // на полчаса вперёд. Раньше здесь был 423 независимо от пароля.
    await sql`UPDATE users SET failed_login_count = 10, last_failed_login_at = now(),
      locked_until = now() + interval '30 minutes' WHERE id = ${userId}`;

    const res = await login({ email, password: PASSWORD });

    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTruthy();
    const row = await userRow(userId);
    expect(row.failed_login_count).toBe(0);
    expect(row.locked_until).toBeNull();
    expect(row.last_failed_login_at).toBeNull();
  });

  it('неверный пароль: 401, серия = 1, блокировка не выставляется', async () => {
    const res = await login({ email, password: WRONG });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_credentials');
    const row = await userRow(userId);
    // Именно 1, а не 0: текущая попытка уже учтена в возвращённом значении.
    expect(row.failed_login_count).toBe(1);
    expect(row.locked_until).toBeNull();
  });

  it('15 неудач подряд — по-прежнему 401, ни одного 423 и 429, затем вход проходит', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      codes.push((await login({ email, password: WRONG })).statusCode);
    }

    expect(new Set(codes)).toEqual(new Set([401]));
    expect(await userRow(userId).then((r) => r.failed_login_count)).toBe(15);

    const ok = await login({ email, password: PASSWORD });
    expect(ok.statusCode).toBe(200);
    // Шестнадцать bcrypt при cost 12 — около четырёх секунд даже с нулевым
    // backoff, то есть впритык к дефолтным пяти секундам Vitest.
  }, 30_000);

  it('серия протухает: неудача после часа тишины начинает счёт заново', async () => {
    await sql`UPDATE users SET failed_login_count = 9,
      last_failed_login_at = now() - interval '61 minutes' WHERE id = ${userId}`;

    expect((await login({ email, password: WRONG })).statusCode).toBe(401);
    expect(await userRow(userId).then((r) => r.failed_login_count)).toBe(1);
  });

  it('на login не осталось burst-лимитера: Redis не трогается вовсе', async () => {
    // Без этой проверки возврат лимитера прошёл бы незамеченным: без Redis он
    // fail-open (lib/auth-rate-limit.ts), и остальные сценарии остались бы
    // зелёными.
    await login({ email, password: WRONG });
    await login({ email, password: PASSWORD });

    expect(redisCalls.filter((c) => c.includes('login'))).toEqual([]);
    expect(redisCalls).toEqual([]);
  });

  it('неактивный аккаунт с верным паролем → 401 account_inactive', async () => {
    const res = await login({ email: inactiveEmail, password: PASSWORD });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('account_inactive');
  });

  it('роль contractor с мобильного клиента → 403 web_only_role', async () => {
    const res = await login(
      { email: contractorEmail, password: PASSWORD },
      { 'x-client-type': 'mobile' },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('web_only_role');
  });

  it('сессия, выданная ДО обновления, продолжает работать: refresh ротируется', async () => {
    // Строки в sessions/refresh_tokens кладём руками — ровно так они выглядят
    // у того, кто вошёл на старой версии и остался сидеть в приложении.
    // Структура этих таблиц не менялась, и тест это фиксирует.
    const sessionId = randomUUID();
    const token = `pre-upgrade-${randomUUID()}`;
    await sql`INSERT INTO sessions (id, user_id) VALUES (${sessionId}, ${userId})`;
    await sql`INSERT INTO refresh_tokens
      (session_id, token_hash, expires_at, absolute_expires_at) VALUES
      (${sessionId}, ${sha256Hex(token)}, now() + interval '14 days',
       now() + interval '90 days')`;

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { 'x-client-type': 'mobile', authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTruthy();
    // Ротация состоялась — сессия жива и продлена, а не пересоздана заново.
    expect(res.json().refreshToken).not.toBe(token);
    const [session] = await sql<{ invalidated_at: Date | null }[]>`
      SELECT invalidated_at FROM sessions WHERE id = ${sessionId}`;
    expect(session!.invalidated_at).toBeNull();
  });

  it('несуществующий email → 401 без утечки факта отсутствия аккаунта', async () => {
    const res = await login({ email: 'nobody-does-not-exist@example.com', password: WRONG });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_credentials');
  });
});

suite('POST /auth/refresh — превышение лимита отдаёт 429, а не 500', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 2 });
    const db = drizzle(sql, { schema: { users, authEvents, sessions, refreshTokens } });

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerErrorHandler(app);
    await app.register(cookie);
    await app.register(rateLimit, {
      global: false,
      keyGenerator: () => 'refresh-test-ip',
      errorResponseBuilder: (_req, ctx) => rateLimitErrorResponse(ctx),
    });
    app.decorate('db', db as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = undefined;
    });
    await app.register(authRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await sql?.end({ timeout: 5 });
  });

  it('61-й запрос за минуту → 429 rate_limit_exceeded с русским сообщением', async () => {
    const call = () => app.inject({ method: 'POST', url: '/api/v1/auth/refresh' });

    // Первые 60 проходят к хендлеру и честно отвечают 401 (токена нет).
    for (let i = 0; i < 60; i += 1) {
      expect((await call()).statusCode).toBe(401);
    }

    const limited = await call();
    // До появления RateLimitError здесь было 500 internal_error: плагин бросает
    // результат errorResponseBuilder, а errorHandler читает статус только у
    // HttpError.
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe('rate_limit_exceeded');
    expect(limited.json().message).toMatch(/Повторите через \d+ сек\./);
  });
});
