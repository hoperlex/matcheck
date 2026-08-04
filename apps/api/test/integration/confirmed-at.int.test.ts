/**
 * Время подтверждения приходит с планшета (реальный PostgreSQL).
 *
 * Зачем интеграционные: проверяется поведение INSERT/UPDATE вместе с
 * `COALESCE` — идемпотентность первого подтверждения живёт в самом SQL, на
 * моках её не воспроизвести. Клампы как чистая функция покрыты отдельно в
 * test/confirmed-at.test.ts.
 *
 * Сценарий из жизни (ночь 04.08, ЖК АЛИЯ): инспектор закрыл четыре вторых
 * этапа в течение вечера, очередь мутаций простояла 5 часов и доехала разом —
 * сервер проставил всем одно время. Теперь время фиксирует планшет.
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
import { deliveries, sessions, shipments, sites, statuses, users } from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** Заезд и подтверждение — как в ту ночь: 23:05 и 23:53 МСК. */
const ARRIVED_AT = '2026-08-03T20:05:00.000Z';
const CONFIRMED_AT = '2026-08-03T20:53:00.000Z';

suite('confirmedByMolAt приходит с планшета (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;

  const siteId = randomUUID();
  const inspectorId = randomUUID();
  const sessionId = randomUUID();

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
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'ICA'}, 'Integration ConfirmedAt')
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
      VALUES (${inspectorId}, ${`ica-${inspectorId}@test`}, 'x', 'inspector_kpp', ${siteId})
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO sessions (id, user_id) VALUES (${sessionId}, ${inspectorId})
      ON CONFLICT DO NOTHING`;

    currentUser = {
      id: inspectorId,
      role: 'inspector_kpp',
      siteId,
      contractorCustomerId: null,
      sessionId,
    };
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

  const postDelivery = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/deliveries', payload: body });
  const postShipment = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/shipments', payload: body });

  const deliveryBody = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    statusCode: 'filled',
    siteId,
    arrivedAt: ARRIVED_AT,
    items: [],
    sourceDocumentIds: [],
    ...extra,
  });

  const shipmentBody = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    statusCode: 'shipped',
    kind: 'contractor',
    siteId,
    shippedAt: ARRIVED_AT,
    items: [],
    sourceDocumentIds: [],
    ...extra,
  });

  // postgres.js отдаёт timestamptz строкой — нормализуем в Date, чтобы
  // сравнивать моменты, а не текстовые представления.
  const toDate = (v: unknown): Date | null => (v == null ? null : new Date(v as string));
  const confirmedAtOfDelivery = async (id: string) => {
    const [row] = await sql<{ confirmed_by_mol_at: unknown }[]>`
      SELECT confirmed_by_mol_at FROM deliveries WHERE id = ${id}`;
    return toDate(row!.confirmed_by_mol_at);
  };
  const confirmedAtOfShipment = async (id: string) => {
    const [row] = await sql<{ confirmed_by_mol_at: unknown }[]>`
      SELECT confirmed_by_mol_at FROM shipments WHERE id = ${id}`;
    return toDate(row!.confirmed_by_mol_at);
  };

  // ── 2 Этап: приёмка и отгрузка ───────────────────────────────────────

  it('2 Этап приёмки сохраняет время планшета, а не время доставки мутации', async () => {
    const id = randomUUID();
    expect((await postDelivery(deliveryBody(id))).statusCode).toBe(200);

    const res = await postDelivery(
      deliveryBody(id, {
        statusCode: 'confirmed_mol',
        confirmedByMolAt: CONFIRMED_AT,
        baseVersion: 1,
      }),
    );

    expect(res.statusCode).toBe(200);
    expect((await confirmedAtOfDelivery(id))?.toISOString()).toBe(CONFIRMED_AT);
  });

  it('2 Этап отгрузки — то же самое', async () => {
    const id = randomUUID();
    expect((await postShipment(shipmentBody(id))).statusCode).toBe(200);

    const res = await postShipment(
      shipmentBody(id, {
        statusCode: 'confirmed_mol',
        confirmedByMolAt: CONFIRMED_AT,
        baseVersion: 1,
      }),
    );

    expect(res.statusCode).toBe(200);
    expect((await confirmedAtOfShipment(id))?.toISOString()).toBe(CONFIRMED_AT);
  });

  // ── Ручные внос и вынос: create сразу в confirmed_mol ────────────────

  it('ручной внос (create сразу confirmed_mol) берёт время планшета', async () => {
    const id = randomUUID();

    const res = await postDelivery(
      deliveryBody(id, { statusCode: 'confirmed_mol', confirmedByMolAt: CONFIRMED_AT }),
    );

    expect(res.statusCode).toBe(200);
    expect((await confirmedAtOfDelivery(id))?.toISOString()).toBe(CONFIRMED_AT);
  });

  it('ручной вынос (create сразу confirmed_mol) берёт время планшета', async () => {
    const id = randomUUID();

    const res = await postShipment(
      shipmentBody(id, { statusCode: 'confirmed_mol', confirmedByMolAt: CONFIRMED_AT }),
    );

    expect(res.statusCode).toBe(200);
    expect((await confirmedAtOfShipment(id))?.toISOString()).toBe(CONFIRMED_AT);
  });

  // ── Совместимость: сборки до 1.0.33 поля не шлют ─────────────────────

  it('старый клиент без поля получает серверное время — все четыре пути', async () => {
    const before = Date.now() - 1000;

    const updDelivery = randomUUID();
    expect((await postDelivery(deliveryBody(updDelivery))).statusCode).toBe(200);
    expect(
      (await postDelivery(deliveryBody(updDelivery, { statusCode: 'confirmed_mol', baseVersion: 1 })))
        .statusCode,
    ).toBe(200);

    const updShipment = randomUUID();
    expect((await postShipment(shipmentBody(updShipment))).statusCode).toBe(200);
    expect(
      (await postShipment(shipmentBody(updShipment, { statusCode: 'confirmed_mol', baseVersion: 1 })))
        .statusCode,
    ).toBe(200);

    const manualIn = randomUUID();
    expect((await postDelivery(deliveryBody(manualIn, { statusCode: 'confirmed_mol' }))).statusCode).toBe(200);

    const manualOut = randomUUID();
    expect((await postShipment(shipmentBody(manualOut, { statusCode: 'confirmed_mol' }))).statusCode).toBe(200);

    const after = Date.now() + 1000;
    for (const at of [
      await confirmedAtOfDelivery(updDelivery),
      await confirmedAtOfShipment(updShipment),
      await confirmedAtOfDelivery(manualIn),
      await confirmedAtOfShipment(manualOut),
    ]) {
      expect(at).not.toBeNull();
      expect(at!.getTime()).toBeGreaterThanOrEqual(before);
      expect(at!.getTime()).toBeLessThanOrEqual(after);
    }
  });

  // ── Первое значение побеждает ────────────────────────────────────────

  it('повторное подтверждение не перезаписывает первое время', async () => {
    const id = randomUUID();
    expect((await postDelivery(deliveryBody(id))).statusCode).toBe(200);
    expect(
      (
        await postDelivery(
          deliveryBody(id, {
            statusCode: 'confirmed_mol',
            confirmedByMolAt: CONFIRMED_AT,
            baseVersion: 1,
          }),
        )
      ).statusCode,
    ).toBe(200);

    // Повтор с другим временем — например, планшет переотправил мутацию.
    const res = await postDelivery(
      deliveryBody(id, {
        statusCode: 'confirmed_mol',
        confirmedByMolAt: '2026-08-04T02:23:39.000Z',
        baseVersion: 2,
      }),
    );

    expect(res.statusCode).toBe(200);
    expect((await confirmedAtOfDelivery(id))?.toISOString()).toBe(CONFIRMED_AT);
  });

  it('параллельные подтверждения не размазывают время — побеждает одно', async () => {
    const id = randomUUID();
    expect((await postDelivery(deliveryBody(id))).statusCode).toBe(200);

    const second = '2026-08-03T21:30:00.000Z';
    await Promise.all([
      postDelivery(deliveryBody(id, { statusCode: 'confirmed_mol', confirmedByMolAt: CONFIRMED_AT })),
      postDelivery(deliveryBody(id, { statusCode: 'confirmed_mol', confirmedByMolAt: second })),
    ]);

    const settled = (await confirmedAtOfDelivery(id))?.toISOString();
    expect([CONFIRMED_AT, second]).toContain(settled);

    // Третий запрос уже ничего не меняет — значение зафиксировано.
    expect(
      (
        await postDelivery(
          deliveryBody(id, {
            statusCode: 'confirmed_mol',
            confirmedByMolAt: '2026-08-04T02:23:39.000Z',
          }),
        )
      ).statusCode,
    ).toBe(200);
    expect((await confirmedAtOfDelivery(id))?.toISOString()).toBe(settled);
  });

  // ── Клампы через маршрут ─────────────────────────────────────────────

  it('время раньше заезда поднимается до заезда', async () => {
    const id = randomUUID();

    const res = await postDelivery(
      deliveryBody(id, {
        statusCode: 'confirmed_mol',
        confirmedByMolAt: '2026-08-03T10:00:00.000Z', // задолго до заезда
      }),
    );

    expect(res.statusCode).toBe(200);
    expect((await confirmedAtOfDelivery(id))?.toISOString()).toBe(ARRIVED_AT);
  });

  it('время из далёкого будущего срезается до серверного', async () => {
    const id = randomUUID();
    const before = Date.now() - 1000;

    const res = await postDelivery(
      deliveryBody(id, {
        statusCode: 'confirmed_mol',
        confirmedByMolAt: '2030-01-01T00:00:00.000Z',
      }),
    );

    expect(res.statusCode).toBe(200);
    const at = await confirmedAtOfDelivery(id);
    expect(at!.getTime()).toBeGreaterThanOrEqual(before);
    expect(at!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('строка не длиннее 64 символов — мусорная длина отбивается контрактом', async () => {
    const id = randomUUID();

    const res = await postDelivery(
      deliveryBody(id, { statusCode: 'confirmed_mol', confirmedByMolAt: 'x'.repeat(200) }),
    );

    expect(res.statusCode).toBe(400);
  });
});
