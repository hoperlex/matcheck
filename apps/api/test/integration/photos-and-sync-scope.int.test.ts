/**
 * Интеграционные тесты (реальный PostgreSQL):
 *  - скоуп фото: presign и confirm обязаны различать «чужой объект» и
 *    «чужой автор» и не пускать read-only роли;
 *  - окно /sync и /sync/reconcile: незавершённые 2 Этапа доезжают, но дельта
 *    не возвращает их бесконечно (иначе клиент листает без остановки).
 *
 * Как запускать — см. шапку foreign-site.int.test.ts.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { photoRoutes } from '../../src/routes/photos.js';
import { syncRoutes } from '../../src/routes/sync.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('скоуп фото и окно sync (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;

  const siteA = randomUUID();
  const siteB = randomUUID();
  const inspectorA = randomUUID();
  const inspectorA2 = randomUUID(); // тот же объект, другой автор
  const inspectorB = randomUUID();
  let filledStatusId: string;
  let confirmedStatusId: string;

  // Приёмки: своя, чужая по объекту, своя по объекту но чужого автора.
  let ownDelivery: string;
  let foreignSiteDelivery: string;
  let sameSiteOtherAuthor: string;
  let ownPhotoId: string;
  let foreignPhotoId: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql) as never);
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
    await app.register(photoRoutes);
    await app.register(syncRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES
      (${siteA}, ${'PSA'}, 'PhotoSync A'), (${siteB}, ${'PSB'}, 'PhotoSync B')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id) VALUES
      (${inspectorA}, ${`pa-${inspectorA}@test`}, 'x', 'inspector_kpp', ${siteA}),
      (${inspectorA2}, ${`pa2-${inspectorA2}@test`}, 'x', 'inspector_kpp', ${siteA}),
      (${inspectorB}, ${`pb-${inspectorB}@test`}, 'x', 'inspector_kpp', ${siteB})`;

    const [f] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    const [c] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'confirmed_mol' LIMIT 1`;
    filledStatusId = f!.id;
    confirmedStatusId = c!.id;

    ownDelivery = await seedDelivery(siteA, inspectorA, filledStatusId);
    foreignSiteDelivery = await seedDelivery(siteB, inspectorB, filledStatusId);
    sameSiteOtherAuthor = await seedDelivery(siteA, inspectorA2, filledStatusId);
    ownPhotoId = await seedPhoto(ownDelivery);
    foreignPhotoId = await seedPhoto(foreignSiteDelivery);
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteA} OR site_id = ${siteB}`;
    await sql`DELETE FROM users WHERE id = ${inspectorA} OR id = ${inspectorA2} OR id = ${inspectorB}`;
    await sql`DELETE FROM sites WHERE id = ${siteA} OR id = ${siteB}`;
    await sql.end({ timeout: 5 });
  });

  async function seedDelivery(siteId: string, inspectorId: string, statusId: string): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, version)
      VALUES (${id}, ${siteId}, ${inspectorId}, ${statusId}, 1)`;
    return id;
  }

  async function seedPhoto(deliveryId: string): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO delivery_photos
      (id, delivery_id, kind, s3_key, content_hash, idempotency_key, taken_at)
      VALUES (${id}, ${deliveryId}, 'cargo', ${`k/${id}.jpg`}, ${id.slice(0, 12)}, ${randomUUID()}, now())`;
    return id;
  }

  const asInspector = (id: string, siteId: string): AuthUser => ({
    id,
    role: 'inspector_kpp',
    siteId,
    contractorCustomerId: null,
    sessionId: randomUUID(),
  });

  const presign = (deliveryId: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/photos/presign',
      payload: {
        operationKind: 'delivery',
        operationId: deliveryId,
        kind: 'cargo',
        contentType: 'image/jpeg',
        // contentHash по контракту — ровно 64 hex-символа (sha256).
        contentHash: randomUUID().replace(/-/g, '').repeat(2),
        idempotencyKey: randomUUID(),
      },
    });

  const confirm = (photoId: string) =>
    app.inject({ method: 'POST', url: `/api/v1/photos/${photoId}/confirm` });

  it('presign: чужой объект → 403 foreign_site', async () => {
    currentUser = asInspector(inspectorA, siteA);
    const res = await presign(foreignSiteDelivery);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'foreign_site' });
  });

  it('presign: свой объект, но чужой автор → 403 forbidden', async () => {
    currentUser = asInspector(inspectorA, siteA);
    const res = await presign(sameSiteOtherAuthor);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('presign: своя запись своего объекта — доступ есть (не 403)', async () => {
    currentUser = asInspector(inspectorA, siteA);
    const res = await presign(ownDelivery);
    // S3 в тестовом окружении не настроен: маршрут отдаёт 200 с пустыми URL.
    // Нам важно только, что скоуп пропустил.
    expect(res.statusCode).not.toBe(403);
  });

  it('presign: contractor и monitor не допускаются', async () => {
    for (const role of ['contractor', 'monitor'] as const) {
      currentUser = {
        id: randomUUID(),
        role,
        siteId: null,
        contractorCustomerId: role === 'contractor' ? randomUUID() : null,
        sessionId: randomUUID(),
      };
      const res = await presign(ownDelivery);
      expect(res.statusCode).toBe(403);
    }
  });

  it('confirm: чужой объект → 403 foreign_site (раньше был 404)', async () => {
    currentUser = asInspector(inspectorA, siteA);
    const res = await confirm(foreignPhotoId);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'foreign_site' });
  });

  it('confirm: свой объект, чужой автор → 403 forbidden', async () => {
    const photoOfOtherAuthor = await seedPhoto(sameSiteOtherAuthor);
    currentUser = asInspector(inspectorA, siteA);
    const res = await confirm(photoOfOtherAuthor);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('confirm: contractor не допускается', async () => {
    currentUser = {
      id: randomUUID(),
      role: 'contractor',
      siteId: null,
      contractorCustomerId: randomUUID(),
      sessionId: randomUUID(),
    };
    const res = await confirm(ownPhotoId);
    expect(res.statusCode).toBe(403);
  });

  describe('окно /sync для незавершённых 2 Этапа', () => {
    const OLD_DAYS = 200;

    beforeAll(async () => {
      // 501 старая незавершённая приёмка (filled, updated_at 200 дней назад) —
      // ровно на границе лимита 500, чтобы поймать и обрезание, и цикл.
      await sql`
        INSERT INTO deliveries (id, site_id, inspector_id, status_id, version, created_at, updated_at)
        SELECT gen_random_uuid(), ${siteA}, ${inspectorA}, ${filledStatusId}, 1,
               now() - ${`${OLD_DAYS} days`}::interval, now() - ${`${OLD_DAYS} days`}::interval
        FROM generate_series(1, 501)`;
      // Плюс одна старая ЗАВЕРШЁННАЯ — она приезжать не должна.
      await sql`
        INSERT INTO deliveries (id, site_id, inspector_id, status_id, version, created_at, updated_at)
        VALUES (gen_random_uuid(), ${siteA}, ${inspectorA}, ${confirmedStatusId}, 1,
                now() - ${`${OLD_DAYS} days`}::interval, now() - ${`${OLD_DAYS} days`}::interval)`;
    });

    it('initial-sync отдаёт незавершённые старше окна (в пределах лимита страницы)', async () => {
      currentUser = asInspector(inspectorA, siteA);
      const res = await app.inject({ method: 'GET', url: '/api/v1/sync?windowDays=90' });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { deliveries: { id: string; status: { code: string } }[] };
      // Лимит страницы — 500; все отданные записи должны быть незавершёнными
      // (старые confirmed_mol в окно не попадают).
      expect(body.deliveries.length).toBe(500);
      expect(body.deliveries.every((d) => d.status.code === 'filled')).toBe(true);
    });

    it('дельта-sync НЕ возвращает старые незавершённые — иначе клиент листает бесконечно', async () => {
      currentUser = asInspector(inspectorA, siteA);
      const since = new Date(Date.now() - 60 * 1000).toISOString();
      const res = await app.inject({ method: 'GET', url: `/api/v1/sync?since=${since}` });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { deliveries: { updatedAt: string }[] };
      // В дельту попадают только свежие правки (фикстуры, созданные сейчас).
      // Ни одна запись старше окна прийти не должна: именно их повторная
      // выдача в каждой дельте и зациклила бы клиентскую пагинацию.
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const oldOnes = body.deliveries.filter((d) => new Date(d.updatedAt).getTime() < cutoff);
      expect(oldOnes).toHaveLength(0);
      expect(body.deliveries.length).toBeLessThan(500);
    });

    it('reconcile видит все незавершённые независимо от возраста — клиент дотянет хвост', async () => {
      currentUser = asInspector(inspectorA, siteA);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sync/reconcile',
        payload: { deliveries: [], shipments: [], sourceDocuments: [] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { deliveries: { missingOnClient: { id: string }[] } };
      // 501 старая filled + ownDelivery + sameSiteOtherAuthor (тоже filled).
      expect(body.deliveries.missingOnClient.length).toBeGreaterThanOrEqual(503);
    });
  });
});
