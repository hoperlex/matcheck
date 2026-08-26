/**
 * Фильтр по отметке проверки исполняется только с правом «Проверять».
 *
 * Селект «Проверка» на панели скрыт правом матрицы, но параметр `?review=` из
 * чужой ссылки сервер применял в любом случае: человек без права получал
 * урезанный список и ни одного признака того, что фильтр включён.
 *
 * Запуск: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test
 * Без переменной набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliveryRoutes } from '../../src/routes/deliveries.js';
import * as schema from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('фильтр ?review= и право «Проверять»', { timeout: 60_000 }, () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;

  const siteId = randomUUID();
  const managerId = randomUUID();
  const inspectorId = randomUUID();
  const approved = randomUUID();
  const untouched = randomUUID();

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    currentUser = { id: managerId, role: 'manager', siteId: null } as unknown as AuthUser;
    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql, { schema, casing: 'snake_case' }) as never);
    // Матрица выключена: право определяется ролью (canSeeReview), то есть
    // менеджеру фильтр доступен, инспектору КПП — нет.
    app.decorate('permissions', {
      enforced: false,
      get: async () => new Map(),
      invalidateLocal: () => {},
      invalidateEverywhere: async () => {},
    } as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = currentUser;
    });
    app.decorate(
      'authorize',
      (...roles: AuthUser['role'][]) =>
        async (
          req: { user?: AuthUser },
          reply: { code: (c: number) => { send: (b: unknown) => void } },
        ) => {
          if (!req.user || !roles.includes(req.user.role)) {
            reply.code(403).send({ error: 'forbidden' });
          }
        },
    );
    await app.register(deliveryRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`RV${Date.now() % 10000}`}, 'Отметка проверки')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
              VALUES (${managerId}, ${`rv-${managerId}@test`}, 'x', 'manager', NULL)`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
              VALUES (${inspectorId}, ${`rv-${inspectorId}@test`}, 'x', 'inspector_kpp', ${siteId})`;
    const statusId = (
      await sql<{ id: string }[]>`
        SELECT id FROM statuses WHERE entity_type='delivery' AND code='filled' LIMIT 1`
    )[0]!.id;
    await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, arrived_at, review_state, version)
              VALUES (${approved}, ${siteId}, ${inspectorId}, ${statusId}, now(), 'approved', 1)`;
    await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, arrived_at, version)
              VALUES (${untouched}, ${siteId}, ${inspectorId}, ${statusId}, now(), 1)`;
  });

  afterAll(async () => {
    if (!sql) return;
    await app.close();
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM users WHERE id IN (${managerId}, ${inspectorId})`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  const ids = async (): Promise<string[]> => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/deliveries?siteIds=${siteId}&reviewState=approved&limit=200`,
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { items: { id: string }[] }).items.map((d) => d.id);
  };

  it('менеджеру фильтр работает', async () => {
    const list = await ids();

    expect(list).toContain(approved);
    expect(list).not.toContain(untouched);
  });

  it('инспектору КПП тот же параметр из ссылки ничего не сужает', async () => {
    currentUser = { id: inspectorId, role: 'inspector_kpp', siteId } as unknown as AuthUser;
    try {
      const list = await ids();

      expect(list).toContain(approved);
      expect(list).toContain(untouched);
    } finally {
      currentUser = { id: managerId, role: 'manager', siteId: null } as unknown as AuthUser;
    }
  });
});
