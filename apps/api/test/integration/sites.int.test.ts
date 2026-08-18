/**
 * Изменение активности объектов из централизованного справочника.
 *
 * Без TEST_DATABASE_URL набор пропускается — обычный `pnpm test` остаётся
 * зелёным на машине без поднятой тестовой БД.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { siteRoutes } from '../../src/routes/sites.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('объекты ФОТ (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;

  const fotSiteId = randomUUID();
  const localSiteId = randomUUID();
  const manager: AuthUser = {
    id: randomUUID(),
    role: 'manager',
    siteId: null,
    contractorCustomerId: null,
    sessionId: randomUUID(),
  };
  const externalId = Number.parseInt(fotSiteId.replaceAll('-', '').slice(0, 12), 16);

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql) as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = manager;
    });
    app.decorate(
      'authorize',
      (...roles: AuthUser['role'][]) =>
        async (
          req: { user?: AuthUser },
          reply: { code: (status: number) => { send: (body: unknown) => void } },
        ) => {
          if (!req.user || !roles.includes(req.user.role)) {
            reply.code(403).send({ error: 'forbidden' });
          }
        },
    );
    await app.register(siteRoutes);
    await app.ready();

    await sql`INSERT INTO sites
      (id, code, name, full_name, address, is_active, fot_site_id)
      VALUES
      (${fotSiteId}, ${'МЕ9.9'}, 'ФОТ объект', 'Полное название', 'Адрес', true, ${externalId}),
      (${localSiteId}, ${'LOCAL'}, 'Локальный объект', NULL, NULL, true, NULL)`;
  });

  beforeEach(async () => {
    await sql`UPDATE sites
      SET code = 'LOCAL', name = 'Локальный объект', is_active = true
      WHERE id = ${localSiteId}`;
    await sql`UPDATE sites SET is_active = true WHERE id = ${fotSiteId}`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM sites WHERE id IN (${fotSiteId}, ${localSiteId})`;
    await sql.end({ timeout: 5 });
  });

  it('полная форма может деактивировать ФОТ-объект, не изменяя справочные поля', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sites/${fotSiteId}`,
      payload: {
        code: 'МЕ9.9',
        name: 'ФОТ объект',
        fullName: 'Полное название',
        address: 'Адрес',
        isActive: false,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: fotSiteId, code: 'МЕ9.9', isActive: false });

    const active = await app.inject({
      method: 'GET',
      url: '/api/v1/sites?activeOnly=true&limit=500',
    });
    expect(active.statusCode).toBe(200);
    expect(active.json().items.some((site: { id: string }) => site.id === fotSiteId)).toBe(false);

    const all = await app.inject({ method: 'GET', url: '/api/v1/sites?limit=500' });
    expect(all.statusCode).toBe(200);
    expect(all.json().items).toContainEqual(
      expect.objectContaining({ id: fotSiteId, isActive: false }),
    );
  });

  it('справочные поля ФОТ-объекта по-прежнему нельзя изменять', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sites/${fotSiteId}`,
      payload: { name: 'Локальная подмена', isActive: false },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'fot_readonly' });

    const [row] = await sql<{ name: string; is_active: boolean }[]>`
      SELECT name, is_active FROM sites WHERE id = ${fotSiteId}`;
    expect(row).toEqual({ name: 'ФОТ объект', is_active: true });
  });

  it('локальный объект редактируется как раньше', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sites/${localSiteId}`,
      payload: { code: 'A1', name: 'Новое название', isActive: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: localSiteId,
      code: 'A1',
      name: 'Новое название',
      isActive: false,
    });
  });
});
