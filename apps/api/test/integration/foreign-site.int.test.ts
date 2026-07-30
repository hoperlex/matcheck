/**
 * Интеграционные тесты защиты «чужой объект» на РЕАЛЬНОМ PostgreSQL.
 *
 * Зачем именно интеграционные: проверяемое поведение живёт в SQL —
 * условный `UPDATE ... AND site_id = ?` с `RETURNING` и откат транзакции при
 * нуле задетых строк. На моках это не воспроизводится.
 *
 * Запуск:
 *   docker run -d --name matcheck-test-pg -e POSTGRES_USER=postgres \
 *     -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=matcheck_test \
 *     -p 5444:5432 postgres:16-alpine
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test \
 *     npx tsx scripts/migrate.ts
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test \
 *     npx vitest run test/integration
 *
 * Без TEST_DATABASE_URL набор пропускается — обычный `pnpm test` остаётся
 * зелёным на машине без поднятой БД.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliveryRoutes } from '../../src/routes/deliveries.js';
import { shipmentRoutes } from '../../src/routes/shipments.js';
import { deliveries, shipments, sites, statuses, users } from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('foreign_site guard (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  // Текущий «залогиненный» пользователь — подменяется в каждом тесте.
  let currentUser: AuthUser;

  const siteA = randomUUID();
  const siteB = randomUUID();
  const inspectorA = randomUUID();
  const inspectorB = randomUUID();
  const managerId = randomUUID();
  let filledStatusId: string;
  let shippedStatusId: string;
  // Инъекция побочного эффекта перед обработчиком (см. тест про смену объекта).
  let beforeHandler: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    const db = drizzle(sql, { schema: { deliveries, shipments, sites, statuses, users } });

    app = Fastify();
    // Маршруты объявлены через zod-схемы (asZod) — без этих компиляторов
    // Fastify не соберёт валидацию, как и в реальном server.ts.
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', db as never);
    // Аутентификацию подменяем: тестируем скоуп по объекту, а не JWT.
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = currentUser;
    });
    app.decorate(
      'authorize',
      (...roles: AuthUser['role'][]) =>
        async (req: { user?: AuthUser }, reply: { code: (c: number) => { send: (b: unknown) => void } }) => {
          if (!req.user || !roles.includes(req.user.role)) {
            reply.code(403).send({ error: 'forbidden' });
          }
        },
    );
    // Хук для сценария «строка уехала на другой объект прямо перед обработкой».
    // Регистрируем ДО ready() — после старта Fastify addHook запрещён.
    app.addHook('preHandler', async () => {
      if (beforeHandler) await beforeHandler();
    });
    await app.register(deliveryRoutes);
    await app.register(shipmentRoutes);
    await app.ready();

    // Справочные строки: объекты, пользователи. Статусы уже засеяны миграциями.
    await sql`INSERT INTO sites (id, code, name) VALUES
      (${siteA}, ${'ITA'}, 'Integration A'), (${siteB}, ${'ITB'}, 'Integration B')
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id) VALUES
      (${inspectorA}, ${`ia-${inspectorA}@test`}, 'x', 'inspector_kpp', ${siteA}),
      (${inspectorB}, ${`ib-${inspectorB}@test`}, 'x', 'inspector_kpp', ${siteB}),
      (${managerId}, ${`mgr-${managerId}@test`}, 'x', 'manager', NULL)
      ON CONFLICT DO NOTHING`;

    const [f] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    const [sh] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'shipment' AND code = 'shipped' LIMIT 1`;
    filledStatusId = f!.id;
    shippedStatusId = sh!.id;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteA} OR site_id = ${siteB}`;
    await sql`DELETE FROM shipments WHERE site_id = ${siteA} OR site_id = ${siteB}`;
    await sql`DELETE FROM users WHERE id = ${inspectorA} OR id = ${inspectorB} OR id = ${managerId}`;
    await sql`DELETE FROM sites WHERE id = ${siteA} OR id = ${siteB}`;
    await sql.end({ timeout: 5 });
  });

  const asInspector = (id: string, siteId: string): AuthUser => ({
    id,
    role: 'inspector_kpp',
    siteId,
    contractorCustomerId: null,
    sessionId: randomUUID(),
  });

  async function seedDelivery(siteId: string, inspectorId: string): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, version)
      VALUES (${id}, ${siteId}, ${inspectorId}, ${filledStatusId}, 1)`;
    return id;
  }

  async function seedShipment(siteId: string, inspectorId: string): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO shipments (id, site_id, inspector_id, status_id, kind, version)
      VALUES (${id}, ${siteId}, ${inspectorId}, ${shippedStatusId}, 'contractor', 1)`;
    return id;
  }

  const upsertDelivery = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/deliveries', payload: body });

  it('create с чужим siteId → 403 foreign_site, строка не создана', async () => {
    currentUser = asInspector(inspectorA, siteA);
    const id = randomUUID();

    const res = await upsertDelivery({ id, statusCode: 'filled', siteId: siteB, items: [], sourceDocumentIds: [] });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'foreign_site' });
    const rows = await sql`SELECT id FROM deliveries WHERE id = ${id}`;
    expect(rows).toHaveLength(0);
  });

  it('update чужой приёмки → 403, site_id и version не изменились', async () => {
    const foreignId = await seedDelivery(siteB, inspectorB);
    currentUser = asInspector(inspectorA, siteA);

    const res = await upsertDelivery({
      id: foreignId,
      statusCode: 'filled',
      siteId: siteA,
      items: [],
      sourceDocumentIds: [],
    });

    expect(res.statusCode).toBe(403);
    const [row] = await sql<{ site_id: string; version: number }[]>`
      SELECT site_id, version FROM deliveries WHERE id = ${foreignId}`;
    expect(row!.site_id).toBe(siteB);
    expect(row!.version).toBe(1);
  });

  it('своя приёмка обновляется штатно (version + 1, объект прежний)', async () => {
    const ownId = await seedDelivery(siteA, inspectorA);
    currentUser = asInspector(inspectorA, siteA);

    const res = await upsertDelivery({
      id: ownId,
      statusCode: 'filled',
      siteId: siteA,
      vehiclePlate: 'А111АА777',
      items: [],
      sourceDocumentIds: [],
    });

    expect(res.statusCode).toBe(200);
    const [row] = await sql<{ site_id: string; version: number; vehicle_plate: string }[]>`
      SELECT site_id, version, vehicle_plate FROM deliveries WHERE id = ${ownId}`;
    expect(row!.site_id).toBe(siteA);
    expect(row!.version).toBe(2);
    expect(row!.vehicle_plate).toBe('А111АА777');
  });

  it('строка уехала на другой объект перед обработкой → 403, ничего не изменилось', async () => {
    const ownId = await seedDelivery(siteA, inspectorA);
    currentUser = asInspector(inspectorA, siteA);

    // Менеджер переносит приёмку на другой объект прямо перед обработкой
    // запроса инспектора. Снаружи результат должен быть один: 403 и нетронутые
    // данные. Само условие `AND site_id = ?` в UPDATE проверяется отдельным
    // тестом ниже — на уровне SQL, где конкурентность детерминирована.
    beforeHandler = async () => {
      await sql`UPDATE deliveries SET site_id = ${siteB} WHERE id = ${ownId}`;
      beforeHandler = null; // одноразово, чтобы не влиять на следующие тесты
    };

    const res = await upsertDelivery({
      id: ownId,
      statusCode: 'filled',
      siteId: siteA,
      comment: 'должно откатиться',
      items: [],
      sourceDocumentIds: [],
    });

    expect(res.statusCode).toBe(403);
    const [row] = await sql<{ site_id: string; version: number; comment: string | null }[]>`
      SELECT site_id, version, comment FROM deliveries WHERE id = ${ownId}`;
    expect(row!.site_id).toBe(siteB);
    expect(row!.version).toBe(1);
    expect(row!.comment).toBeNull();
  });

  it('manager переносит приёмку между объектами — разрешено', async () => {
    const id = await seedDelivery(siteA, inspectorA);
    currentUser = {
      id: managerId,
      role: 'manager',
      siteId: null,
      contractorCustomerId: null,
      sessionId: randomUUID(),
    };

    const res = await upsertDelivery({
      id,
      statusCode: 'filled',
      siteId: siteB,
      items: [],
      sourceDocumentIds: [],
    });

    expect(res.statusCode).toBe(200);
    const [row] = await sql<{ site_id: string }[]>`SELECT site_id FROM deliveries WHERE id = ${id}`;
    expect(row!.site_id).toBe(siteB);
  });

  it('contractor не может делать upsert (read-only роль)', async () => {
    currentUser = {
      id: randomUUID(),
      role: 'contractor',
      siteId: null,
      contractorCustomerId: randomUUID(),
      sessionId: randomUUID(),
    };

    const res = await upsertDelivery({
      statusCode: 'filled',
      siteId: siteA,
      items: [],
      sourceDocumentIds: [],
    });

    expect(res.statusCode).toBe(403);
  });

  it('отгрузки: create с чужим siteId → 403, update чужой → 403', async () => {
    currentUser = asInspector(inspectorA, siteA);
    const newId = randomUUID();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/shipments',
      payload: {
        id: newId,
        statusCode: 'shipped',
        kind: 'contractor',
        siteId: siteB,
        items: [],
        sourceDocumentIds: [],
      },
    });
    expect(created.statusCode).toBe(403);
    expect(await sql`SELECT id FROM shipments WHERE id = ${newId}`).toHaveLength(0);

    const foreignId = await seedShipment(siteB, inspectorB);
    const updated = await app.inject({
      method: 'POST',
      url: '/api/v1/shipments',
      payload: {
        id: foreignId,
        statusCode: 'shipped',
        kind: 'contractor',
        siteId: siteA,
        items: [],
        sourceDocumentIds: [],
      },
    });
    expect(updated.statusCode).toBe(403);
    const [row] = await sql<{ site_id: string; version: number }[]>`
      SELECT site_id, version FROM shipments WHERE id = ${foreignId}`;
    expect(row!.site_id).toBe(siteB);
    expect(row!.version).toBe(1);
  });

  it('drizzle-условие AND site_id действительно фильтрует (страховка от опечатки в схеме)', async () => {
    const id = await seedDelivery(siteA, inspectorA);
    const db = drizzle(sql);
    const touched = await db
      .update(deliveries)
      .set({ comment: 'nope' })
      .where(and(eq(deliveries.id, id), eq(deliveries.siteId, siteB)))
      .returning({ id: deliveries.id });
    expect(touched).toHaveLength(0);
  });
});
