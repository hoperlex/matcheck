/** Проверка сохранения признака и списка ролей на реальном PostgreSQL. */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserRole } from '@matcheck/contracts';
import { deliveryRoutes } from '../../src/routes/deliveries.js';
import { deliveries, sites, statuses, users } from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('признак приёмки', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;
  const siteId = randomUUID();
  const deliveryId = randomUUID();

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    const db = drizzle(sql, { schema: { deliveries, sites, statuses, users } });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', db as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = currentUser;
    });
    app.decorate(
      'authorize',
      (...roles: UserRole[]) =>
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

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`PR-${siteId.slice(0, 6)}`}, 'Тест признака')`;
    const [status] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    await sql`INSERT INTO deliveries (id, site_id, status_id)
      VALUES (${deliveryId}, ${siteId}, ${status!.id})`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM deliveries WHERE id = ${deliveryId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  const asRole = (role: UserRole): AuthUser => ({
    id: randomUUID(),
    role,
    siteId: null,
    contractorCustomerId: null,
    sessionId: randomUUID(),
  });
  const patch = (purpose: string) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/deliveries/${deliveryId}/purpose`,
      payload: { purpose },
    });

  it('админ, менеджер и мониторинг могут выбирать; остальные роли не могут', async () => {
    for (const [role, purpose] of [
      ['manager', 'own_forces'],
      ['monitor', 'realization'],
      ['admin', 'tolling_act'],
    ] as const) {
      currentUser = asRole(role);
      const res = await patch(purpose);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ purpose, status: { code: 'filled' } });
      const [row] = await sql<{ purpose: string }[]>`
        SELECT purpose FROM deliveries WHERE id = ${deliveryId}`;
      expect(row!.purpose).toBe(purpose);
    }

    for (const role of ['inspector_kpp', 'contractor', 'observer'] as const) {
      currentUser = asRole(role);
      expect((await patch('own_forces')).statusCode).toBe(403);
    }
    const [row] = await sql<{ purpose: string }[]>`
      SELECT purpose FROM deliveries WHERE id = ${deliveryId}`;
    expect(row!.purpose).toBe('tolling_act');
  });

  it('принимает только три значения', async () => {
    currentUser = asRole('manager');
    expect((await patch('unknown')).statusCode).toBe(400);
  });
});
