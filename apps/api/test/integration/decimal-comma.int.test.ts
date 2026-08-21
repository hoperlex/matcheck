/**
 * Десятичная запятая с планшета доходит до numeric, а мусор — до 400.
 *
 * Зачем интеграционные: суть проверки в том, что значение реально ложится в
 * колонку `numeric(18,4)` и запрос не падает на стороне Postgres. На моках это
 * не воспроизводится — именно там раньше и рвалась цепочка: схема пропускала
 * «1,1», а падал уже драйвер, отдавая 500. А 500 мобильный клиент считает
 * транзиентной ошибкой и повторяет мутацию бесконечно.
 *
 * Запуск: см. шапку foreign-site.int.test.ts (тот же TEST_DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliveryRoutes } from '../../src/routes/deliveries.js';
import { shipmentRoutes } from '../../src/routes/shipments.js';
import {
  deliveries,
  deliveryItems,
  deliverySources,
  sessions,
  shipmentItems,
  shipments,
  shipmentSources,
  sites,
  sourceDocumentItems,
  sourceDocuments,
  statuses,
  users,
} from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('десятичная запятая на входе операций (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;

  const siteId = randomUUID();
  const managerId = randomUUID();
  const sessionId = randomUUID();

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    const db = drizzle(sql, {
      schema: {
        deliveries,
        deliveryItems,
        deliverySources,
        sessions,
        shipments,
        shipmentItems,
        shipmentSources,
        sites,
        sourceDocuments,
        sourceDocumentItems,
        statuses,
        users,
      },
    });

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', db as never);
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
    await app.register(shipmentRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'IDC'}, 'Integration decimal')
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
      VALUES (${managerId}, ${`idc-${managerId}@test`}, 'x', 'manager', ${siteId})
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO sessions (id, user_id) VALUES (${sessionId}, ${managerId})
      ON CONFLICT DO NOTHING`;

    currentUser = {
      id: managerId,
      role: 'manager',
      siteId: null,
      contractorCustomerId: null,
      sessionId,
    };
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM shipments WHERE site_id = ${siteId}`;
    await sql`DELETE FROM sessions WHERE user_id = ${managerId}`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  /**
   * Две операции проверяются одним набором сценариев: разъехаться их правила
   * приёма чисел не должны — планшет шлёт запятую в обе.
   */
  const ops = [
    {
      name: 'приёмка',
      url: '/api/v1/deliveries',
      body: (id: string, items: unknown[]) => ({
        id,
        statusCode: 'filled',
        siteId,
        items,
        sourceDocumentIds: [],
      }),
      qtyOf: (id: string) =>
        sql<{ qty_actual: string | null; price: string | null }[]>`
          SELECT qty_actual, price FROM delivery_items WHERE delivery_id = ${id}`,
    },
    {
      name: 'отгрузка',
      url: '/api/v1/shipments',
      body: (id: string, items: unknown[]) => ({
        id,
        statusCode: 'shipped',
        kind: 'contractor',
        siteId,
        items,
        sourceDocumentIds: [],
      }),
      qtyOf: (id: string) =>
        sql<{ qty_actual: string | null; price: string | null }[]>`
          SELECT qty_actual, price FROM shipment_items WHERE shipment_id = ${id}`,
    },
  ] as const;

  const item = (extra: Record<string, unknown>) => ({
    nameRaw: 'Кабель силовой ВВГнг 3х2.5',
    unit: 'м',
    lineNo: 1,
    ...extra,
  });

  for (const op of ops) {
    const post = (body: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: op.url, payload: body });

    it(`${op.name}: создание с количеством «1,1» сохраняется`, async () => {
      const id = randomUUID();
      const res = await post(op.body(id, [item({ qtyActual: '1,1', price: '1 200,50' })]));
      expect(res.statusCode, res.body).toBe(200);

      const rows = await op.qtyOf(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.qty_actual).toBe('1.1000');
      expect(rows[0]!.price).toBe('1200.5000');
    });

    it(`${op.name}: обновление существующей операции с «1,1»`, async () => {
      const id = randomUUID();
      const created = await post(op.body(id, [item({ qtyActual: '2' })]));
      expect(created.statusCode, created.body).toBe(200);

      const updated = await post(op.body(id, [item({ qtyActual: '3,25' })]));
      expect(updated.statusCode, updated.body).toBe(200);

      const rows = await op.qtyOf(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.qty_actual).toBe('3.2500');
    });

    it(`${op.name}: портальный формат с точкой ведёт себя как раньше`, async () => {
      const id = randomUUID();
      const res = await post(op.body(id, [item({ qtyActual: '1.1', price: '10.5' })]));
      expect(res.statusCode, res.body).toBe(200);

      const rows = await op.qtyOf(id);
      expect(rows[0]!.qty_actual).toBe('1.1000');
      expect(rows[0]!.price).toBe('10.5000');
    });

    it(`${op.name}: мусор и переполнение дают 400, а не 500`, async () => {
      const garbage = await post(op.body(randomUUID(), [item({ qtyActual: 'две штуки' })]));
      expect(garbage.statusCode, garbage.body).toBe(400);
      // Тело — общая ErrorResponseSchema {error, message?}: code/statusCode она
      // отбрасывает, поэтому проверяем путь поля в сообщении.
      expect(garbage.body).toContain('qtyActual');

      // vat_rate — numeric(5,2): 999.995 округляется до 1000.00 и раньше давало
      // numeric field overflow, то есть 500 и вечный ретрай на планшете.
      const overflow = await post(op.body(randomUUID(), [item({ vatRate: '999.995' })]));
      expect(overflow.statusCode, overflow.body).toBe(400);
      expect(overflow.body).toContain('vatRate');
    });
  }
});
