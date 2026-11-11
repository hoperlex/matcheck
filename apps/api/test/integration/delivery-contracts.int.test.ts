/**
 * Договор 1С приёмки на настоящем PostgreSQL: подбор по ИНН поставщика из
 * документов и порядок по объекту, выбор → замена → отвязка с журналом, повтор
 * после потерянного ответа (200 без нового события), настоящая гонка двух
 * выборов, вид договора в транзакции, отказы и видимость по ролям.
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
import { supplierContractsRoutes } from '../../src/routes/supplier-contracts.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const SUPPLIER_INN = '7800000011';
const OTHER_INN = '7800000022';

suite('договор 1С в приёмке', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;
  let filledStatusId: string;

  const siteS = randomUUID();
  const siteT = randomUUID();
  const codeS = `CS${siteS.slice(0, 6)}`;
  const codeT = `CT${siteT.slice(0, 6)}`;
  const managerId = randomUUID();
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
    const db = drizzle(sql, { schema, casing: 'snake_case' });
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
    // recipient-mode и unlink-source проверяют матрицу (assertPermission):
    // пустые overrides — дефолтные права менеджера.
    app.decorate('permissions', { enforced: true, get: async () => new Map() } as never);
    app.decorate('logUnauthorized', async () => {});
    await app.register(deliveryRoutes);
    await app.register(supplierContractsRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteS}, ${codeS}, 'Объект S'), (${siteT}, ${codeT}, 'Объект T')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id, full_name) VALUES
      (${managerId}, ${`m-${managerId}@t.local`}, 'x', 'manager', NULL, 'Менеджер Тестов'),
      (${inspectorT}, ${`t-${inspectorT}@t.local`}, 'x', 'inspector_kpp', ${siteT}, NULL)`;
    const [status] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    filledStatusId = status!.id;
  });

  async function clean() {
    await sql`DELETE FROM delivery_contracts`;
    await sql`DELETE FROM delivery_contract_events`;
    await sql`DELETE FROM supplier_contracts`;
    await sql`DELETE FROM supplier_contract_imports`;
  }

  beforeEach(async () => {
    await clean();
    currentUser = as('manager');
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await clean();
    const list = (ids: string[]) => ids.join(',');
    await sql`DELETE FROM delivery_sources WHERE delivery_id::text = ANY(string_to_array(${list(createdDeliveries)}, ','))`;
    await sql`DELETE FROM deliveries WHERE id::text = ANY(string_to_array(${list(createdDeliveries)}, ','))`;
    await sql`DELETE FROM shipments WHERE id::text = ANY(string_to_array(${list(createdShipments)}, ','))`;
    await sql`DELETE FROM source_documents WHERE id::text = ANY(string_to_array(${list(createdDocs)}, ','))`;
    await sql`DELETE FROM users WHERE id IN (${managerId}, ${inspectorT})`;
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

  async function linkDocument(deliveryId: string, supplierInn: string | null) {
    const id = randomUUID();
    createdDocs.push(id);
    await sql`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, doc_number, supplier_inn_raw)
      VALUES (${id}, 'upd', 'inbound', 'parsed', 'edo_diadoc', ${siteS}, ${`N-${id.slice(0, 6)}`}, ${supplierInn})`;
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id) VALUES (${deliveryId}, ${id})`;
    return id;
  }

  async function contract(patch: {
    inn?: string;
    name?: string;
    date?: string | null;
    kind?: 'supplier' | 'buyer' | 'other';
    status?: 'exact' | 'group' | 'conflict' | 'none';
    sites?: string[];
    missing?: boolean;
  } = {}): Promise<string> {
    const id = randomUUID();
    const sites = patch.sites ?? [siteS];
    await sql`INSERT INTO supplier_contracts
      (id, onec_id, counterparty_name, counterparty_inn, name, number, contract_date, kind, site_status, site_ids, missing_since)
      VALUES (${id}, ${randomUUID()}, 'ПОСТАВЩИК ООО', ${patch.inn ?? SUPPLIER_INN}, ${patch.name ?? `Договор ${id.slice(0, 6)}`},
              ${`СУ-${id.slice(0, 4)}`}, ${patch.date === undefined ? '2026-01-01' : patch.date}::date, ${patch.kind ?? 'supplier'},
              ${patch.status ?? (sites.length === 0 ? 'none' : 'exact')}, ${`{${sites.join(',')}}`}::uuid[],
              ${patch.missing ? new Date().toISOString() : null}::timestamptz)`;
    return id;
  }

  const get = (d: string) => app.inject({ method: 'GET', url: `/api/v1/deliveries/${d}/contract` });
  const putDoc = (d: string, documentId: string, contractId: string, replaceContractId: string | null) =>
    app.inject({
      method: 'PUT',
      url: `/api/v1/deliveries/${d}/contract`,
      payload: { documentId, contractId, replaceContractId },
    });
  const delDoc = (d: string, documentId: string, expectedContractId: string) =>
    app.inject({
      method: 'DELETE',
      url: `/api/v1/deliveries/${d}/contract?expectedContractId=${expectedContractId}&documentId=${documentId}`,
    });
  const recipientMode = (d: string, perDocument: boolean) =>
    app.inject({ method: 'PATCH', url: `/api/v1/deliveries/${d}/recipient-mode`, payload: { perDocument } });
  const docEvents = async (d: string) =>
    (
      await sql<{ kind: string; doc: string | null; contract_id: string | null; previous: string | null; reason: string | null }[]>`
        SELECT kind, source_document_id::text AS doc, contract_id::text AS contract_id,
               previous_contract_id::text AS previous, reason
        FROM delivery_contract_events WHERE delivery_id = ${d} ORDER BY id`
    ).map((e) => [e.kind, e.doc, e.contract_id, e.previous, e.reason]);
  const links = async (d: string) =>
    (
      await sql<{ doc: string | null; contract_id: string }[]>`
        SELECT source_document_id::text AS doc, contract_id::text AS contract_id
        FROM delivery_contracts WHERE delivery_id = ${d} ORDER BY source_document_id NULLS FIRST`
    ).map((r) => [r.doc, r.contract_id]);
  const candidates = (d: string, query = '') =>
    app.inject({ method: 'GET', url: `/api/v1/deliveries/${d}/contract-candidates${query}` });
  const put = (d: string, contractId: string, replaceContractId: string | null) =>
    app.inject({ method: 'PUT', url: `/api/v1/deliveries/${d}/contract`, payload: { contractId, replaceContractId } });
  const del = (d: string, expectedContractId: string) =>
    app.inject({ method: 'DELETE', url: `/api/v1/deliveries/${d}/contract?expectedContractId=${expectedContractId}` });
  const events = async (d: string) =>
    (
      await sql<{ kind: string; contract_id: string | null; previous_contract_id: string | null }[]>`
        SELECT kind, contract_id::text AS contract_id, previous_contract_id::text AS previous_contract_id
        FROM delivery_contract_events WHERE delivery_id = ${d} ORDER BY id`
    ).map((e) => [e.kind, e.contract_id, e.previous_contract_id]);

  describe('подбор', () => {
    it('по умолчанию — договоры поставщика из УПД; порядок: этот объект → не определён → другой', async () => {
      const d = await delivery();
      await linkDocument(d, SUPPLIER_INN);
      const other = await contract({ sites: [siteT], date: '2026-09-01' });
      const none = await contract({ sites: [], date: '2026-08-01' });
      const conflict = await contract({ sites: [siteS, siteT], status: 'conflict', date: '2026-10-01' });
      const exact = await contract({ sites: [siteS], date: '2025-01-01' });
      const group = await contract({ sites: [siteS, siteT], status: 'group', date: '2025-02-01' });
      const foreign = await contract({ inn: OTHER_INN });
      await contract({ kind: 'buyer' });

      const res = await candidates(d);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const ids = body.items.map((x: { id: string }) => x.id);
      // ранг 0 (exact/group с объектом) по дате, затем ранг 1 (conflict, none) по дате, затем другой.
      expect(ids).toEqual([group, exact, conflict, none, other]);
      expect(ids).not.toContain(foreign);
      expect(body.context).toMatchObject({
        supplierInns: [SUPPLIER_INN],
        supplierKnown: true,
        filteredBySupplier: true,
        siteCode: codeS,
        supplierContractsTotal: 5,
      });
      const byId = new Map(body.items.map((x: { id: string }) => [x.id, x]));
      expect(byId.get(conflict)).toMatchObject({ siteMatch: 'conflict', supplierMatch: true });
      expect(byId.get(group)).toMatchObject({ siteMatch: 'group' });
      expect(byId.get(exact)).toMatchObject({ siteMatch: 'match' });
      expect(byId.get(none)).toMatchObject({ siteMatch: 'unknown' });
      expect(byId.get(other)).toMatchObject({ siteMatch: 'other' });
    });

    it('«Все поставщики» — свой поставщик сверху, договоры «С покупателем» не показываются', async () => {
      const d = await delivery();
      await linkDocument(d, SUPPLIER_INN);
      const mine = await contract({ date: '2020-01-01' });
      const foreign = await contract({ inn: OTHER_INN, date: '2026-01-01' });
      const buyer = await contract({ kind: 'buyer' });
      const res = await candidates(d, '?allSuppliers=1');
      const items = res.json().items as { id: string; supplierMatch: boolean | null }[];
      expect(items.map((x) => x.id)).toEqual([mine, foreign]);
      expect(items.map((x) => x.supplierMatch)).toEqual([true, false]);
      expect(items.map((x) => x.id)).not.toContain(buyer);
      expect(res.json().context.filteredBySupplier).toBe(false);
    });

    it('ИНН поставщика неизвестен — все договоры, supplierKnown=false; поиск по номеру', async () => {
      const d = await delivery();
      const a = await contract({ name: 'Договор поставки №ГО/25-33' });
      await contract({ inn: OTHER_INN, name: 'Счет №9300' });
      const all = (await candidates(d)).json();
      expect(all.context).toMatchObject({ supplierKnown: false, filteredBySupplier: false });
      expect(all.total).toBe(2);
      const found = (await candidates(d, `?q=${encodeURIComponent('ГО/25-33')}`)).json();
      expect(found.items.map((x: { id: string }) => x.id)).toEqual([a]);
    });

    it('текущий договор помечен current', async () => {
      const d = await delivery();
      const a = await contract();
      await put(d, a, null);
      const items = (await candidates(d)).json().items as { id: string; current: boolean }[];
      expect(items.find((x) => x.id === a)!.current).toBe(true);
    });
  });

  describe('выбор, замена, отвязка', () => {
    it('выбор → замена → отвязка, журнал и флаги ответа', async () => {
      const d = await delivery();
      await linkDocument(d, SUPPLIER_INN);
      const a = await contract();
      const b = await contract({ inn: OTHER_INN, sites: [siteT] });

      expect((await get(d)).json()).toMatchObject({ contract: null, catalog: { total: 2 } });

      const r1 = await put(d, a, null);
      expect(r1.statusCode).toBe(200);
      expect(r1.json().contract).toMatchObject({
        id: a,
        supplierMatch: true,
        siteMatch: 'match',
        kindChanged: false,
        missing: false,
        linkedByName: 'Менеджер Тестов',
      });

      const r2 = await put(d, b, a);
      expect(r2.statusCode).toBe(200);
      expect(r2.json().contract).toMatchObject({ id: b, supplierMatch: false, siteMatch: 'other' });

      const r3 = await del(d, b);
      expect(r3.statusCode).toBe(200);
      expect(r3.json().contract).toBeNull();

      expect(await events(d)).toEqual([
        ['linked', a, null],
        ['replaced', b, a],
        ['unlinked', null, b],
      ]);
    });

    it('повтор после потерянного ответа: PUT дважды и DELETE дважды — 200, по одному событию', async () => {
      const d = await delivery();
      const a = await contract();
      const b = await contract();
      await put(d, a, null);
      expect((await put(d, b, a)).statusCode).toBe(200);
      expect((await put(d, b, a)).statusCode).toBe(200); // повтор: текущий уже B
      expect((await del(d, b)).statusCode).toBe(200);
      expect((await del(d, b)).statusCode).toBe(200); // повтор: связи уже нет
      expect((await events(d)).map((e) => e[0])).toEqual(['linked', 'replaced', 'unlinked']);
    });

    it('чужая замена: ожидаемый договор не совпал — 409 contract_changed с текущим', async () => {
      const d = await delivery();
      const a = await contract();
      const b = await contract();
      const c = await contract();
      await put(d, a, null);
      await put(d, c, a); // другой пользователь заменил на C
      const res = await put(d, b, a); // первый всё ещё думает, что там A
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'contract_changed', current: { id: c } });
      const unlink = await del(d, a);
      expect(unlink.statusCode).toBe(409);
      expect(unlink.json()).toMatchObject({ error: 'contract_changed', current: { id: c } });
    });

    it('настоящая гонка: два одновременных выбора на пустой приёмке — один 200, второй 409', async () => {
      for (let round = 0; round < 10; round++) {
        const d = await delivery();
        const b = await contract();
        const c = await contract();
        const [rb, rc] = await Promise.all([put(d, b, null), put(d, c, null)]);
        const codes = [rb.statusCode, rc.statusCode].sort();
        expect(codes).toEqual([200, 409]);
        const loser = rb.statusCode === 409 ? rb : rc;
        expect(loser.json()).toMatchObject({ error: 'contract_changed' });
        const links = await sql`SELECT contract_id FROM delivery_contracts WHERE delivery_id = ${d}`;
        expect(links).toHaveLength(1);
        expect(await events(d)).toHaveLength(1);
      }
    });

    it('договор «С покупателем» прямым запросом — 409 contract_kind', async () => {
      const d = await delivery();
      const buyer = await contract({ kind: 'buyer' });
      const res = await put(d, buyer, null);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'contract_kind' });
    });

    it('приёмка на удалении, перемещение, нет договора', async () => {
      const a = await contract();
      const pending = await delivery(siteS, { pending: true });
      expect((await put(pending, a, null)).json()).toMatchObject({ error: 'pending_deletion' });

      const shipmentId = randomUUID();
      createdShipments.push(shipmentId);
      await sql`INSERT INTO shipments (id, kind, site_id, status_id)
        SELECT ${shipmentId}, 'contractor', ${siteT}, id FROM statuses WHERE entity_type = 'shipment' LIMIT 1`;
      const transfer = await delivery(siteS, { shipmentId });
      expect((await put(transfer, a, null)).json()).toMatchObject({ error: 'transfer_pair' });

      const d = await delivery();
      expect((await put(d, randomUUID(), null)).statusCode).toBe(404);
      expect((await put(randomUUID(), a, null)).statusCode).toBe(404);
    });

    it('после импорта, сменившего вид, связь цела и kindChanged=true; отвязка документа пересчитывает supplierMatch', async () => {
      const d = await delivery();
      const doc = await linkDocument(d, SUPPLIER_INN);
      const a = await contract();
      await put(d, a, null);
      await sql`UPDATE supplier_contracts SET kind = 'buyer', missing_since = now() WHERE id = ${a}`;
      const body = (await get(d)).json();
      expect(body.contract).toMatchObject({ id: a, kindChanged: true, missing: true, supplierMatch: true });
      // Повтор выбора того же договора — достигнутое состояние, 200.
      expect((await put(d, a, null)).statusCode).toBe(200);

      await sql`DELETE FROM delivery_sources WHERE delivery_id = ${d} AND source_document_id = ${doc}`;
      expect((await get(d)).json().contract.supplierMatch).toBeNull();
      await linkDocument(d, OTHER_INN);
      expect((await get(d)).json().contract.supplierMatch).toBe(false);
    });
  });

  describe('связь и приёмка', () => {
    it('удаление приёмки каскадом убирает связь; журнал остаётся', async () => {
      const d = await delivery();
      const a = await contract();
      await put(d, a, null);
      await sql`DELETE FROM deliveries WHERE id = ${d}`;
      expect(await sql`SELECT 1 FROM delivery_contracts WHERE delivery_id = ${d}`).toHaveLength(0);
      expect(await events(d)).toHaveLength(1);
    });

    it('выбор договора не меняет version приёмки', async () => {
      const d = await delivery();
      const a = await contract();
      const [before] = await sql<{ version: number }[]>`SELECT version FROM deliveries WHERE id = ${d}`;
      await put(d, a, null);
      const [after] = await sql<{ version: number }[]>`SELECT version FROM deliveries WHERE id = ${d}`;
      expect(after!.version).toBe(before!.version);
    });
  });

  describe('договор документа (режим «Разные получатели по документам»)', () => {
    /** Приёмка с двумя документами: doc1 от SUPPLIER_INN, doc2 от OTHER_INN. */
    async function twoDocDelivery(perDocument = true) {
      const d = await delivery();
      const doc1 = await linkDocument(d, SUPPLIER_INN);
      const doc2 = await linkDocument(d, OTHER_INN);
      if (perDocument) expect((await recipientMode(d, true)).statusCode).toBe(200);
      return { d, doc1, doc2 };
    }

    it('режим выключен — 409 per_document_off; документ не привязан — 404', async () => {
      const { d, doc1 } = await twoDocDelivery(false);
      const a = await contract();
      const off = await putDoc(d, doc1, a, null);
      expect(off.statusCode).toBe(409);
      expect(off.json()).toMatchObject({ error: 'per_document_off' });
      expect((await recipientMode(d, true)).statusCode).toBe(200);
      const missing = await putDoc(d, randomUUID(), a, null);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ error: 'document_not_linked' });
      expect(await links(d)).toEqual([]);
    });

    it('общий и договор документа живут вместе; отвязка общего договоры документов НЕ трогает', async () => {
      const { d, doc1 } = await twoDocDelivery();
      const general = await contract();
      const own = await contract();
      expect((await put(d, general, null)).statusCode).toBe(200);
      expect((await putDoc(d, doc1, own, null)).statusCode).toBe(200);
      expect(await links(d)).toEqual([
        [null, general],
        [doc1, own],
      ]);

      const body = (await get(d)).json();
      expect(body).toMatchObject({ perDocument: true, contract: { id: general } });
      expect(body.documents).toEqual([expect.objectContaining({ documentId: doc1, contract: expect.objectContaining({ id: own }) })]);

      // Отвязка общего — только общая строка.
      expect((await del(d, general)).statusCode).toBe(200);
      expect(await links(d)).toEqual([[doc1, own]]);
      expect(await docEvents(d)).toEqual([
        ['linked', null, general, null, null],
        ['linked', doc1, own, null, null],
        ['unlinked', null, null, general, null],
      ]);
    });

    it('повторы: PUT документа дважды и DELETE дважды — 200, по одному событию; чужая замена — 409', async () => {
      const { d, doc1 } = await twoDocDelivery();
      const a = await contract();
      const b = await contract();
      const c = await contract();
      expect((await putDoc(d, doc1, a, null)).statusCode).toBe(200);
      expect((await putDoc(d, doc1, a, null)).statusCode).toBe(200);
      expect((await putDoc(d, doc1, b, a)).statusCode).toBe(200);
      const stale = await putDoc(d, doc1, c, a);
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: 'contract_changed', current: { id: b } });
      expect((await delDoc(d, doc1, b)).statusCode).toBe(200);
      expect((await delDoc(d, doc1, b)).statusCode).toBe(200);
      expect((await docEvents(d)).map((e) => e[0])).toEqual(['linked', 'replaced', 'unlinked']);
    });

    it('настоящая гонка двух выборов договора одного документа — один 200, второй 409', async () => {
      for (let round = 0; round < 10; round++) {
        const { d, doc1 } = await twoDocDelivery();
        const b = await contract();
        const c = await contract();
        const [rb, rc] = await Promise.all([putDoc(d, doc1, b, null), putDoc(d, doc1, c, null)]);
        expect([rb.statusCode, rc.statusCode].sort()).toEqual([200, 409]);
        expect(await links(d)).toHaveLength(1);
        expect(await docEvents(d)).toHaveLength(1);
      }
    });

    it('supplierMatch договора документа — по ИНН этого документа, а не всей приёмки', async () => {
      const { d, doc1, doc2 } = await twoDocDelivery();
      const supplierContract = await contract({ inn: SUPPLIER_INN });
      expect((await putDoc(d, doc1, supplierContract, null)).statusCode).toBe(200);
      expect((await putDoc(d, doc2, supplierContract, null)).statusCode).toBe(200);
      const docs = (await get(d)).json().documents as { documentId: string; contract: { supplierMatch: boolean | null } }[];
      expect(docs.find((x) => x.documentId === doc1)!.contract.supplierMatch).toBe(true);
      // У приёмки в целом SUPPLIER_INN есть (doc1), но поставщик doc2 — OTHER_INN.
      expect(docs.find((x) => x.documentId === doc2)!.contract.supplierMatch).toBe(false);
    });

    it('подбор для документа — по ИНН его поставщика; current — договор этого документа', async () => {
      const { d, doc1, doc2 } = await twoDocDelivery();
      const mine = await contract({ inn: SUPPLIER_INN });
      const other = await contract({ inn: OTHER_INN });
      await putDoc(d, doc2, other, null);
      const forDoc2 = (await candidates(d, `?documentId=${doc2}`)).json();
      expect(forDoc2.context).toMatchObject({ documentId: doc2, supplierInns: [OTHER_INN], filteredBySupplier: true });
      expect(forDoc2.items.map((x: { id: string; current: boolean }) => [x.id, x.current])).toEqual([[other, true]]);
      const forDoc1 = (await candidates(d, `?documentId=${doc1}`)).json();
      expect(forDoc1.items.map((x: { id: string; current: boolean }) => [x.id, x.current])).toEqual([[mine, false]]);
      // Общий подбор — по ИНН всей приёмки, current общий (его нет).
      const general = (await candidates(d)).json();
      expect(general.context.documentId).toBeNull();
      expect(general.items.every((x: { current: boolean }) => !x.current)).toBe(true);
    });

    it('выключение режима снимает договоры документов (reason mode_off), общий остаётся', async () => {
      const { d, doc1, doc2 } = await twoDocDelivery();
      const general = await contract();
      const a = await contract();
      const b = await contract();
      await put(d, general, null);
      await putDoc(d, doc1, a, null);
      await putDoc(d, doc2, b, null);
      expect((await recipientMode(d, false)).statusCode).toBe(200);
      expect(await links(d)).toEqual([[null, general]]);
      const resetEvents = (await docEvents(d)).filter((e) => e[4] === 'mode_off');
      expect(resetEvents.map((e) => [e[0], e[1], e[3]]).sort()).toEqual(
        [
          ['unlinked', doc1, a],
          ['unlinked', doc2, b],
        ].sort(),
      );
      const body = (await get(d)).json();
      expect(body).toMatchObject({ perDocument: false, documents: [], contract: { id: general } });
    });

    it('отвязка документа снимает его договор с событием document_unlinked', async () => {
      const { d, doc1, doc2 } = await twoDocDelivery();
      const a = await contract();
      const b = await contract();
      await putDoc(d, doc1, a, null);
      await putDoc(d, doc2, b, null);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/deliveries/${d}/unlink-source`,
        payload: { sourceDocumentId: doc1 },
      });
      expect(res.statusCode).toBe(200);
      expect(await links(d)).toEqual([[doc2, b]]);
      expect((await docEvents(d)).at(-1)).toEqual(['unlinked', doc1, null, a, 'document_unlinked']);
    });

    it('без явного снятия связь документа не переживает удаление строки delivery_sources (FK-каскад)', async () => {
      const { d, doc1 } = await twoDocDelivery();
      const a = await contract();
      await putDoc(d, doc1, a, null);
      await sql`DELETE FROM delivery_sources WHERE delivery_id = ${d} AND source_document_id = ${doc1}`;
      expect(await links(d)).toEqual([]);
    });

    it('полный upsert приёмки (как с планшета) договоры документов не трогает', async () => {
      const { d, doc1 } = await twoDocDelivery();
      const general = await contract();
      const a = await contract();
      await put(d, general, null);
      await putDoc(d, doc1, a, null);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/deliveries',
        payload: { id: d, statusCode: 'filled', siteId: siteS, comment: 'с планшета', items: [], sourceDocumentIds: [] },
      });
      expect(res.statusCode).toBe(200);
      expect(await links(d)).toEqual([
        [null, general],
        [doc1, a],
      ]);
    });
  });

  describe('видимость по ролям', () => {
    it('инспектор чужого объекта — 404, подрядчик — 403, monitor видит договор', async () => {
      const d = await delivery(siteS);
      const a = await contract();
      await put(d, a, null);
      currentUser = as('inspector_kpp', inspectorT, siteT);
      expect((await get(d)).statusCode).toBe(404);
      currentUser = as('contractor');
      expect((await get(d)).statusCode).toBe(403);
      currentUser = as('monitor');
      expect((await get(d)).json().contract).toMatchObject({ id: a });
    });
  });
});
