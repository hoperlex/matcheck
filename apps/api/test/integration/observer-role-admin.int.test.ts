/**
 * Назначение и снятие роли «Наблюдатель» через админку — на живой БД.
 *
 * Проверяется одно свойство, которое нельзя проверить юнит-тестом: смена роли
 * инвалидирует сессии в ОБЕ стороны. Базовое условие в routes/admin/users.ts
 * покрывает только переход «не-web-only → web-only», и обратный перевод
 * observer → manager оставил бы живые сессии. Именно этот случай возникает при
 * откате: перед возвратом старого кода наблюдателей переводят на другую роль, и
 * молча оставшаяся сессия означала бы, что человек продолжает ходить по API с
 * ролью, которой в старом коде нет.
 *
 * Запуск: см. заголовок test/integration/auth-login.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { userAdminRoutes } from '../../src/routes/admin/users.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('роль «Наблюдатель» в админке (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;

  const adminId = randomUUID();
  const targetId = randomUUID();
  const targetEmail = `observer-target-${targetId}@example.com`;

  const admin: AuthUser = {
    id: adminId,
    role: 'admin',
    siteId: null,
    contractorCustomerId: null,
    sessionId: 'sess-admin',
  };

  const patchRole = (role: string) =>
    app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${targetId}`, payload: { role } });

  /** Живые (не инвалидированные) сессии пользователя. */
  const liveSessions = async (): Promise<number> => {
    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM sessions
      WHERE user_id = ${targetId} AND invalidated_at IS NULL`;
    return Number(rows[0]?.n ?? '0');
  };

  const sessionsInvalidatedAt = async (): Promise<Date | null> => {
    const rows = await sql<{ sessions_invalidated_at: Date | null }[]>`
      SELECT sessions_invalidated_at FROM users WHERE id = ${targetId}`;
    return rows[0]?.sessions_invalidated_at ?? null;
  };

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql) as never);
    app.decorate('redis', { publish: async () => 0 } as never);
    app.decorate('authenticate', (async (req: { user?: AuthUser }) => {
      req.user = admin;
    }) as never);
    app.decorate(
      'authorize',
      ((...roles: AuthUser['role'][]) =>
        async (
          req: { user?: AuthUser },
          reply: { code: (c: number) => { send: (b: unknown) => void } },
        ) => {
          if (!req.user || !roles.includes(req.user.role)) {
            reply.code(403).send({ error: 'forbidden' });
          }
        }) as never,
    );
    await app.register(userAdminRoutes);
    await app.ready();

    await sql`INSERT INTO users (id, email, password_hash, role, is_active)
      VALUES (${targetId}, ${targetEmail}, 'x', 'manager', true)`;
  });

  beforeEach(async () => {
    await sql`UPDATE users SET role = 'manager', sessions_invalidated_at = NULL
      WHERE id = ${targetId}`;
    await sql`DELETE FROM sessions WHERE user_id = ${targetId}`;
    await sql`INSERT INTO sessions (id, user_id) VALUES (${randomUUID()}, ${targetId})`;
  });

  afterAll(async () => {
    await sql`DELETE FROM sessions WHERE user_id = ${targetId}`;
    await sql`DELETE FROM users WHERE id = ${targetId}`;
    await app?.close();
    await sql?.end({ timeout: 5 });
  });

  it('роль observer назначается и сохраняется в БД', async () => {
    const res = await patchRole('observer');
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('observer');

    const rows = await sql<{ role: string }[]>`SELECT role FROM users WHERE id = ${targetId}`;
    expect(rows[0]?.role).toBe('observer');
  });

  it('переход manager → observer инвалидирует сессии', async () => {
    expect(await liveSessions()).toBe(1);
    await patchRole('observer');
    expect(await liveSessions()).toBe(0);
    expect(await sessionsInvalidatedAt()).not.toBeNull();
  });

  it('обратный переход observer → manager тоже инвалидирует сессии', async () => {
    // Ровно шаг отката: наблюдателя возвращают в обычную роль. Базовое условие
    // «стал web-only» здесь ложно, и без отдельной ветки сессия осталась бы
    // живой.
    await patchRole('observer');
    await sql`DELETE FROM sessions WHERE user_id = ${targetId}`;
    await sql`UPDATE users SET sessions_invalidated_at = NULL WHERE id = ${targetId}`;
    await sql`INSERT INTO sessions (id, user_id) VALUES (${randomUUID()}, ${targetId})`;
    expect(await liveSessions()).toBe(1);

    const res = await patchRole('manager');
    expect(res.statusCode).toBe(200);
    expect(await liveSessions()).toBe(0);
    expect(await sessionsInvalidatedAt()).not.toBeNull();
  });

  it('смена роли внутри одного класса сессии не трогает', async () => {
    // Контроль на другую крайность: если бы инвалидация срабатывала на любой
    // PATCH, тест выше проходил бы и при полностью сломанном условии.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${targetId}`,
      payload: { fullName: 'Иванов И. И.' },
    });
    expect(res.statusCode).toBe(200);
    expect(await liveSessions()).toBe(1);
  });
});
