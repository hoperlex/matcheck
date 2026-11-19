import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserRole } from '@matcheck/contracts';
import * as schema from '../../src/db/schema.js';
import { shipmentRoutes } from '../../src/routes/shipments.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

// Зеркало delivery-recipient-patch: получатель отгрузки сразу
// (PATCH /shipments/:id/recipient, только вид «подрядчику»), а «Сохранить»
// портала идёт с keepReceiver — получатель не пишется, сочетание вида с ним
// проверяется под блокировкой строки.
suite('получатель отгрузки сразу и keepReceiver у upsert (PostgreSQL)', { timeout: 60_000 }, () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;
  let monitorEditGranted = false;
  const siteId = randomUUID();
  const managerId = randomUUID();
  const sessionId = randomUUID();
  const contractorId = randomUUID();
  const molId = randomUUID();
  const docId = randomUUID();
  let shippedStatusId: string;
  const shipmentIds: string[] = [];

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 5 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql, { schema, casing: 'snake_case' }) as never);
    currentUser = {
      id: managerId,
      role: 'manager',
      siteId: null,
      contractorCustomerId: null,
      sessionId,
    };
    app.decorate('authenticate', async (req: { user?: AuthUser; permissionExpanded?: boolean }) => {
      req.user = currentUser;
      if (currentUser.role === 'monitor' && monitorEditGranted) req.permissionExpanded = true;
    });
    app.decorate(
      'authorize',
      (...roles: UserRole[]) =>
        async (
          req: { user?: AuthUser; permissionExpanded?: boolean },
          reply: { code: (n: number) => { send: (v: unknown) => void } },
        ) => {
          if (req.permissionExpanded) return;
          if (!req.user || !roles.includes(req.user.role))
            reply.code(403).send({ error: 'forbidden' });
        },
    );
    app.decorate('permissions', {
      enforced: true,
      get: async () =>
        new Map(
          monitorEditGranted
            ? [['monitor:operations.shipments', { view: true, review: true, edit: true }] as const]
            : [],
        ),
    } as never);
    app.decorate('logUnauthorized', async () => {});
    await app.register(shipmentRoutes);
    await app.ready();
    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`SR${siteId.slice(0, 6)}`}, 'Получатель отгрузки сразу')`;
    await sql`INSERT INTO users (id, email, password_hash, role) VALUES (${managerId}, ${`sr-${managerId}@test`}, 'x', 'manager')`;
    await sql`INSERT INTO sessions (id, user_id) VALUES (${sessionId}, ${managerId})`;
    await sql`INSERT INTO counterparties (id, inn, name, is_contractor, is_supplier)
      VALUES (${contractorId}, ${`6${contractorId.replace(/\D/g, '').slice(0, 9).padEnd(9, '0')}`}, 'Подрядчик отгрузки', true, true)`;
    await sql`INSERT INTO responsible_persons (id, full_name) VALUES (${molId}, 'МОЛ отгрузки')`;
    await sql`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum, parsed_at)
      VALUES (${docId}, 'upd', 'outbound', 'parsed', 'manual_pdf', ${siteId}, 'SR-1', now(), '100.00', now())`;
    const [status] = await sql<
      { id: string }[]
    >`SELECT id FROM statuses WHERE entity_type='shipment' AND code='shipped' LIMIT 1`;
    shippedStatusId = status!.id;
  });

  beforeEach(() => {
    monitorEditGranted = false;
    currentUser = { ...currentUser, role: 'manager' };
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    if (shipmentIds.length) await sql`DELETE FROM shipments WHERE id IN ${sql(shipmentIds)}`;
    await sql`DELETE FROM source_documents WHERE id = ${docId}`;
    await sql`DELETE FROM sessions WHERE id = ${sessionId}`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM responsible_persons WHERE id = ${molId}`;
    await sql`DELETE FROM counterparties WHERE id = ${contractorId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  async function makeShipment(
    receiver: 'contractor' | 'mol' | 'none' = 'none',
    opts: { kind?: 'contractor' | 'writeoff' | 'return'; withDocument?: boolean } = {},
  ) {
    const id = randomUUID();
    shipmentIds.push(id);
    await sql`INSERT INTO shipments (id, site_id, status_id, kind, receiver_counterparty_id, receiver_mol_id)
      VALUES (${id}, ${siteId}, ${shippedStatusId}, ${opts.kind ?? 'contractor'},
        ${receiver === 'contractor' ? contractorId : null}, ${receiver === 'mol' ? molId : null})`;
    if (opts.withDocument) {
      await sql`INSERT INTO shipment_sources (shipment_id, source_document_id) VALUES (${id}, ${docId})`;
    }
    return id;
  }

  type Row = {
    kind: string;
    receiver_counterparty_id: string | null;
    receiver_mol_id: string | null;
    version: number;
    updated_at: string;
  };
  const rowOf = async (id: string): Promise<Row> =>
    (
      await sql<Row[]>`
        SELECT kind::text AS kind, receiver_counterparty_id::text AS receiver_counterparty_id,
               receiver_mol_id::text AS receiver_mol_id, version, updated_at::text AS updated_at
          FROM shipments WHERE id = ${id}`
    )[0]!;

  const setRecipient = (id: string, payload: unknown) =>
    app.inject({ method: 'PATCH', url: `/api/v1/shipments/${id}/recipient`, payload });
  const upsert = (id: string, extra: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/shipments',
      payload: {
        id,
        siteId,
        statusCode: 'shipped',
        kind: 'contractor',
        sourceDocumentIds: [],
        items: [],
        ...extra,
      },
    });

  /** См. одноимённый помощник в delivery-item-origin.int.test.ts. */
  async function waitForLockWaiter(queryPattern: string): Promise<void> {
    for (let i = 0; i < 250; i++) {
      const rows = await sql`
        SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND query ILIKE ${queryPattern}`;
      if (rows.length > 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`запрос «${queryPattern}» не встал в ожидание блокировки`);
  }

  describe('PATCH /shipments/:id/recipient', () => {
    it('подрядчик → МОЛ → никто; updated_at растёт, version нет', async () => {
      const id = await makeShipment();
      const before = await rowOf(id);
      const toContractor = await setRecipient(id, { contractorId });
      expect(toContractor.statusCode, toContractor.body).toBe(200);
      expect(toContractor.json()).toMatchObject({
        receiverCounterpartyId: contractorId,
        receiverMolId: null,
      });
      const afterContractor = await rowOf(id);
      expect(afterContractor.version).toBe(before.version);
      expect(afterContractor.updated_at > before.updated_at).toBe(true);

      await setRecipient(id, { recipientMolId: molId });
      expect(await rowOf(id)).toMatchObject({ receiver_counterparty_id: null, receiver_mol_id: molId });
      expect((await setRecipient(id, { none: true })).statusCode).toBe(200);
      expect(await rowOf(id)).toMatchObject({ receiver_counterparty_id: null, receiver_mol_id: null });
    });

    it('с привязанной УПД снять получателя нельзя — 422 receiver_required', async () => {
      const id = await makeShipment('contractor', { withDocument: true });
      const res = await setRecipient(id, { none: true });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: 'receiver_required' });
      expect((await rowOf(id)).receiver_counterparty_id).toBe(contractorId);
    });

    it('404, 409 pending_deletion и kind_not_supported, 422 на неизвестного получателя', async () => {
      expect((await setRecipient(randomUUID(), { contractorId })).statusCode).toBe(404);

      const pending = await makeShipment();
      await sql`UPDATE shipments SET pending_deletion_at = now(), pending_deletion_by_user_id = ${managerId}
                 WHERE id = ${pending}`;
      const pendingRes = await setRecipient(pending, { contractorId });
      expect(pendingRes.statusCode).toBe(409);
      expect(pendingRes.json()).toMatchObject({ error: 'pending_deletion' });

      // Перемещение и возврат живут через «Сохранить»: у перемещения получатель
      // уходит ещё и в парную приёмку. Списание — самый простой «не тот вид».
      const writeoff = await makeShipment('none', { kind: 'writeoff' });
      const kindRes = await setRecipient(writeoff, { contractorId });
      expect(kindRes.statusCode).toBe(409);
      expect(kindRes.json()).toMatchObject({ error: 'kind_not_supported' });
      const returnShipment = await makeShipment('contractor', { kind: 'return' });
      expect((await setRecipient(returnShipment, { contractorId })).statusCode).toBe(409);

      const id = await makeShipment('contractor');
      const before = await rowOf(id);
      const unknownContractor = await setRecipient(id, { contractorId: randomUUID() });
      expect(unknownContractor.statusCode).toBe(422);
      expect(unknownContractor.json()).toMatchObject({ error: 'unknown_contractor' });
      const unknownMol = await setRecipient(id, { recipientMolId: randomUUID() });
      expect(unknownMol.statusCode).toBe(422);
      expect(unknownMol.json()).toMatchObject({ error: 'unknown_recipient_mol' });
      expect(await rowOf(id)).toEqual(before);
    });

    it('мониторинг: без выданной правки отгрузок 403, с выданной — 200', async () => {
      const id = await makeShipment();
      currentUser = { ...currentUser, role: 'monitor' };
      expect((await setRecipient(id, { contractorId })).statusCode).toBe(403);
      monitorEditGranted = true;
      const res = await setRecipient(id, { contractorId });
      expect(res.statusCode, res.body).toBe(200);
      expect((await rowOf(id)).receiver_counterparty_id).toBe(contractorId);
    });
  });

  describe('upsert с keepReceiver', () => {
    it('устаревший получатель формы не пишется; без флага — пишется (поведение планшета)', async () => {
      const id = await makeShipment('mol');
      expect((await setRecipient(id, { contractorId })).statusCode).toBe(200);
      const staleForm = { receiverCounterpartyId: null, receiverMolId: molId };

      const kept = await upsert(id, { ...staleForm, keepReceiver: true, comment: 'с флагом' });
      expect(kept.statusCode, kept.body).toBe(200);
      expect(await rowOf(id)).toMatchObject({
        receiver_counterparty_id: contractorId,
        receiver_mol_id: null,
      });

      const overwrite = await upsert(id, staleForm);
      expect(overwrite.statusCode, overwrite.body).toBe(200);
      expect(await rowOf(id)).toMatchObject({ receiver_counterparty_id: null, receiver_mol_id: molId });
    });

    it('keepReceiver: вид проверяется с фактическим получателем, а не со снимком формы', async () => {
      // В строке МОЛ, форма думает, что там подрядчик, и меняет вид на возврат:
      // возврат с МОЛ — 400 invalid_kind_links, а не ошибка CHECK базы.
      const id = await makeShipment('mol');
      const before = await rowOf(id);
      const res = await upsert(id, {
        kind: 'return',
        receiverCounterpartyId: contractorId,
        receiverMolId: null,
        keepReceiver: true,
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_kind_links' });
      expect(await rowOf(id)).toEqual(before);
    });

    it('PATCH получателя, зафиксированный, пока upsert ждёт блокировку: 400, а не 500', async () => {
      // T0 держит строку и меняет подрядчика на МОЛ (как PATCH); upsert формы
      // со сменой вида на «возврат» встаёт в очередь на FOR UPDATE и после
      // фиксации T0 видит МОЛ — возврат с МОЛ отвергается проверкой, а не CHECK.
      const id = await makeShipment('contractor');
      let locked!: () => void;
      let proceed!: () => void;
      const lockedP = new Promise<void>((r) => (locked = r));
      const proceedP = new Promise<void>((r) => (proceed = r));
      const t0 = sql.begin(async (tx) => {
        await tx`SELECT id FROM shipments WHERE id = ${id} FOR UPDATE`;
        locked();
        await proceedP;
        await tx`UPDATE shipments SET receiver_counterparty_id = NULL, receiver_mol_id = ${molId},
                   updated_at = now() WHERE id = ${id}`;
      });
      await lockedP;
      const upsertP = upsert(id, {
        kind: 'return',
        receiverCounterpartyId: contractorId,
        receiverMolId: null,
        keepReceiver: true,
      });
      await waitForLockWaiter('%from "shipments"%for update');
      proceed();
      await t0;
      const res = await upsertP;
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_kind_links' });
      expect(await rowOf(id)).toMatchObject({
        kind: 'contractor',
        receiver_counterparty_id: null,
        receiver_mol_id: molId,
      });
    });

    it('у новой записи флаг не действует: получатель из запроса и проверяется сразу', async () => {
      const id = randomUUID();
      shipmentIds.push(id);
      const bad = await upsert(id, {
        kind: 'return',
        receiverCounterpartyId: null,
        receiverMolId: molId,
        keepReceiver: true,
      });
      expect(bad.statusCode, bad.body).toBe(400);
      const ok = await upsert(id, { receiverCounterpartyId: contractorId, keepReceiver: true });
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await rowOf(id)).receiver_counterparty_id).toBe(contractorId);
    });
  });
});
