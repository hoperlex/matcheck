/**
 * Порядок проверок в /photos/*: сначала ВИДИМОСТЬ (404), потом ПРАВА (403).
 *
 * Обе проверки живут в одном хендлере подряд, и держится порядок сейчас только
 * на комментарии. Переставь их местами — и 404, которым сервер намеренно
 * скрывает существование чужого фото, превратится в 403: «доступа нет, но
 * запись есть». Это утечка, которую не поймает ни один тест про сами права,
 * поэтому проверяем ровно порядок, а не каждую проверку по отдельности.
 *
 * Почему на реальном PostgreSQL: обе ветки решаются запросами к БД (findPhoto с
 * join'ом на родительскую операцию, скоуп подрядчика), на моках проверялась бы
 * выдумка.
 *
 * Запуск:
 *   docker start matcheck-test-pg
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test \
 *     npx vitest run test/integration/permissions-photos.int.test.ts
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
import { photoRoutes } from '../../src/routes/photos.js';
import { registerErrorHandler } from '../../src/lib/error-handler.js';
import permissionsPlugin from '../../src/plugins/permissions.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('матрица прав в /photos/*: видимость раньше прав (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;

  const siteId = randomUUID();
  const managerId = randomUUID();
  const monitorId = randomUUID();
  const contractorId = randomUUID();
  const deliveryId = randomUUID();
  const shipmentId = randomUUID();
  const deliveryPhotoId = randomUUID();
  const shipmentPhotoId = randomUUID();

  const asUser = (role: AuthUser['role'], id: string): AuthUser => ({
    id,
    role,
    siteId: null,
    // Подрядчик без привязанного заказчика: его область видимости пуста, значит
    // ЛЮБОЕ фото для него чужое — ровно то, что нужно для проверки порядка.
    contractorCustomerId: null,
    sessionId: 'sess',
  });

  /** Override как его пишет админский PATCH: строка + сброс кеша. */
  async function denyPage(
    role: string,
    page: 'operations.deliveries' | 'operations.shipments',
    perms: { view?: boolean; create?: boolean; edit?: boolean; delete?: boolean },
  ) {
    await sql`DELETE FROM role_page_permissions WHERE role = ${role} AND page_id = ${page}`;
    await sql`INSERT INTO role_page_permissions
        (role, page_id, can_view, can_create, can_edit, can_delete)
      VALUES (${role}, ${page},
        ${perms.view ?? true}, ${perms.create ?? true},
        ${perms.edit ?? true}, ${perms.delete ?? true})`;
    app.permissions.invalidateLocal();
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
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
    app.addHook('onRequest', async (req) => {
      req.user = currentUser;
    });
    await app.register(permissionsPlugin);
    await app.register(photoRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'PHP'}, 'Photo perms')
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO users (id, email, password_hash, role) VALUES
      (${managerId}, ${`ph-mgr-${managerId}@test`}, 'x', 'manager'),
      (${monitorId}, ${`ph-mon-${monitorId}@test`}, 'x', 'monitor'),
      (${contractorId}, ${`ph-con-${contractorId}@test`}, 'x', 'contractor')
      ON CONFLICT DO NOTHING`;

    const [d] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    const [s] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'shipment' AND code = 'draft' LIMIT 1`;

    await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, version)
      VALUES (${deliveryId}, ${siteId}, ${managerId}, ${d!.id}, 1)`;
    await sql`INSERT INTO shipments (id, site_id, inspector_id, status_id, kind, version)
      VALUES (${shipmentId}, ${siteId}, ${managerId}, ${s!.id}, 'writeoff', 1)`;
    await sql`INSERT INTO delivery_photos (id, delivery_id, kind, s3_key)
      VALUES (${deliveryPhotoId}, ${deliveryId}, 'cargo', ${'test/delivery.jpg'})`;
    await sql`INSERT INTO shipment_photos (id, shipment_id, kind, s3_key)
      VALUES (${shipmentPhotoId}, ${shipmentId}, 'cargo', ${'test/shipment.jpg'})`;

    currentUser = asUser('manager', managerId);
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM shipments WHERE site_id = ${siteId}`;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM role_page_permissions WHERE role IN ('manager', 'monitor', 'contractor')`;
    await sql`DELETE FROM users WHERE id IN (${managerId}, ${monitorId}, ${contractorId})`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`DELETE FROM role_page_permissions`;
    app.permissions.invalidateLocal();
  });

  it('видимое фото при закрытой странице → 403 permission_denied', async () => {
    // monitor видит все операции и проверок видимости для него нет — значит
    // единственная причина отказа здесь это матрица.
    currentUser = asUser('monitor', monitorId);
    await denyPage('monitor', 'operations.deliveries', { view: false });

    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${deliveryPhotoId}/url` });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'permission_denied' });
  });

  it('ЧУЖОЕ фото → 404 not_found, хотя права тоже закрыты', async () => {
    // Тот же запрос, то же закрытое право — но роль, которой это фото не
    // видно. Ответ обязан остаться 404: иначе по коду ответа можно перебором
    // выяснить, какие photoId существуют.
    currentUser = asUser('contractor', contractorId);
    await denyPage('contractor', 'operations.deliveries', { view: false });

    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${deliveryPhotoId}/url` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });

  it('чужое фото и при ОТКРЫТОМ праве остаётся 404', async () => {
    // Контроль к предыдущему тесту: 404 приходит из-за видимости, а не из-за
    // того, что мы забыли открыть право.
    currentUser = asUser('contractor', contractorId);

    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${deliveryPhotoId}/url` });
    expect(res.statusCode).toBe(404);
  });

  it('несуществующее фото → 404 независимо от прав', async () => {
    currentUser = asUser('monitor', monitorId);
    await denyPage('monitor', 'operations.deliveries', { view: false });

    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${randomUUID()}/url` });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH фото отгрузки при закрытой operations.shipments:edit → 403', async () => {
    // Страница берётся из вида РОДИТЕЛЬСКОЙ операции (pageOfKind), а не из
    // маршрута: один и тот же PATCH /photos/:id управляется разными строками
    // матрицы.
    currentUser = asUser('manager', managerId);
    await denyPage('manager', 'operations.shipments', { edit: false });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/photos/${shipmentPhotoId}`,
      payload: { kind: 'document' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'permission_denied' });

    const [row] = await sql<{ kind: string }[]>`
      SELECT kind FROM shipment_photos WHERE id = ${shipmentPhotoId}`;
    expect(row!.kind).toBe('cargo');
  });

  it('PATCH фото приёмки тем же запросом проходит: закрыта только другая страница', async () => {
    currentUser = asUser('manager', managerId);
    await denyPage('manager', 'operations.shipments', { edit: false });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/photos/${deliveryPhotoId}`,
      payload: { kind: 'document' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, kind: 'document' });

    // Возвращаем как было — остальные тесты не должны зависеть от порядка.
    await sql`UPDATE delivery_photos SET kind = 'cargo' WHERE id = ${deliveryPhotoId}`;
  });

  it('без overrides матрица в /photos/* не мешает вовсе', async () => {
    // Позитивный контроль: отказ 403 в тестах выше приходит от матрицы, а не
    // от того, что маршрут сломан. До S3 здесь дело дойти может, поэтому
    // проверяем именно отсутствие отказов доступа.
    currentUser = asUser('monitor', monitorId);

    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${deliveryPhotoId}/url` });
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).not.toBe(404);
  });
});
