/**
 * Время съёмки фото приходит с планшета (реальный PostgreSQL).
 *
 * Ради чего: заголовок этапа на портале (`formatStageTime`) считается по
 * `photos.taken_at`, а его до сих пор ставил сервер в момент presign. При
 * офлайне это давало время синхронизации — 04.08 на ЖК ВАРШАВСКАЯ LIFE кадры
 * сняты в 12:24–12:30, а в карточке у обоих этапов стояло 12:31.
 *
 * Здесь же проверяется, что переход orphan-очистки на `created_at` не даёт
 * снести только что запрезайненное старое офлайн-фото.
 *
 * Запуск: см. шапку foreign-site.int.test.ts (тот же TEST_DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { photoRoutes } from '../../src/routes/photos.js';
import { deliveryPhotos, shipmentPhotos } from '../../src/db/schema.js';
import {
  deliveryOrphanCondition,
  shipmentOrphanCondition,
} from '../../src/domain/jobs/photo-orphan-cleanup.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** Кадр снят в 12:27 МСК, а доехал до сервера только в 12:31. */
const SHOT_AT = '2026-08-04T09:27:00.000Z';

suite('taken_at фото приходит с планшета (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let currentUser: AuthUser;

  const siteId = randomUUID();
  const inspectorId = randomUUID();
  let deliveryId: string;
  let shipmentId: string;

  const hash = () => randomUUID().replace(/-/g, '').repeat(2);

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql, { schema: { deliveryPhotos, shipmentPhotos } });

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
    await app.register(photoRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'IPT'}, 'Integration PhotoTakenAt')
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
      VALUES (${inspectorId}, ${`ita-${inspectorId}@test`}, 'x', 'inspector_kpp', ${siteId})
      ON CONFLICT DO NOTHING`;

    const [ds] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    const [ss] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'shipment' AND code = 'shipped' LIMIT 1`;

    deliveryId = randomUUID();
    shipmentId = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, version)
      VALUES (${deliveryId}, ${siteId}, ${inspectorId}, ${ds!.id}, 1)`;
    await sql`INSERT INTO shipments (id, site_id, inspector_id, status_id, kind, version)
      VALUES (${shipmentId}, ${siteId}, ${inspectorId}, ${ss!.id}, 'contractor', 1)`;

    currentUser = {
      id: inspectorId,
      role: 'inspector_kpp',
      siteId,
      contractorCustomerId: null,
      sessionId: randomUUID(),
    };
  });

  afterAll(async () => {
    if (!sql) return;
    await app?.close();
    await sql`DELETE FROM delivery_photos WHERE delivery_id = ${deliveryId}`;
    await sql`DELETE FROM shipment_photos WHERE shipment_id = ${shipmentId}`;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM shipments WHERE site_id = ${siteId}`;
    await sql`DELETE FROM users WHERE id = ${inspectorId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  const presignDelivery = (extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/photos/presign',
      payload: {
        operationKind: 'delivery',
        operationId: deliveryId,
        kind: 'cargo',
        contentType: 'image/jpeg',
        contentHash: hash(),
        idempotencyKey: randomUUID(),
        ...extra,
      },
    });

  const presignShipment = (extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/photos/presign',
      payload: {
        operationKind: 'shipment',
        operationId: shipmentId,
        kind: 'cargo',
        contentType: 'image/jpeg',
        contentHash: hash(),
        idempotencyKey: randomUUID(),
        ...extra,
      },
    });

  const takenAtOf = async (photoId: string, table: 'delivery_photos' | 'shipment_photos') => {
    const rows =
      table === 'delivery_photos'
        ? await sql<{ taken_at: unknown; created_at: unknown }[]>`
            SELECT taken_at, created_at FROM delivery_photos WHERE id = ${photoId}`
        : await sql<{ taken_at: unknown; created_at: unknown }[]>`
            SELECT taken_at, created_at FROM shipment_photos WHERE id = ${photoId}`;
    const row = rows[0]!;
    return {
      takenAt: new Date(row.taken_at as string),
      createdAt: new Date(row.created_at as string),
    };
  };

  // ── время съёмки с планшета ──────────────────────────────────────────

  it('фото приёмки сохраняет время съёмки, а не время presign', async () => {
    const res = await presignDelivery({ takenAt: SHOT_AT });

    expect(res.statusCode).toBe(200);
    const { photoId } = res.json() as { photoId: string };
    const { takenAt, createdAt } = await takenAtOf(photoId, 'delivery_photos');
    expect(takenAt.toISOString()).toBe(SHOT_AT);
    // Именно расхождение с created_at и было симптомом на портале.
    expect(createdAt.getTime()).toBeGreaterThan(takenAt.getTime());
  });

  it('фото отгрузки — то же самое', async () => {
    const res = await presignShipment({ takenAt: SHOT_AT });

    expect(res.statusCode).toBe(200);
    const { photoId } = res.json() as { photoId: string };
    const { takenAt } = await takenAtOf(photoId, 'shipment_photos');
    expect(takenAt.toISOString()).toBe(SHOT_AT);
  });

  // ── совместимость: старые сборки и веб-фронт поля не шлют ────────────

  it('без поля остаётся серверное время — обе сущности', async () => {
    const before = Date.now() - 1000;

    const d = await presignDelivery();
    const s = await presignShipment();

    expect(d.statusCode).toBe(200);
    expect(s.statusCode).toBe(200);
    for (const [res, table] of [
      [d, 'delivery_photos'],
      [s, 'shipment_photos'],
    ] as const) {
      const { photoId } = res.json() as { photoId: string };
      const { takenAt } = await takenAtOf(photoId, table);
      expect(takenAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(takenAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    }
  });

  // ── клампы: ровно контракт resolveConfirmedAt ────────────────────────

  it('мусорная строка заменяется серверным временем', async () => {
    const before = Date.now() - 1000;

    const res = await presignDelivery({ takenAt: 'не дата' });

    expect(res.statusCode).toBe(200);
    const { photoId } = res.json() as { photoId: string };
    const { takenAt } = await takenAtOf(photoId, 'delivery_photos');
    expect(takenAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('будущее дальше пяти минут срезается до серверного', async () => {
    const before = Date.now() - 1000;

    const res = await presignDelivery({ takenAt: '2030-01-01T00:00:00.000Z' });

    expect(res.statusCode).toBe(200);
    const { photoId } = res.json() as { photoId: string };
    const { takenAt } = await takenAtOf(photoId, 'delivery_photos');
    expect(takenAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(takenAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('будущее в пределах пяти минут сохраняется как есть', async () => {
    // Обычное расхождение часов планшета — не аномалия, срезать его нельзя.
    const slightlyAhead = new Date(Date.now() + 3 * 60 * 1000).toISOString();

    const res = await presignDelivery({ takenAt: slightlyAhead });

    expect(res.statusCode).toBe(200);
    const { photoId } = res.json() as { photoId: string };
    const { takenAt } = await takenAtOf(photoId, 'delivery_photos');
    expect(takenAt.toISOString()).toBe(slightlyAhead);
  });

  it('строка длиннее 64 символов отбивается контрактом', async () => {
    const res = await presignDelivery({ takenAt: 'x'.repeat(200) });

    expect(res.statusCode).toBe(400);
  });

  // ── идемпотентность presign ──────────────────────────────────────────

  it('повторный presign по тому же contentHash не переписывает время', async () => {
    const contentHash = hash();
    const first = await presignDelivery({ takenAt: SHOT_AT, contentHash });
    expect(first.statusCode).toBe(200);
    const { photoId } = first.json() as { photoId: string };

    const second = await presignDelivery({
      takenAt: '2026-08-04T09:31:14.000Z',
      contentHash,
    });

    expect(second.statusCode).toBe(200);
    expect((second.json() as { photoId: string }).photoId).toBe(photoId);
    const { takenAt } = await takenAtOf(photoId, 'delivery_photos');
    expect(takenAt.toISOString()).toBe(SHOT_AT);
  });

  // ── orphan-очистка: по created_at, а не taken_at ─────────────────────

  it('старое офлайн-фото не считается сиротой сразу после presign', async () => {
    // Снято сутки назад, запись создана только что — ровно случай, ради
    // которого выборка переведена на created_at.
    const fresh = randomUUID();
    await sql`INSERT INTO delivery_photos
      (id, delivery_id, kind, s3_key, content_hash, idempotency_key, taken_at, created_at)
      VALUES (${fresh}, ${deliveryId}, 'cargo', ${`k/${fresh}.jpg`}, ${hash()}, ${randomUUID()},
              now() - interval '1 day', now())`;
    // Контроль: настоящая сирота — старая по created_at.
    const stale = randomUUID();
    await sql`INSERT INTO delivery_photos
      (id, delivery_id, kind, s3_key, content_hash, idempotency_key, taken_at, created_at)
      VALUES (${stale}, ${deliveryId}, 'cargo', ${`k/${stale}.jpg`}, ${hash()}, ${randomUUID()},
              now() - interval '1 day', now() - interval '2 hours')`;

    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const orphans = await db
      .select({ id: deliveryPhotos.id })
      .from(deliveryPhotos)
      .where(deliveryOrphanCondition(cutoff));
    const ids = orphans.map((o) => o.id);

    expect(ids).not.toContain(fresh);
    expect(ids).toContain(stale);
  });

  it('то же условие у отгрузок', async () => {
    const fresh = randomUUID();
    await sql`INSERT INTO shipment_photos
      (id, shipment_id, kind, s3_key, content_hash, idempotency_key, taken_at, created_at)
      VALUES (${fresh}, ${shipmentId}, 'cargo', ${`k/${fresh}.jpg`}, ${hash()}, ${randomUUID()},
              now() - interval '1 day', now())`;

    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const orphans = await db
      .select({ id: shipmentPhotos.id })
      .from(shipmentPhotos)
      .where(shipmentOrphanCondition(cutoff));

    expect(orphans.map((o) => o.id)).not.toContain(fresh);
  });
});
