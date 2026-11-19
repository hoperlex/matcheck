import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserRole } from '@matcheck/contracts';
import * as schema from '../../src/db/schema.js';
import { deliveryRoutes } from '../../src/routes/deliveries.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

// Общий получатель приёмки сохраняется сразу (PATCH /deliveries/:id/recipient),
// а «Сохранить» портала идёт с keepRecipient и получателя не трогает. Жалоба
// мониторинга 18.11.2026: выбор в чипе терялся до «Сохранить».
suite('получатель приёмки сразу и keepRecipient у upsert (PostgreSQL)', { timeout: 60_000 }, () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;
  // Администратор выдал Мониторингу «Приёмки × Редактировать»: боевой плагин
  // прав ставит req.permissionExpanded, и authorize снимает allow-list. Здесь
  // плагина нет — оба слоя повторены моками, как в delivery-document-recipients.
  let monitorEditGranted = false;
  const siteId = randomUUID();
  const managerId = randomUUID();
  const sessionId = randomUUID();
  const contractorId = randomUUID();
  const molId = randomUUID();
  const docs = [randomUUID(), randomUUID()];
  let filledStatusId: string;
  const deliveryIds: string[] = [];

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
            ? [['monitor:operations.deliveries', { view: true, review: true, edit: true }] as const]
            : [],
        ),
    } as never);
    app.decorate('logUnauthorized', async () => {});
    await app.register(deliveryRoutes);
    await app.ready();
    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`RP${siteId.slice(0, 6)}`}, 'Получатель сразу')`;
    await sql`INSERT INTO users (id, email, password_hash, role) VALUES (${managerId}, ${`rp-${managerId}@test`}, 'x', 'manager')`;
    await sql`INSERT INTO sessions (id, user_id) VALUES (${sessionId}, ${managerId})`;
    await sql`INSERT INTO counterparties (id, inn, name, is_contractor)
      VALUES (${contractorId}, ${`7${contractorId.replace(/\D/g, '').slice(0, 9).padEnd(9, '0')}`}, 'Подрядчик сразу', true)`;
    await sql`INSERT INTO responsible_persons (id, full_name) VALUES (${molId}, 'МОЛ сразу')`;
    const [status] = await sql<
      { id: string }[]
    >`SELECT id FROM statuses WHERE entity_type='delivery' AND code='filled' LIMIT 1`;
    filledStatusId = status!.id;
    for (const [index, id] of docs.entries()) {
      await sql`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum, parsed_at)
        VALUES (${id}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId}, ${`RP-${index}`}, now(), '100.00', now())`;
    }
  });

  beforeEach(() => {
    monitorEditGranted = false;
    currentUser = { ...currentUser, role: 'manager' };
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    if (deliveryIds.length) await sql`DELETE FROM deliveries WHERE id IN ${sql(deliveryIds)}`;
    await sql`DELETE FROM source_documents WHERE id IN ${sql(docs)}`;
    await sql`DELETE FROM sessions WHERE id = ${sessionId}`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM responsible_persons WHERE id = ${molId}`;
    await sql`DELETE FROM counterparties WHERE id = ${contractorId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  async function makeDelivery(
    recipient: 'contractor' | 'mol' | 'none' = 'none',
    opts: { linkCount?: number; purpose?: string | null } = {},
  ) {
    const id = randomUUID();
    deliveryIds.push(id);
    const purpose = opts.purpose !== undefined ? opts.purpose : recipient === 'mol' ? 'own_forces' : null;
    await sql`INSERT INTO deliveries (id, site_id, status_id, contractor_id, recipient_mol_id, purpose)
      VALUES (${id}, ${siteId}, ${filledStatusId},
        ${recipient === 'contractor' ? contractorId : null}, ${recipient === 'mol' ? molId : null},
        ${purpose})`;
    for (const docId of docs.slice(0, opts.linkCount ?? 0)) {
      await sql`INSERT INTO delivery_sources (delivery_id, source_document_id) VALUES (${id}, ${docId})`;
    }
    return id;
  }

  type Row = {
    contractor_id: string | null;
    recipient_mol_id: string | null;
    purpose: string | null;
    version: number;
    updated_at: string;
  };
  const rowOf = async (id: string): Promise<Row> =>
    (
      await sql<Row[]>`
        SELECT contractor_id::text AS contractor_id, recipient_mol_id::text AS recipient_mol_id,
               purpose, version, updated_at::text AS updated_at
          FROM deliveries WHERE id = ${id}`
    )[0]!;

  const setRecipient = (id: string, payload: unknown) =>
    app.inject({ method: 'PATCH', url: `/api/v1/deliveries/${id}/recipient`, payload });
  const patch = (id: string, suffix: string, payload: unknown) =>
    app.inject({ method: 'PATCH', url: `/api/v1/deliveries/${id}${suffix}`, payload });
  const upsert = (id: string, extra: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/deliveries',
      payload: { id, siteId, statusCode: 'filled', sourceDocumentIds: [], items: [], ...extra },
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

  describe('PATCH /deliveries/:id/recipient', () => {
    it('подрядчик → МОЛ → никто; признак согласуется, updated_at растёт, version нет', async () => {
      const id = await makeDelivery('none', { purpose: null });
      const before = await rowOf(id);

      const toContractor = await setRecipient(id, { contractorId });
      expect(toContractor.statusCode, toContractor.body).toBe(200);
      expect(toContractor.json()).toMatchObject({ contractorId, recipientMolId: null });
      const afterContractor = await rowOf(id);
      expect(afterContractor).toMatchObject({ contractor_id: contractorId, recipient_mol_id: null });
      expect(afterContractor.version).toBe(before.version);
      expect(afterContractor.updated_at > before.updated_at).toBe(true);

      // МОЛ, а до этого МОЛ не было → «Свои силы» (reconcileDeliveryPurpose).
      const toMol = await setRecipient(id, { recipientMolId: molId });
      expect(toMol.statusCode, toMol.body).toBe(200);
      expect(await rowOf(id)).toMatchObject({
        contractor_id: null,
        recipient_mol_id: molId,
        purpose: 'own_forces',
        version: before.version,
      });

      // Подрядчику «Свои силы» не бывает — признак снимается.
      await setRecipient(id, { contractorId });
      expect(await rowOf(id)).toMatchObject({ contractor_id: contractorId, purpose: null });

      const none = await setRecipient(id, { none: true });
      expect(none.statusCode, none.body).toBe(200);
      expect(await rowOf(id)).toMatchObject({ contractor_id: null, recipient_mol_id: null });
    });

    it('404, 409 pending_deletion, 422 на неизвестного подрядчика и МОЛ', async () => {
      expect((await setRecipient(randomUUID(), { contractorId })).statusCode).toBe(404);

      const pending = await makeDelivery();
      await sql`UPDATE deliveries SET pending_deletion_at = now(), pending_deletion_by_user_id = ${managerId}
                 WHERE id = ${pending}`;
      const pendingRes = await setRecipient(pending, { contractorId });
      expect(pendingRes.statusCode).toBe(409);
      expect(pendingRes.json()).toMatchObject({ error: 'pending_deletion' });

      const id = await makeDelivery('contractor');
      const before = await rowOf(id);
      const unknownContractor = await setRecipient(id, { contractorId: randomUUID() });
      expect(unknownContractor.statusCode).toBe(422);
      expect(unknownContractor.json()).toMatchObject({ error: 'unknown_contractor' });
      const unknownMol = await setRecipient(id, { recipientMolId: randomUUID() });
      expect(unknownMol.statusCode).toBe(422);
      expect(unknownMol.json()).toMatchObject({ error: 'unknown_recipient_mol' });
      expect(await rowOf(id)).toEqual(before);

      // Тело — ровно одно из трёх: оба поля сразу не проходят схему.
      expect((await setRecipient(id, { contractorId, recipientMolId: molId })).statusCode).toBe(400);
    });

    it('режим «Разные получатели»: наследуемые признаки документов согласуются, как у upsert', async () => {
      // Зеркало «планшетный upsert … смена вида согласует признак» из
      // delivery-document-recipients: документ наследует МОЛ, но держит свой
      // признак «Свои силы»; общий получатель стал подрядчиком — признак
      // документа снимается.
      const id = await makeDelivery('mol', { linkCount: 2 });
      expect((await patch(id, '/recipient-mode', { perDocument: true })).statusCode).toBe(200);
      const docId = docs[0]!;
      expect((await patch(id, `/sources/${docId}/purpose`, { purpose: 'own_forces' })).statusCode).toBe(
        200,
      );
      expect((await setRecipient(id, { contractorId })).statusCode).toBe(200);
      const [doc] = await sql<{ own_recipient: boolean; own_purpose: boolean; purpose: string | null }[]>`
        SELECT own_recipient, own_purpose, purpose FROM delivery_sources
         WHERE delivery_id = ${id} AND source_document_id = ${docId}`;
      expect(doc).toMatchObject({ own_recipient: false, own_purpose: true, purpose: null });
    });

    it('мониторинг: без выданной правки 403, с выданной — 200', async () => {
      const id = await makeDelivery();
      currentUser = { ...currentUser, role: 'monitor' };
      expect((await setRecipient(id, { contractorId })).statusCode).toBe(403);
      expect((await rowOf(id)).contractor_id).toBeNull();
      monitorEditGranted = true;
      const res = await setRecipient(id, { contractorId });
      expect(res.statusCode, res.body).toBe(200);
      expect((await rowOf(id)).contractor_id).toBe(contractorId);
    });
  });

  describe('upsert с keepRecipient', () => {
    it('устаревший получатель формы не пишется; без флага — пишется (поведение планшета)', async () => {
      const id = await makeDelivery('mol');
      // Форма открыта с МОЛ, получателя сменили PATCH-ем на подрядчика.
      expect((await setRecipient(id, { contractorId })).statusCode).toBe(200);
      const staleForm = { contractorId: null, recipientMolId: molId };

      const kept = await upsert(id, { ...staleForm, keepRecipient: true, comment: 'с флагом' });
      expect(kept.statusCode, kept.body).toBe(200);
      expect(await rowOf(id)).toMatchObject({
        contractor_id: contractorId,
        recipient_mol_id: null,
        // Признак не тронут: получатель тот же, «Свои силы» уже снят PATCH-ем.
        purpose: null,
      });
      expect(kept.json()).toMatchObject({ comment: 'с флагом', contractorId });

      const overwrite = await upsert(id, staleForm);
      expect(overwrite.statusCode, overwrite.body).toBe(200);
      expect(await rowOf(id)).toMatchObject({ contractor_id: null, recipient_mol_id: molId });
    });

    it('keepRecipient + «Свои силы» при сохранённом подрядчике → 422, строка не тронута', async () => {
      const id = await makeDelivery('contractor');
      const before = await rowOf(id);
      // Получатель запроса (МОЛ) допускает «Свои силы», но в строку ляжет
      // сохранённый подрядчик — решает проверка под блокировкой.
      const res = await upsert(id, {
        contractorId: null,
        recipientMolId: molId,
        keepRecipient: true,
        purpose: 'own_forces',
        comment: 'не должен записаться',
      });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json()).toMatchObject({ error: 'purpose_conflicts_recipient' });
      expect(await rowOf(id)).toEqual(before);
    });

    it('keepRecipient + допустимый признак проходит и пишет признак', async () => {
      const id = await makeDelivery('contractor');
      const res = await upsert(id, {
        contractorId: null,
        recipientMolId: null,
        keepRecipient: true,
        purpose: 'realization',
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(await rowOf(id)).toMatchObject({ contractor_id: contractorId, purpose: 'realization' });
    });

    it('у новой записи флаг не действует: получатель берётся из запроса', async () => {
      const id = randomUUID();
      deliveryIds.push(id);
      const res = await upsert(id, { contractorId, keepRecipient: true });
      expect(res.statusCode, res.body).toBe(200);
      expect((await rowOf(id)).contractor_id).toBe(contractorId);
    });

    it('PATCH получателя, зафиксированный, пока upsert ждёт блокировку, не перетирается', async () => {
      // T0 держит строку и делает то же, что PATCH /recipient; upsert формы со
      // старым получателем встаёт в очередь на FOR UPDATE первым оператором
      // транзакции (lockPurposeForRecipientWrite) и идёт после фиксации T0.
      const id = await makeDelivery('mol');
      let locked!: () => void;
      let proceed!: () => void;
      const lockedP = new Promise<void>((r) => (locked = r));
      const proceedP = new Promise<void>((r) => (proceed = r));
      const t0 = sql.begin(async (tx) => {
        await tx`SELECT id FROM deliveries WHERE id = ${id} FOR UPDATE`;
        locked();
        await proceedP;
        await tx`UPDATE deliveries SET contractor_id = ${contractorId}, recipient_mol_id = NULL,
                   purpose = NULL, updated_at = now() WHERE id = ${id}`;
      });
      await lockedP;
      const upsertP = upsert(id, {
        contractorId: null,
        recipientMolId: molId,
        keepRecipient: true,
        comment: 'форма со старым получателем',
      });
      await waitForLockWaiter('%from "deliveries"%for update');
      proceed();
      await t0;
      const res = await upsertP;
      expect(res.statusCode, res.body).toBe(200);
      expect(await rowOf(id)).toMatchObject({ contractor_id: contractorId, recipient_mol_id: null });
      expect(res.json()).toMatchObject({ comment: 'форма со старым получателем' });
    });
  });
});
