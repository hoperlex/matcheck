/**
 * Объединённый журнал «История поступлений»: одна лента, одна пагинация.
 *
 * До него страница делала два независимых запроса по 500 строк и склеивала их
 * в браузере. «Страница» у такой ленты не значила ничего: фильтр по датам и
 * сортировка работали по случайному срезу — при тысячах записей это последние
 * сутки. Здесь проверяется то, ради чего маршрут появился: обе половины ленты
 * приходят вместе, счётчик считает всё, а сортировка и фильтры применяются ко
 * всей выборке.
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
import { reportRoutes } from '../../src/routes/reports.js';
import * as schema from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('журнал движений (реальный PostgreSQL)', { timeout: 60_000 }, () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;

  const siteId = randomUUID();
  const otherSiteId = randomUUID();
  const managerId = randomUUID();
  const inspectorId = randomUUID();
  const deliveryId = randomUUID();
  const shipmentId = randomUUID();
  const foreignDeliveryId = randomUUID();

  const manager = { id: managerId, role: 'manager', siteId: null } as unknown as AuthUser;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    currentUser = manager;
    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql, { schema, casing: 'snake_case' }) as never);
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
    await app.register(reportRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`MV${Date.now() % 10000}`}, 'Журнал движений')`;
    await sql`INSERT INTO sites (id, code, name) VALUES (${otherSiteId}, ${`MW${Date.now() % 10000}`}, 'Чужой объект')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
              VALUES (${managerId}, ${`mv-${managerId}@test`}, 'x', 'manager', NULL)`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
              VALUES (${inspectorId}, ${`mv-${inspectorId}@test`}, 'x', 'inspector_kpp', ${siteId})`;

    const deliveryStatus = (
      await sql<{ id: string }[]>`
        SELECT id FROM statuses WHERE entity_type='delivery' AND code='filled' LIMIT 1`
    )[0]!.id;
    const shipmentStatus = (
      await sql<{ id: string }[]>`
        SELECT id FROM statuses WHERE entity_type='shipment' AND code='shipped' LIMIT 1`
    )[0]!.id;

    await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, arrived_at, version)
              VALUES (${deliveryId}, ${siteId}, ${inspectorId}, ${deliveryStatus}, '2026-08-01T10:00:00Z', 1)`;
    await sql`INSERT INTO delivery_items (id, delivery_id, line_no, name_raw, unit, qty_planned, qty_actual, price)
              VALUES (${randomUUID()}, ${deliveryId}, 1, 'Кирпич журнальный', 'шт', 10, 10, 100)`;

    await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, arrived_at, version)
              VALUES (${foreignDeliveryId}, ${otherSiteId}, ${inspectorId}, ${deliveryStatus}, '2026-08-02T10:00:00Z', 1)`;
    await sql`INSERT INTO delivery_items (id, delivery_id, line_no, name_raw, unit, qty_planned, qty_actual, price)
              VALUES (${randomUUID()}, ${foreignDeliveryId}, 1, 'Кирпич чужой', 'шт', 5, 5, 1000)`;

    await sql`INSERT INTO shipments (id, site_id, kind, status_id, shipped_at, version)
              VALUES (${shipmentId}, ${siteId}, 'contractor', ${shipmentStatus}, '2026-08-03T10:00:00Z', 1)`;
    await sql`INSERT INTO shipment_items (id, shipment_id, line_no, name_raw, unit, qty_planned, qty_actual)
              VALUES (${randomUUID()}, ${shipmentId}, 1, 'Мусор журнальный', 'т', 2, 2)`;
  });

  afterAll(async () => {
    if (!sql) return;
    await app.close();
    await sql`DELETE FROM shipment_items WHERE shipment_id = ${shipmentId}`;
    await sql`DELETE FROM shipments WHERE id = ${shipmentId}`;
    await sql`DELETE FROM delivery_items WHERE delivery_id IN (${deliveryId}, ${foreignDeliveryId})`;
    await sql`DELETE FROM deliveries WHERE id IN (${deliveryId}, ${foreignDeliveryId})`;
    await sql`DELETE FROM users WHERE id IN (${managerId}, ${inspectorId})`;
    await sql`DELETE FROM sites WHERE id IN (${siteId}, ${otherSiteId})`;
    await sql.end({ timeout: 5 });
  });

  const get = async (query: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/reports/movements?${query}` });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      items: Array<{ type: string; rowKey: string; materialName: string; sum: string | null }>;
      total: number;
    };
  };

  it('поступления и отгрузки приходят одной лентой по дате', async () => {
    const body = await get(`siteId=${siteId}`);

    expect(body.items.map((i) => i.type)).toEqual(['shipment', 'intake']);
    expect(body.total).toBe(2);
  });

  it('фильтр по типу применяет сервер', async () => {
    const body = await get(`siteId=${siteId}&type=intake`);

    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.materialName).toBe('Кирпич журнальный');
    expect(body.total).toBe(1);
  });

  it('сортировка по сумме идёт по всей выборке, а не по странице', async () => {
    // Обе приёмки сразу, лимит 1: без серверной сортировки на странице оказался
    // бы просто самый свежий документ, а не самый дорогой.
    const body = await get('sort=sum&order=desc&limit=1&type=intake');

    expect(body.items[0]!.materialName).toBe('Кирпич чужой');
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  it('пагинация: вторая страница продолжает первую', async () => {
    const first = await get(`siteId=${siteId}&limit=1&offset=0`);
    const second = await get(`siteId=${siteId}&limit=1&offset=1`);

    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(first.items[0]!.rowKey).not.toBe(second.items[0]!.rowKey);
    expect(first.total).toBe(2);
  });

  it('инспектор КПП видит только свой объект', async () => {
    currentUser = {
      id: inspectorId,
      role: 'inspector_kpp',
      siteId,
    } as unknown as AuthUser;
    try {
      const body = await get('');
      const foreign = body.items.filter((i) => i.materialName === 'Кирпич чужой');
      expect(foreign).toHaveLength(0);
      expect(body.items.some((i) => i.materialName === 'Кирпич журнальный')).toBe(true);
    } finally {
      currentUser = manager;
    }
  });
});
