/**
 * Признак приёмки на реальном PostgreSQL: кто его ставит, какие значения
 * допустимы и как он следует за получателем.
 *
 * Правило (domain/operations/delivery-purpose.ts): получатель стал МОЛ —
 * «Свои силы»; у подрядчика «Свои силы» не бывает. Держится оно блокировкой
 * строки, поэтому гонки проверяются здесь же, двумя соединениями.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserRole } from '@matcheck/contracts';
import { deliveryRoutes } from '../../src/routes/deliveries.js';
import { syncPairedTransferDelivery } from '../../src/domain/transfers/pair.js';
import {
  counterparties,
  deliveries,
  deliveryItems,
  responsiblePersons,
  shipmentItems,
  shipments,
  sites,
  statuses,
  users,
} from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('признак приёмки', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;
  const siteId = randomUUID();
  const deliveryId = randomUUID();
  const contractorId = randomUUID();
  const molA = randomUUID();
  const molB = randomUUID();
  const destSiteId = randomUUID();
  // Upsert пишет автора и сессию с внешними ключами — нужен настоящий пользователь.
  const managerId = randomUUID();
  const managerSessionId = randomUUID();
  let filledStatusId: string;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql, {
      schema: {
        counterparties,
        deliveries,
        deliveryItems,
        responsiblePersons,
        shipmentItems,
        shipments,
        sites,
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
      (...roles: UserRole[]) =>
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
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`PR-${siteId.slice(0, 6)}`}, 'Тест признака')`;
    const [status] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    filledStatusId = status!.id;
    await sql`INSERT INTO deliveries (id, site_id, status_id)
      VALUES (${deliveryId}, ${siteId}, ${status!.id})`;
    await sql`INSERT INTO counterparties (id, inn, name, is_contractor)
      VALUES (${contractorId}, ${`9${contractorId.replace(/\D/g, '').slice(0, 9).padEnd(9, '0')}`}, 'ООО «Подрядчик признака»', true)`;
    await sql`INSERT INTO responsible_persons (id, full_name) VALUES
      (${molA}, 'МОЛ Первый'), (${molB}, 'МОЛ Второй')`;
    await sql`INSERT INTO sites (id, code, name)
      VALUES (${destSiteId}, ${`PD-${destSiteId.slice(0, 6)}`}, 'Тест признака: куда')`;
    await sql`INSERT INTO users (id, email, password_hash, role)
      VALUES (${managerId}, ${`purpose-${managerId}@test`}, 'x', 'manager')`;
    await sql`INSERT INTO sessions (id, user_id) VALUES (${managerSessionId}, ${managerId})`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM deliveries WHERE site_id IN (${siteId}, ${destSiteId})`;
    await sql`DELETE FROM shipments WHERE site_id = ${siteId}`;
    await sql`DELETE FROM sessions WHERE id = ${managerSessionId}`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM sites WHERE id = ${destSiteId}`;
    await sql`DELETE FROM counterparties WHERE id = ${contractorId}`;
    await sql`DELETE FROM responsible_persons WHERE id IN (${molA}, ${molB})`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  const asRole = (role: UserRole): AuthUser => ({
    id: randomUUID(),
    role,
    siteId: null,
    contractorCustomerId: null,
    sessionId: randomUUID(),
  });
  const asManager = (): AuthUser => ({
    id: managerId,
    role: 'manager',
    siteId: null,
    contractorCustomerId: null,
    sessionId: managerSessionId,
  });
  const patch = (purpose: string) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/deliveries/${deliveryId}/purpose`,
      payload: { purpose },
    });

  it('админ, менеджер и мониторинг могут выбирать; остальные роли не могут', async () => {
    for (const [role, purpose] of [
      ['manager', 'own_forces'],
      ['monitor', 'realization'],
      ['admin', 'tolling_act'],
      ['manager', 'realization_tolling'],
      ['manager', 'contractor_materials'],
    ] as const) {
      currentUser = asRole(role);
      const res = await patch(purpose);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ purpose, status: { code: 'filled' } });
      const [row] = await sql<{ purpose: string }[]>`
        SELECT purpose FROM deliveries WHERE id = ${deliveryId}`;
      expect(row!.purpose).toBe(purpose);
    }

    for (const role of ['inspector_kpp', 'contractor', 'observer'] as const) {
      currentUser = asRole(role);
      expect((await patch('own_forces')).statusCode).toBe(403);
    }
    const [row] = await sql<{ purpose: string }[]>`
      SELECT purpose FROM deliveries WHERE id = ${deliveryId}`;
    expect(row!.purpose).toBe('contractor_materials');
  });

  it('принимает только пять значений', async () => {
    currentUser = asRole('manager');
    expect((await patch('unknown')).statusCode).toBe(400);
  });

  // ─── правило получателя ──────────────────────────────────────────────

  async function seedDelivery(cols: {
    contractorId?: string | null;
    recipientMolId?: string | null;
    purpose?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, status_id, contractor_id, recipient_mol_id, purpose, version)
      VALUES (${id}, ${siteId}, ${filledStatusId}, ${cols.contractorId ?? null},
              ${cols.recipientMolId ?? null}, ${cols.purpose ?? null}, 1)`;
    return id;
  }
  async function purposeOf(id: string): Promise<string | null> {
    const [row] = await sql<{ purpose: string | null }[]>`
      SELECT purpose FROM deliveries WHERE id = ${id}`;
    return row!.purpose;
  }
  // Тело — как у планшета: признака в upsert нет вовсе.
  const upsert = (
    id: string,
    recipient: { contractorId?: string; recipientMolId?: string; purpose?: string },
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/deliveries',
      payload: {
        id,
        statusCode: 'filled',
        siteId,
        items: [],
        sourceDocumentIds: [],
        ...recipient,
      },
    });
  const patchOf = (id: string, purpose: string) =>
    app.inject({ method: 'PATCH', url: `/api/v1/deliveries/${id}/purpose`, payload: { purpose } });

  it('«Свои силы» подрядчику — 422, признак не меняется', async () => {
    currentUser = asManager();
    const id = await seedDelivery({ contractorId, purpose: 'realization' });
    const res = await patchOf(id, 'own_forces');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'purpose_conflicts_recipient' });
    expect(await purposeOf(id)).toBe('realization');
    // Остальные пункты подрядчику доступны.
    expect((await patchOf(id, 'realization_tolling')).statusCode).toBe(200);
    expect(await purposeOf(id)).toBe('realization_tolling');
  });

  it('upsert сохраняет выбранного подрядчика и признак вместе', async () => {
    currentUser = asManager();
    const id = await seedDelivery({ recipientMolId: molA, purpose: 'own_forces' });
    const res = await upsert(id, { contractorId, purpose: 'realization_tolling' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ contractorId, purpose: 'realization_tolling' });
    const [row] = await sql<{ contractor_id: string | null; purpose: string | null }[]>`
      SELECT contractor_id, purpose FROM deliveries WHERE id = ${id}`;
    expect(row).toEqual({ contractor_id: contractorId, purpose: 'realization_tolling' });
  });

  it('upsert отклоняет неподходящий признак без записи получателя', async () => {
    currentUser = asManager();
    const id = await seedDelivery({ recipientMolId: molA, purpose: 'own_forces' });
    const res = await upsert(id, { contractorId, purpose: 'own_forces' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'purpose_conflicts_recipient' });
    const [row] = await sql<{ contractor_id: string | null; purpose: string | null }[]>`
      SELECT contractor_id, purpose FROM deliveries WHERE id = ${id}`;
    expect(row).toEqual({ contractor_id: null, purpose: 'own_forces' });
  });

  it('инспектор не может передать явный признак через upsert', async () => {
    currentUser = asRole('inspector_kpp');
    const id = await seedDelivery({});
    expect((await upsert(id, { purpose: 'realization' })).statusCode).toBe(403);
    expect(await purposeOf(id)).toBeNull();
  });

  it('при МОЛ и без получателя доступны все пункты, включая «Свои силы»', async () => {
    currentUser = asManager();
    for (const recipient of [{ recipientMolId: molA }, {}]) {
      const id = await seedDelivery(recipient);
      expect((await patchOf(id, 'own_forces')).statusCode).toBe(200);
      expect((await patchOf(id, 'contractor_materials')).statusCode).toBe(200);
      expect(await purposeOf(id)).toBe('contractor_materials');
    }
  });

  it('создание с МОЛ — «Свои силы», с подрядчиком и без получателя — пусто', async () => {
    currentUser = asManager();
    const withMol = randomUUID();
    const withContractor = randomUUID();
    const nobody = randomUUID();
    expect((await upsert(withMol, { recipientMolId: molA })).statusCode).toBe(200);
    expect((await upsert(withContractor, { contractorId })).statusCode).toBe(200);
    expect((await upsert(nobody, {})).statusCode).toBe(200);
    expect(await purposeOf(withMol)).toBe('own_forces');
    expect(await purposeOf(withContractor)).toBeNull();
    expect(await purposeOf(nobody)).toBeNull();
  });

  it('стал МОЛ — «Свои силы»; смена одного МОЛ на другого ручной выбор не сбрасывает', async () => {
    currentUser = asManager();
    const id = await seedDelivery({ contractorId, purpose: 'realization' });
    expect((await upsert(id, { recipientMolId: molA })).statusCode).toBe(200);
    expect(await purposeOf(id)).toBe('own_forces');

    expect((await patchOf(id, 'tolling_act')).statusCode).toBe(200);
    expect((await upsert(id, { recipientMolId: molB })).statusCode).toBe(200);
    expect(await purposeOf(id)).toBe('tolling_act');
    // Повтор того же МОЛ (2 этап планшета) — тоже без изменений.
    expect((await upsert(id, { recipientMolId: molB })).statusCode).toBe(200);
    expect(await purposeOf(id)).toBe('tolling_act');
  });

  it('МОЛ → подрядчик: «Свои силы» сбрасываются, другой признак остаётся', async () => {
    currentUser = asManager();
    const own = await seedDelivery({ recipientMolId: molA, purpose: 'own_forces' });
    expect((await upsert(own, { contractorId })).statusCode).toBe(200);
    expect(await purposeOf(own)).toBeNull();

    const other = await seedDelivery({ recipientMolId: molA, purpose: 'realization' });
    expect((await upsert(other, { contractorId })).statusCode).toBe(200);
    expect(await purposeOf(other)).toBe('realization');

    // Снятие получателя признак не трогает.
    expect((await upsert(other, {})).statusCode).toBe(200);
    expect(await purposeOf(other)).toBe('realization');
  });

  it('парная приёмка перемещения следует тому же правилу', async () => {
    const [shipped] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'shipment' AND code = 'shipped' LIMIT 1`;
    const shipmentId = randomUUID();
    await sql`INSERT INTO shipments (id, site_id, dest_site_id, status_id, kind, receiver_mol_id, version)
      VALUES (${shipmentId}, ${siteId}, ${destSiteId}, ${shipped!.id}, 'transfer', ${molA}, 1)`;
    const fakeApp = { db };
    await syncPairedTransferDelivery(fakeApp, shipmentId);
    const [paired] = await sql<{ id: string; purpose: string | null }[]>`
      SELECT id, purpose FROM deliveries WHERE source_shipment_id = ${shipmentId}`;
    expect(paired!.purpose).toBe('own_forces');

    await sql`UPDATE shipments SET receiver_mol_id = NULL, receiver_counterparty_id = ${contractorId}
      WHERE id = ${shipmentId}`;
    await syncPairedTransferDelivery(fakeApp, shipmentId);
    expect(await purposeOf(paired!.id)).toBeNull();
  });

  /**
   * Держит блокировку строки чужой транзакцией, пока идёт запрос. Возвращает
   * функцию, которая фиксирует транзакцию и ждёт её завершения.
   */
  async function holdRowLock(id: string, change: 'contractor' | 'realization') {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const done = sql.begin(async (tx) => {
      if (change === 'contractor') {
        await tx`UPDATE deliveries SET contractor_id = ${contractorId}, recipient_mol_id = NULL
          WHERE id = ${id}`;
      } else {
        await tx`UPDATE deliveries SET purpose = 'realization' WHERE id = ${id}`;
      }
      locked();
      await held;
    });
    await lockedP;
    return async () => {
      release();
      await done;
    };
  }
  const settle = () => new Promise((r) => setTimeout(r, 200));

  it('гонка: «Свои силы» против получателя-подрядчика, что фиксируется раньше', async () => {
    currentUser = asManager();
    const id = await seedDelivery({});
    // Подрядчик ставится конкурентом, пока PATCH ждёт; PATCH обязан увидеть его.
    const commit = await holdRowLock(id, 'contractor');
    const pending = patchOf(id, 'own_forces');
    await settle();
    await commit();
    const res = await pending;
    expect(res.statusCode).toBe(422);
    expect(await purposeOf(id)).toBeNull();
  });

  it('гонка: upsert «→ подрядчик» считает признак по зафиксированной правке, а не по старому чтению', async () => {
    // Было «МОЛ + Свои силы». Пока конкурент меняет признак на «Реализация»,
    // upsert ставит подрядчика. Прочитай он признак до блокировки — увидел бы
    // «Свои силы», сбросил бы их и затёр чужую правку.
    currentUser = asManager();
    const id = await seedDelivery({ recipientMolId: molA, purpose: 'own_forces' });
    const commit = await holdRowLock(id, 'realization');
    const pending = upsert(id, { contractorId });
    await settle();
    await commit();
    expect((await pending).statusCode).toBe(200);
    const [row] = await sql<{ contractor_id: string | null; purpose: string | null }[]>`
      SELECT contractor_id, purpose FROM deliveries WHERE id = ${id}`;
    expect(row).toEqual({ contractor_id: contractorId, purpose: 'realization' });
  });
});
