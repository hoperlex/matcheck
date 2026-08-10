/**
 * Ветвление upsert: create или edit — на РЕАЛЬНОМ PostgreSQL.
 *
 * Самое хрупкое место всей фичи. POST /api/v1/deliveries — единственный
 * маршрут, дающий право «Создавать» на Операциях, и он же даёт «Редактировать».
 * Различить их по наличию `input.id` НЕЛЬЗЯ: офлайн-запись с планшета КПП
 * приходит с уже сгенерированным на клиенте UUID. Решает наличие строки в
 * БД — а это проверяется только против настоящей базы.
 *
 * Запуск:
 *   docker start matcheck-test-pg
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test \
 *     npx vitest run test/integration/permissions-upsert.int.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.PERMISSIONS_ENFORCE = '1';
  process.env.REDIS_URL = 'redis://127.0.0.1:6399';
});

import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { deliveryRoutes } from '../../src/routes/deliveries.js';
import { shipmentRoutes } from '../../src/routes/shipments.js';
import { registerErrorHandler } from '../../src/lib/error-handler.js';
import permissionsPlugin from '../../src/plugins/permissions.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('матрица прав: create и edit различаются наличием строки (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;

  const siteId = randomUUID();
  const managerId = randomUUID();
  // Реальная строка в sessions: deliveries.created_by_session_id ссылается на
  // неё внешним ключом, и выдуманный UUID уронил бы INSERT.
  const sessionId = randomUUID();
  let filledStatusId: string;
  let draftShipmentStatusId: string;

  const upsert = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/deliveries', payload: body });

  const payload = (id: string) => ({
    id,
    statusCode: 'filled',
    siteId,
    items: [],
    sourceDocumentIds: [],
  });

  const shipmentUpsert = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/shipments', payload: body });

  // writeoff — единственный вид, которому не нужен получатель: тест про права,
  // а не про validateKindLinks.
  const shipmentPayload = (id: string) => ({
    id,
    statusCode: 'draft',
    kind: 'writeoff',
    siteId,
    items: [],
    sourceDocumentIds: [],
  });

  /** Записать override и сбросить кеш, как это делает админский PATCH. */
  async function setPermissions(
    perms: {
      view?: boolean;
      create?: boolean;
      edit?: boolean;
      delete?: boolean;
    },
    page: 'operations.deliveries' | 'operations.shipments' = 'operations.deliveries',
  ) {
    await sql`DELETE FROM role_page_permissions WHERE role = 'manager' AND page_id = ${page}`;
    await sql`INSERT INTO role_page_permissions
        (role, page_id, can_view, can_create, can_edit, can_delete)
      VALUES ('manager', ${page},
        ${perms.view ?? true}, ${perms.create ?? true},
        ${perms.edit ?? true}, ${perms.delete ?? true})`;
    app.permissions.invalidateLocal();
  }

  async function seedDelivery(): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, version)
      VALUES (${id}, ${siteId}, ${managerId}, ${filledStatusId}, 1)`;
    return id;
  }

  async function seedShipment(): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO shipments (id, site_id, inspector_id, status_id, kind, version)
      VALUES (${id}, ${siteId}, ${managerId}, ${draftShipmentStatusId}, 'writeoff', 1)`;
    return id;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    // Полная схема: buildShipmentDto ходит в связанные таблицы, частичной ему мало.
    const db = drizzle(sql, { schema });

    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerErrorHandler(app);
    app.decorate('db', db as never);
    app.decorate('redis', { publish: async () => 0 } as never);
    app.decorate('logUnauthorized', async () => {});
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
    // Как настоящий authPlugin: заполняет req.user до хуков плагина прав.
    app.addHook('onRequest', async (req) => {
      req.user = currentUser;
    });
    await app.register(permissionsPlugin);
    await app.register(deliveryRoutes);
    await app.register(shipmentRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'PRM'}, 'Permissions upsert')
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO users (id, email, password_hash, role) VALUES
      (${managerId}, ${`perm-mgr-${managerId}@test`}, 'x', 'manager') ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO sessions (id, user_id) VALUES (${sessionId}, ${managerId})
      ON CONFLICT DO NOTHING`;

    const [f] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    filledStatusId = f!.id;

    const [d] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'shipment' AND code = 'draft' LIMIT 1`;
    draftShipmentStatusId = d!.id;

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
    await sql`DELETE FROM shipments WHERE site_id = ${siteId}`;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM role_page_permissions WHERE role = 'manager'`;
    await sql`DELETE FROM sessions WHERE id = ${sessionId}`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`DELETE FROM role_page_permissions WHERE role = 'manager'`;
    app.permissions.invalidateLocal();
  });

  it('create=false, edit=true: НОВАЯ запись → 403, СУЩЕСТВУЮЩАЯ → 200', async () => {
    await setPermissions({ create: false, edit: true });

    // Клиент присылает собственный UUID — ровно как офлайн-планшет.
    const freshId = randomUUID();
    const created = await upsert(payload(freshId));
    expect(created.statusCode).toBe(403);
    expect(created.json()).toMatchObject({ error: 'permission_denied' });
    expect(await sql`SELECT id FROM deliveries WHERE id = ${freshId}`).toHaveLength(0);

    const existingId = await seedDelivery();
    const edited = await upsert(payload(existingId));
    expect(edited.statusCode).toBe(200);
  });

  it('create=true, edit=false: НОВАЯ запись → 200, СУЩЕСТВУЮЩАЯ → 403', async () => {
    await setPermissions({ create: true, edit: false });

    const freshId = randomUUID();
    const created = await upsert(payload(freshId));
    expect(created.statusCode).toBe(200);
    expect(await sql`SELECT id FROM deliveries WHERE id = ${freshId}`).toHaveLength(1);

    const existingId = await seedDelivery();
    const edited = await upsert(payload(existingId));
    expect(edited.statusCode).toBe(403);
    // Запись не тронута: version остался прежним.
    const [row] = await sql<{ version: number }[]>`
      SELECT version FROM deliveries WHERE id = ${existingId}`;
    expect(row!.version).toBe(1);
  });

  it('POST без id при create=false тоже 403', async () => {
    await setPermissions({ create: false, edit: true });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/deliveries',
      payload: { statusCode: 'filled', siteId, items: [], sourceDocumentIds: [] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('отказ приходит как permission_denied с кодом 403, а не как 500', async () => {
    // Если бы PermissionError не наследовал HttpError, общий обработчик отдал
    // бы 500 — а на 5xx мобильный MutationProcessor делает Backoff вместо
    // Drop, и очередь мутаций на планшете встала бы намертво.
    await setPermissions({ create: false });
    const res = await upsert(payload(randomUUID()));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'permission_denied' });
  });

  it('без overrides (дефолт) upsert работает в обе стороны', async () => {
    const freshId = randomUUID();
    expect((await upsert(payload(freshId))).statusCode).toBe(200);
    expect((await upsert(payload(freshId))).statusCode).toBe(200);
  });

  // Отгрузки — вторая, симметричная реализация того же ветвления в другом
  // файле (routes/shipments.ts). Одинаковый код ещё не значит одинаковое
  // поведение: разойтись они могут при любой будущей правке одного из двух.
  it('shipments: create=false, edit=true → новая 403, существующая 200', async () => {
    await setPermissions({ create: false, edit: true }, 'operations.shipments');

    const freshId = randomUUID();
    const created = await shipmentUpsert(shipmentPayload(freshId));
    expect(created.statusCode).toBe(403);
    expect(created.json()).toMatchObject({ error: 'permission_denied' });
    expect(await sql`SELECT id FROM shipments WHERE id = ${freshId}`).toHaveLength(0);

    const existingId = await seedShipment();
    const edited = await shipmentUpsert(shipmentPayload(existingId));
    expect(edited.statusCode).toBe(200);
  });

  it('shipments: create=true, edit=false → новая 200, существующая 403', async () => {
    await setPermissions({ create: true, edit: false }, 'operations.shipments');

    const freshId = randomUUID();
    const created = await shipmentUpsert(shipmentPayload(freshId));
    expect(created.statusCode).toBe(200);
    expect(await sql`SELECT id FROM shipments WHERE id = ${freshId}`).toHaveLength(1);

    const existingId = await seedShipment();
    const edited = await shipmentUpsert(shipmentPayload(existingId));
    expect(edited.statusCode).toBe(403);
    const [row] = await sql<{ version: number }[]>`
      SELECT version FROM shipments WHERE id = ${existingId}`;
    expect(row!.version).toBe(1);
  });
});
