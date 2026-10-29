/**
 * Привязка заказов EstiMat к приёмке на настоящем PostgreSQL: идемпотентность,
 * несколько заказов к приёмке и один заказ к нескольким приёмкам, отказы
 * (удаление, перемещение, удалённый заказ, чужой объект), видимость по ролям,
 * подбор по ИНН из документов, гонка с пометкой «удалён в EstiMat».
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserRole } from '@matcheck/contracts';
import * as schema from '../../src/db/schema.js';
import { deliveryRoutes } from '../../src/routes/deliveries.js';
import { estimatRoutes } from '../../src/routes/estimat.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const SUPPLIER_INN = '7800000000';
const CONTRACTOR_INN = '5000000000';

suite('заказы EstiMat в приёмке', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;
  let filledStatusId: string;

  const siteS = randomUUID();
  const siteT = randomUUID();
  const codeS = `DS${siteS.slice(0, 6)}`;
  const codeT = `DT${siteT.slice(0, 6)}`;
  const managerId = randomUUID();
  const inspectorS = randomUUID();
  const inspectorT = randomUUID();
  const createdDeliveries: string[] = [];
  const createdDocs: string[] = [];
  const createdShipments: string[] = [];

  const as = (role: UserRole, id = managerId, siteId: string | null = null): AuthUser => ({
    id,
    role,
    siteId,
    contractorCustomerId: null,
    sessionId: randomUUID(),
  });

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 6 });
    const db = drizzle(sql, { schema });
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
        async (req: { user?: AuthUser }, reply: { code: (c: number) => { send: (b: unknown) => void } }) => {
          if (!req.user || !roles.includes(req.user.role)) reply.code(403).send({ error: 'forbidden' });
        },
    );
    await app.register(deliveryRoutes);
    await app.register(estimatRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteS}, ${codeS}, 'Объект S'), (${siteT}, ${codeT}, 'Объект T')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id) VALUES
      (${managerId}, ${`m-${managerId}@t.local`}, 'x', 'manager', NULL),
      (${inspectorS}, ${`s-${inspectorS}@t.local`}, 'x', 'inspector_kpp', ${siteS}),
      (${inspectorT}, ${`t-${inspectorT}@t.local`}, 'x', 'inspector_kpp', ${siteT})`;
    const [status] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    filledStatusId = status!.id;
  });

  beforeEach(async () => {
    await sql`DELETE FROM delivery_supplier_orders`;
    await sql`DELETE FROM estimat_supplier_orders`;
    await sql`DELETE FROM estimat_sync_runs`;
    currentUser = as('manager');
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM delivery_supplier_orders`;
    await sql`DELETE FROM estimat_supplier_orders`;
    const list = (ids: string[]) => ids.join(',');
    await sql`DELETE FROM delivery_sources WHERE delivery_id::text = ANY(string_to_array(${list(createdDeliveries)}, ','))`;
    await sql`DELETE FROM deliveries WHERE id::text = ANY(string_to_array(${list(createdDeliveries)}, ','))`;
    await sql`DELETE FROM shipments WHERE id::text = ANY(string_to_array(${list(createdShipments)}, ','))`;
    await sql`DELETE FROM source_documents WHERE id::text = ANY(string_to_array(${list(createdDocs)}, ','))`;
    await sql`DELETE FROM users WHERE id IN (${managerId}, ${inspectorS}, ${inspectorT})`;
    await sql`DELETE FROM sites WHERE id IN (${siteS}, ${siteT})`;
    await sql.end({ timeout: 5 });
  });

  async function delivery(siteId = siteS, extra: { pending?: boolean; shipmentId?: string } = {}): Promise<string> {
    const id = randomUUID();
    createdDeliveries.push(id);
    await sql`INSERT INTO deliveries (id, site_id, status_id, pending_deletion_at, pending_deletion_by_user_id, source_shipment_id)
      VALUES (${id}, ${siteId}, ${filledStatusId}, ${extra.pending ? new Date().toISOString() : null}::timestamptz,
              ${extra.pending ? managerId : null}, ${extra.shipmentId ?? null})`;
    return id;
  }

  // postgres.js на свежем соединении сериализует массивы и Date неверно —
  // передаём строками с явным приведением типа.
  const iso = (d: Date | null) => (d ? d.toISOString() : null);

  async function order(patch: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    const row = {
      id,
      order_no: Math.floor(Math.random() * 900) + 1,
      sub_no: 0,
      site_id: siteS,
      project_code: codeS,
      sourcing_status: 'awarded',
      supplier_name: 'Поставщик',
      supplier_inn: null as string | null,
      contractors: [] as unknown[],
      supply_approved_at: null as Date | null,
      deleted_at: null as Date | null,
      estimat_created_at: new Date('2026-10-15T07:00:00Z'),
      ...patch,
    };
    await sql`INSERT INTO estimat_supplier_orders
      (id, order_no, sub_no, site_id, project_code, sourcing_status, supplier_name, supplier_inn, contractors,
       supply_approved_at, deleted_at, estimat_created_at, raw, last_seen_pass_id)
      VALUES (${row.id}, ${row.order_no}, ${row.sub_no}, ${row.site_id}, ${row.project_code}, ${row.sourcing_status},
              ${row.supplier_name}, ${row.supplier_inn}, ${JSON.stringify(row.contractors)}::jsonb,
              ${iso(row.supply_approved_at)}::timestamptz, ${iso(row.deleted_at)}::timestamptz,
              ${iso(row.estimat_created_at)}::timestamptz, ${JSON.stringify({ id })}::jsonb, ${randomUUID()})`;
    return id;
  }

  const link = (deliveryId: string, orderId: string, confirmSiteMismatch?: boolean) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/deliveries/${deliveryId}/supplier-orders`,
      payload: { orderId, ...(confirmSiteMismatch !== undefined ? { confirmSiteMismatch } : {}) },
    });
  const unlink = (deliveryId: string, orderId: string) =>
    app.inject({ method: 'DELETE', url: `/api/v1/deliveries/${deliveryId}/supplier-orders/${orderId}` });
  const linked = (deliveryId: string) =>
    app.inject({ method: 'GET', url: `/api/v1/deliveries/${deliveryId}/supplier-orders` });
  const eventKinds = async (orderId: string) =>
    (await sql<{ kind: string }[]>`SELECT kind FROM estimat_supplier_order_events WHERE order_id = ${orderId} ORDER BY id`).map(
      (r) => r.kind,
    );

  it('привязка, повтор, отвязка, повтор — идемпотентно и с журналом', async () => {
    const d = await delivery();
    const o = await order({ supply_approved_at: new Date('2026-10-22T12:40:11Z') });
    const [before] = await sql<{ version: number; updated_at: string }[]>`
      SELECT version, updated_at::text FROM deliveries WHERE id = ${d}`;

    const first = await link(d, o);
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(1);
    expect(first.json().items[0]).toMatchObject({ id: o, approvalState: 'approved', siteMismatch: false });
    expect((await link(d, o)).statusCode).toBe(200);
    expect(await eventKinds(o)).toEqual(['delivery_linked']);

    const [after] = await sql<{ version: number; updated_at: string }[]>`
      SELECT version, updated_at::text FROM deliveries WHERE id = ${d}`;
    expect(after).toEqual(before);

    expect((await unlink(d, o)).json().items).toEqual([]);
    expect((await unlink(d, o)).statusCode).toBe(200);
    expect(await eventKinds(o)).toEqual(['delivery_linked', 'delivery_unlinked']);
  });

  it('несколько заказов к приёмке и один заказ к двум приёмкам', async () => {
    const d1 = await delivery();
    const d2 = await delivery();
    const a = await order();
    const b = await order({ sub_no: 1 });
    await link(d1, a);
    await link(d1, b);
    await link(d2, a);
    const res = await linked(d1);
    expect(res.json().items.map((x: { id: string }) => x.id).sort()).toEqual([a, b].sort());
    expect((await linked(d2)).json().items.map((x: { id: string }) => x.id)).toEqual([a]);
  });

  it('отказы: помечена на удаление, перемещение, удалённый заказ, нет заказа', async () => {
    const pending = await delivery(siteS, { pending: true });
    const o = await order();
    const res = await link(pending, o);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('pending_deletion');
    expect((await unlink(pending, o)).statusCode).toBe(409);

    const shipmentId = randomUUID();
    createdShipments.push(shipmentId);
    const [shipStatus] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'shipment' LIMIT 1`;
    await sql`INSERT INTO shipments (id, kind, site_id, status_id) VALUES (${shipmentId}, 'contractor', ${siteT}, ${shipStatus!.id})`;
    const pair = await delivery(siteS, { shipmentId });
    expect((await link(pair, o)).json().error).toBe('transfer_pair');

    const d = await delivery();
    const gone = await order({ deleted_at: new Date() });
    expect((await link(d, gone)).json().error).toBe('order_deleted');
    expect((await link(d, randomUUID())).statusCode).toBe(404);
    expect((await link(randomUUID(), o)).statusCode).toBe(404);
  });

  it('заказ другого или неопределённого объекта — только с подтверждением', async () => {
    const d = await delivery();
    const foreign = await order({ site_id: siteT, project_code: codeT });
    const unknown = await order({ site_id: null, project_code: 'НЕТ-ТАКОГО' });

    const res = await link(d, foreign);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'site_mismatch', orderSiteCode: codeT, deliverySiteCode: codeS });
    expect((await link(d, unknown)).json()).toMatchObject({ error: 'site_mismatch', projectCode: 'НЕТ-ТАКОГО' });

    const ok = await link(d, foreign, true);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().items[0]).toMatchObject({ id: foreign, siteMismatch: true });
    const [ev] = await sql<{ details: { siteMismatch?: boolean } }[]>`
      SELECT details FROM estimat_supplier_order_events WHERE order_id = ${foreign} AND kind = 'delivery_linked'`;
    expect(ev!.details.siteMismatch).toBe(true);
  });

  it('видимость: инспектор — только своего объекта, подрядчик — нет', async () => {
    const d = await delivery(siteS);
    const o = await order();
    await link(d, o);

    currentUser = as('inspector_kpp', inspectorS, siteS);
    expect((await linked(d)).statusCode).toBe(200);
    currentUser = as('inspector_kpp', inspectorT, siteT);
    expect((await linked(d)).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/deliveries/${d}/supplier-orders/${o}/items` })).statusCode,
    ).toBe(404);
    currentUser = as('contractor');
    expect((await linked(d)).statusCode).toBe(403);
    // Инспектор не привязывает.
    currentUser = as('inspector_kpp', inspectorS, siteS);
    expect((await link(d, o)).statusCode).toBe(403);
    currentUser = as('monitor');
    expect((await linked(d)).statusCode).toBe(200);
  });

  it('подробности строки подбора: поля и приёмки без журнала, удалённый заказ — 404', async () => {
    const d = await delivery();
    const other = await delivery();
    const o = await order({ supply_approved_at: new Date('2026-10-22T12:40:11Z') });
    await link(other, o);
    const detail = (orderId: string, deliveryId = d) =>
      app.inject({ method: 'GET', url: `/api/v1/deliveries/${deliveryId}/supplier-order-candidates/${orderId}` });
    const items = (orderId: string, deliveryId = d) =>
      app.inject({ method: 'GET', url: `/api/v1/deliveries/${deliveryId}/supplier-order-candidates/${orderId}/items` });

    const res = await detail(o);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ id: o, approvalState: 'approved', siteCode: codeS });
    expect(body.deliveries.map((x: { deliveryId: string }) => x.deliveryId)).toEqual([other]);
    // Журнал с email сотрудников — только во вкладке «Заказы».
    expect(body).not.toHaveProperty('events');
    expect(JSON.stringify(body)).not.toContain('@t.local');
    // Интеграция в тестах не настроена: состав честно «недоступен», в EstiMat не ходим.
    expect((await items(o)).json()).toMatchObject({ state: 'disabled', items: [] });

    const gone = await order({ deleted_at: new Date('2026-10-28T10:00:00Z') });
    expect((await detail(gone)).statusCode).toBe(404);
    // 404, а не disabled: удалённый заказ отсекается до похода за составом.
    expect((await items(gone)).statusCode).toBe(404);
    expect((await detail(randomUUID())).statusCode).toBe(404);
    expect((await detail(o, randomUUID())).statusCode).toBe(404);
    expect((await items(o, randomUUID())).statusCode).toBe(404);

    currentUser = as('inspector_kpp', inspectorS, siteS);
    expect((await detail(o)).statusCode).toBe(403);
    expect((await items(o)).statusCode).toBe(403);
  });

  it('удаление приёмки каскадом убирает связь, журнал заказа остаётся', async () => {
    const d = await delivery();
    const o = await order();
    await link(d, o);
    await sql`DELETE FROM deliveries WHERE id = ${d}`;
    const rows = await sql`SELECT 1 FROM delivery_supplier_orders WHERE delivery_id = ${d}`;
    expect(rows).toHaveLength(0);
    expect(await eventKinds(o)).toEqual(['delivery_linked']);
  });

  it('полный upsert приёмки (как с планшета) связь не трогает', async () => {
    const d = await delivery();
    const o = await order();
    await link(d, o);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/deliveries',
      payload: { id: d, statusCode: 'filled', siteId: siteS, comment: 'с планшета', items: [], sourceDocumentIds: [] },
    });
    expect(res.statusCode).toBe(200);
    expect((await linked(d)).json().items.map((x: { id: string }) => x.id)).toEqual([o]);
  });

  describe('подбор', () => {
    async function linkDocument(deliveryId: string, patch: { supplier: string | null; buyer: string | null }) {
      const id = randomUUID();
      createdDocs.push(id);
      await sql`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, doc_number, supplier_inn_raw, buyer_inn_raw)
        VALUES (${id}, 'upd', 'inbound', 'parsed', 'edo_diadoc', ${siteS}, ${`N-${id.slice(0, 6)}`}, ${patch.supplier}, ${patch.buyer})`;
      await sql`INSERT INTO delivery_sources (delivery_id, source_document_id) VALUES (${deliveryId}, ${id})`;
    }
    const candidates = (deliveryId: string, query = '') =>
      app.inject({ method: 'GET', url: `/api/v1/deliveries/${deliveryId}/supplier-order-candidates${query}` });

    it('поставщик только в УПД (supplier_id пуст) — первое место и метка', async () => {
      const d = await delivery();
      await linkDocument(d, { supplier: SUPPLIER_INN, buyer: null });
      const other = await order({ supplier_inn: '7700000001', estimat_created_at: new Date('2026-10-20T00:00:00Z') });
      const match = await order({ supplier_inn: SUPPLIER_INN, estimat_created_at: new Date('2026-10-01T00:00:00Z') });
      const res = await candidates(d);
      expect(res.statusCode).toBe(200);
      const items = res.json().items as { id: string; supplierMatch: boolean | null }[];
      expect(items.map((x) => x.id)).toEqual([match, other]);
      expect(items[0]!.supplierMatch).toBe(true);
      expect(items[1]!.supplierMatch).toBe(false);
      expect(res.json().syncInfo).toMatchObject({ enabled: false });
    });

    it('покупатель документа — подрядчик заказа; свой ИНН совпадением не считается', async () => {
      const d = await delivery();
      await linkDocument(d, { supplier: null, buyer: CONTRACTOR_INN });
      const own = await order({ contractors: [{ id: 'x', name: 'Чужой', inn: '7700000002', type: 'subcontractor' }] });
      const match = await order({ contractors: [{ id: 'y', name: 'Подрядчик', inn: CONTRACTOR_INN, type: 'subcontractor' }] });
      const items = (await candidates(d)).json().items as { id: string; contractorMatch: boolean | null }[];
      expect(items[0]).toMatchObject({ id: match, contractorMatch: true });
      expect(items.find((x) => x.id === own)!.contractorMatch).toBe(false);
    });

    it('без ИНН у приёмки — метки null, а не «не совпал»', async () => {
      const d = await delivery();
      await order({ supplier_inn: SUPPLIER_INN });
      const items = (await candidates(d)).json().items as { supplierMatch: boolean | null; contractorMatch: boolean | null }[];
      expect(items[0]).toMatchObject({ supplierMatch: null, contractorMatch: null });
    });

    it('отбор по объекту и стадиям, поиск по номеру, offset, удалённые не видны никогда', async () => {
      const d = await delivery();
      const here = await order({ order_no: 501, sub_no: 2 });
      const there = await order({ site_id: siteT, project_code: codeT });
      const cancelled = await order({ sourcing_status: 'cancelled' });
      await order({ deleted_at: new Date() });

      const ids = async (q: string) =>
        ((await candidates(d, q)).json().items as { id: string }[]).map((x) => x.id).sort();
      expect(await ids('')).toEqual([here]);
      expect(await ids('?allSites=true')).toEqual([here, there].sort());
      expect(await ids('?allStages=true')).toEqual([here, cancelled].sort());
      expect(await ids('?q=З-501/2')).toEqual([here]);
      expect(await ids('?q=501')).toEqual([here]);
      expect(await ids('?q=999')).toEqual([]);
      const page = (await candidates(d, '?allSites=true&allStages=true&limit=1&offset=1')).json();
      expect(page.total).toBe(3);
      expect(page.items).toHaveLength(1);
    });
  });

  it('гонка: привязка ждёт пометку «удалён в EstiMat» и получает 409', async () => {
    const d = await delivery();
    const o = await order();
    let settled = false;
    let pending!: Promise<{ statusCode: number; json: () => { error?: string } }>;
    await sql.begin(async (tx) => {
      await tx`UPDATE estimat_supplier_orders SET deleted_at = now() WHERE id = ${o}`;
      pending = link(d, o).then((r) => {
        settled = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 400));
      // Пока пометка не закоммичена, привязка обязана ждать блокировку заказа.
      expect(settled).toBe(false);
    });
    const res = await pending;
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('order_deleted');
    expect(await sql`SELECT 1 FROM delivery_supplier_orders WHERE order_id = ${o}`).toHaveLength(0);
  });
});
