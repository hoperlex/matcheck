/**
 * Привязка приёмок и отгрузок к сессии, из которой они заведены.
 *
 * Зачем интеграционные: проверяется поведение INSERT/UPDATE и то, что поле НЕ
 * протекает в ответ API. И то и другое живёт на стыке drizzle-схемы, маршрута и
 * zod-сериализации — на моках не воспроизводится.
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
import { syncRoutes } from '../../src/routes/sync.js';
import { deliveries, sessions, shipments, sites, statuses, users } from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('created_by_session_id (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;

  const siteId = randomUUID();
  const inspectorId = randomUUID();
  // Две сессии одного инспектора = два планшета на объекте. Ровно та ситуация,
  // ради которой поле и заводится: без него молчащий планшет неотличим.
  const sessionTablet = randomUUID();
  const sessionPhone = randomUUID();
  let filledStatusId: string;
  let shippedStatusId: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    const db = drizzle(sql, {
      schema: { deliveries, shipments, sites, statuses, users, sessions },
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
    await app.register(syncRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'ICS'}, 'Integration CS')
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
      VALUES (${inspectorId}, ${`ics-${inspectorId}@test`}, 'x', 'inspector_kpp', ${siteId})
      ON CONFLICT DO NOTHING`;
    // Строки сессий обязательны: на поле висит FK. В бою это гарантировано —
    // plugins/auth.ts читает сессию на каждом запросе и без неё не пускает.
    await sql`INSERT INTO sessions (id, user_id) VALUES
      (${sessionTablet}, ${inspectorId}), (${sessionPhone}, ${inspectorId})
      ON CONFLICT DO NOTHING`;

    const [f] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    const [sh] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'shipment' AND code = 'shipped' LIMIT 1`;
    filledStatusId = f!.id;
    shippedStatusId = sh!.id;
    expect(filledStatusId && shippedStatusId).toBeTruthy();
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM shipments WHERE site_id = ${siteId}`;
    await sql`DELETE FROM sessions WHERE user_id = ${inspectorId}`;
    await sql`DELETE FROM users WHERE id = ${inspectorId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  const asInspector = (sessionId: string): AuthUser => ({
    id: inspectorId,
    role: 'inspector_kpp',
    siteId,
    contractorCustomerId: null,
    sessionId,
  });

  const upsertDelivery = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/deliveries', payload: body });
  const upsertShipment = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/shipments', payload: body });

  const deliveryBody = (id: string) => ({
    id,
    statusCode: 'filled',
    siteId,
    items: [],
    sourceDocumentIds: [],
  });

  const sessionOfDelivery = async (id: string) => {
    const [row] = await sql<{ created_by_session_id: string | null }[]>`
      SELECT created_by_session_id FROM deliveries WHERE id = ${id}`;
    return row!.created_by_session_id;
  };

  it('создание приёмки проставляет сессию устройства', async () => {
    currentUser = asInspector(sessionTablet);
    const id = randomUUID();

    const res = await upsertDelivery(deliveryBody(id));

    expect(res.statusCode).toBe(200);
    expect(await sessionOfDelivery(id)).toBe(sessionTablet);
  });

  it('создание отгрузки проставляет сессию устройства', async () => {
    currentUser = asInspector(sessionTablet);
    const id = randomUUID();

    const res = await upsertShipment({
      id,
      statusCode: 'shipped',
      kind: 'contractor',
      siteId,
      items: [],
      sourceDocumentIds: [],
    });

    expect(res.statusCode).toBe(200);
    const [row] = await sql<{ created_by_session_id: string | null }[]>`
      SELECT created_by_session_id FROM shipments WHERE id = ${id}`;
    expect(row!.created_by_session_id).toBe(sessionTablet);
    expect(shippedStatusId).toBeTruthy();
  });

  /**
   * Главное свойство: автор записи — тот, кто её завёл, и это не переписывается.
   * Иначе второй этап с телефона «переклеил» бы приёмку на телефон, и планшет,
   * переставший отправлять, снова стал бы невидим.
   */
  it('обновление с другого устройства не меняет автора', async () => {
    currentUser = asInspector(sessionTablet);
    const id = randomUUID();
    expect((await upsertDelivery(deliveryBody(id))).statusCode).toBe(200);

    currentUser = asInspector(sessionPhone);
    const res = await upsertDelivery({
      ...deliveryBody(id),
      vehiclePlate: 'А111АА777',
      baseVersion: 1,
    });

    expect(res.statusCode).toBe(200);
    expect(await sessionOfDelivery(id)).toBe(sessionTablet);
    const [row] = await sql<{ version: number; vehicle_plate: string | null }[]>`
      SELECT version, vehicle_plate FROM deliveries WHERE id = ${id}`;
    expect(row!.version).toBe(2);
    expect(row!.vehicle_plate).toBe('А111АА777');
  });

  /** Поле служебное — контракт клиента оно менять не должно. */
  it('поле не выводится в ответе API', async () => {
    currentUser = asInspector(sessionTablet);
    const id = randomUUID();

    const res = await upsertDelivery(deliveryBody(id));

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('createdBySessionId');
    expect(body).not.toHaveProperty('created_by_session_id');
    expect(JSON.stringify(body)).not.toContain(sessionTablet);
  });

  /** То же для дельты: планшет не должен получать служебное поле. */
  it('поле не выводится в /sync', async () => {
    currentUser = asInspector(sessionTablet);
    const id = randomUUID();
    expect((await upsertDelivery(deliveryBody(id))).statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/api/v1/sync?windowDays=90' });

    expect(res.statusCode).toBe(200);
    const raw = res.body;
    expect(raw).toContain(id); // приёмка в дельте есть…
    expect(raw).not.toContain('createdBySessionId'); // …а служебного поля нет
    expect(raw).not.toContain('created_by_session_id');
    expect(raw).not.toContain(sessionTablet);
  });

  /**
   * Исторические записи остаются с NULL и продолжают работать: чтение, апдейт,
   * версия. Ради этого поле nullable, а не заполняется задним числом.
   */
  it('запись без сессии обновляется штатно и остаётся с NULL', async () => {
    const id = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, version)
      VALUES (${id}, ${siteId}, ${inspectorId}, ${filledStatusId}, 1)`;

    currentUser = asInspector(sessionPhone);
    const res = await upsertDelivery({ ...deliveryBody(id), baseVersion: 1, driverName: 'Иванов' });

    expect(res.statusCode).toBe(200);
    expect(await sessionOfDelivery(id)).toBeNull();
    const [row] = await sql<{ version: number; driver_name: string | null }[]>`
      SELECT version, driver_name FROM deliveries WHERE id = ${id}`;
    expect(row!.version).toBe(2);
    expect(row!.driver_name).toBe('Иванов');
  });

  /**
   * Контрольный запрос ради которого всё делалось: на объекте с двумя
   * устройствами видно, какое из них перестало присылать записи.
   */
  it('запрос по сессиям различает работающее и молчащее устройство', async () => {
    currentUser = asInspector(sessionTablet);
    expect((await upsertDelivery(deliveryBody(randomUUID()))).statusCode).toBe(200);

    const rows = await sql<{ session_id: string; n: number }[]>`
      SELECT s.id AS session_id, count(d.id)::int AS n
      FROM sessions s
      LEFT JOIN deliveries d
        ON d.created_by_session_id = s.id AND d.site_id = ${siteId}
      WHERE s.user_id = ${inspectorId}
      GROUP BY s.id`;

    const bySession = new Map(rows.map((r) => [r.session_id, r.n]));
    expect(bySession.get(sessionTablet)!).toBeGreaterThan(0);
    expect(bySession.get(sessionPhone)).toBe(0);
  });
});
