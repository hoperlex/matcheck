/**
 * Машинный канал 1С на настоящем PostgreSQL и с настоящим auth-плагином.
 *
 * Авторизация: выдача токена, отказы одной ошибкой, отзыв и ротация (новый токен
 * в ту же секунду проходит, старый — нет), сети учётки, изоляция от
 * пользовательского JWT в обе стороны, токен только из заголовка, scope,
 * рубильник.
 *
 * Очередь и подтверждения — по таблице правил плана: new / changed (правка
 * цены, отвязка ЭДО — без следа во времени) / deleted / restored, откат правки,
 * ошибка первой загрузки, приоритет удаления, гонки удаления и восстановления,
 * окно и простой 1С, обход страницами, общая УПД, возможные дубли, XML.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema.js';
import authPlugin from '../../src/plugins/auth.js';
import { integrationTokenRoutes } from '../../src/routes/integration-token.js';
import { integrationOnecRoutes } from '../../src/routes/integration-onec.js';
import { hashClientSecret } from '../../src/domain/auth/service-accounts.js';
import { signAccessToken } from '../../src/domain/auth/jwt.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const RUN = randomUUID().slice(0, 8);
const CLIENT_ID = `onec-${RUN}`;
const SECRET = `mcs_test_secret_${RUN}_0123456789abcdef0123456789`;
const READ_ONLY_CLIENT = `onec-ro-${RUN}`;
const READ_ONLY_SECRET = `mcs_ro_secret_${RUN}_0123456789abcdef0123456789`;

type QueueItem = { id: string; reason: string; detectedHash: string | null; exportedHash: string | null; lastError: string | null };

suite('выгрузка приёмок в 1С', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let enabled = true;
  let since: string | undefined;
  const objects = new Map<string, Buffer>();
  let s3Down = false;

  const siteId = randomUUID();
  const userId = randomUUID();
  const edoAccount = randomUUID();
  const supplierDir = randomUUID();
  const accountId = randomUUID();
  const roAccountId = randomUUID();
  let confirmedStatus = '';
  const createdDeliveries: string[] = [];
  const createdDocs: string[] = [];
  const createdExportDocs: string[] = [];
  const createdShipments: string[] = [];

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 6 });
    const db = drizzle(sql, { schema, casing: 'snake_case' });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    app.decorate('db', db as never);
    // Лимитер выдачи токена на Redis: без него он пропускает (fail-open).
    app.decorate('redis', {
      incr: async () => 1,
      expire: async () => 1,
      ttl: async () => 1,
    } as never);
    await app.register(authPlugin, { integrationEnabled: () => enabled });
    await app.register(integrationTokenRoutes, { enabled: () => enabled });
    await app.register(integrationOnecRoutes, {
      exportSince: () => since,
      windowDays: () => 30,
      readObject: async (key) => {
        if (s3Down) throw new Error('s3 down');
        const buf = objects.get(key);
        if (!buf) throw new Error('no such key');
        return buf;
      },
    });
    // Пользовательский маршрут — проверить, что machine-токен туда не пускают.
    app.get('/api/v1/sites', { preHandler: [app.authenticate] }, async () => ({ ok: true }));
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`OC${RUN.slice(0, 6)}`}, 'Объект 1С')`;
    await sql`INSERT INTO users (id, email, password_hash, role, full_name)
              VALUES (${userId}, ${`onec-${RUN}@t.local`}, 'x', 'manager', 'Менеджер 1С')`;
    await sql`INSERT INTO edo_accounts (id, name, credentials_encrypted, box_id)
              VALUES (${edoAccount}, ${`Диадок ${RUN}`}, '{}', ${`box-onec-${RUN}`})`;
    await sql`INSERT INTO suppliers (id, inn, name) VALUES (${supplierDir}, '5012093506', 'ПОСТАВЩИК 1С')`;
    await sql`INSERT INTO service_accounts (id, client_id, name, secret_hash, scopes)
              VALUES (${accountId}, ${CLIENT_ID}, '1С тест', ${hashClientSecret(SECRET)},
                      string_to_array('onec.deliveries:read,onec.deliveries:ack', ','))`;
    await sql`INSERT INTO service_accounts (id, client_id, name, secret_hash, scopes)
              VALUES (${roAccountId}, ${READ_ONLY_CLIENT}, '1С только чтение', ${hashClientSecret(READ_ONLY_SECRET)},
                      string_to_array('onec.deliveries:read', ','))`;
    const [st] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'confirmed_mol' LIMIT 1`;
    confirmedStatus = st!.id;
  });

  async function cleanExports() {
    await sql`DELETE FROM delivery_onec_exports`;
    await sql`DELETE FROM onec_detection_state`;
  }

  beforeEach(async () => {
    enabled = true;
    s3Down = false;
    // Начало очереди — момент теста: чужие подтверждённые приёмки базы не мешают.
    const [now] = await sql<{ t: string }[]>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`;
    since = now!.t;
    await cleanExports();
    await sql`UPDATE service_accounts SET is_active = true, revoked_at = NULL, allowed_cidrs = NULL,
              secret_generation = 1, secret_hash = ${hashClientSecret(SECRET)} WHERE id = ${accountId}`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    const list = (ids: string[]) => ids.join(',');
    await cleanExports();
    await sql`DELETE FROM auth_events WHERE meta->>'clientId' IN (${CLIENT_ID}, ${READ_ONLY_CLIENT})`;
    await sql`DELETE FROM service_accounts WHERE id IN (${accountId}, ${roAccountId})`;
    await sql`DELETE FROM delivery_edo_matches WHERE delivery_id::text = ANY(string_to_array(${list(createdDeliveries)}, ','))`;
    await sql`DELETE FROM delivery_items WHERE delivery_id::text = ANY(string_to_array(${list(createdDeliveries)}, ','))`;
    await sql`DELETE FROM delivery_sources WHERE delivery_id::text = ANY(string_to_array(${list(createdDeliveries)}, ','))`;
    await sql`DELETE FROM deliveries WHERE id::text = ANY(string_to_array(${list(createdDeliveries)}, ','))`;
    await sql`DELETE FROM entity_deletions WHERE entity_id::text = ANY(string_to_array(${list(createdDeliveries)}, ','))`;
    await sql`DELETE FROM shipments WHERE id::text = ANY(string_to_array(${list(createdShipments)}, ','))`;
    await sql`DELETE FROM edo_export_documents WHERE id::text = ANY(string_to_array(${list(createdExportDocs)}, ','))`;
    await sql`DELETE FROM source_documents WHERE id::text = ANY(string_to_array(${list(createdDocs)}, ','))`;
    await sql`DELETE FROM suppliers WHERE id = ${supplierDir}`;
    await sql`DELETE FROM edo_accounts WHERE id = ${edoAccount}`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  // ─────────────────────────── Сиды ───────────────────────────

  async function delivery(o: { transfer?: boolean; confirmedAt?: string } = {}): Promise<string> {
    const id = randomUUID();
    createdDeliveries.push(id);
    let shipmentId: string | null = null;
    if (o.transfer) {
      shipmentId = randomUUID();
      createdShipments.push(shipmentId);
      await sql`INSERT INTO shipments (id, kind, site_id, status_id)
        SELECT ${shipmentId}, 'contractor', ${siteId}, id FROM statuses WHERE entity_type = 'shipment' LIMIT 1`;
    }
    await sql`INSERT INTO deliveries (id, site_id, status_id, confirmed_by_mol_at, source_shipment_id, purpose)
      VALUES (${id}, ${siteId}, ${confirmedStatus},
              COALESCE(${o.confirmedAt ?? null}::timestamptz, clock_timestamp()), ${shipmentId}, 'own_forces')`;
    return id;
  }

  async function document(deliveryId: string, number = `УТ-${randomUUID().slice(0, 6)}`): Promise<string> {
    const id = randomUUID();
    createdDocs.push(id);
    await sql`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, doc_number, doc_date,
                                            supplier_inn_raw, supplier_directory_id, total_sum, vat_sum)
      VALUES (${id}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId}, ${number}, '2026-11-10',
              '5012093506', ${supplierDir}, 1200, 200)`;
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id) VALUES (${deliveryId}, ${id})`;
    return id;
  }

  async function line(deliveryId: string, docId: string | null, price = '100.0000', lineNo = 1) {
    await sql`INSERT INTO delivery_items (delivery_id, name_raw, line_no, qty_actual, unit, price, vat_rate, vat_sum, source_document_id)
      VALUES (${deliveryId}, ${`Материал ${lineNo}`}, ${lineNo}, 10, 'шт', ${price}, 20, 200, ${docId})`;
  }

  async function edo(deliveryId: string, sectionDocumentId: string | null, bytes: Buffer) {
    const docId = randomUUID();
    const matchId = randomUUID();
    createdExportDocs.push(docId);
    const key = `edo-export/5012093506/2026-11-10_${docId}.xml`;
    objects.set(key, bytes);
    await sql`INSERT INTO edo_export_documents
        (id, edo_account_id, message_id, entity_id, document_type, document_number, document_date,
         supplier_inn, supplier_name, total_sum, vat_sum, content_category, status, s3_key, content_sha256,
         size_bytes, received_at)
      VALUES (${docId}, ${edoAccount}, ${`m-${docId}`}, ${`e-${docId}`}, 'UniversalTransferDocument', '57/50126',
              '2026-11-10', '5012093506', 'ПОСТАВЩИК 1С', 1200, 200, 'goods', 'stored', ${key},
              ${'f'.repeat(64)}, ${bytes.length}, now())`;
    await sql`INSERT INTO delivery_edo_matches (id, delivery_id, export_document_id, section_document_id, linked_by_user_id)
      VALUES (${matchId}, ${deliveryId}, ${docId}, ${sectionDocumentId}, ${userId})`;
    return { matchId, docId, key };
  }

  async function confirmedWithDoc(price = '100.0000') {
    const id = await delivery();
    const doc = await document(id);
    await line(id, doc, price);
    return { id, doc };
  }

  // ─────────────────────────── HTTP ───────────────────────────

  async function tokenFor(clientId = CLIENT_ID, secret = SECRET, ip?: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/public/integration/token',
      headers: ip ? { 'x-real-ip': ip } : {},
      payload: { grant_type: 'client_credentials', client_id: clientId, client_secret: secret },
    });
  }
  async function token(): Promise<string> {
    const res = await tokenFor();
    expect(res.statusCode).toBe(200);
    return res.json().access_token as string;
  }
  const get = (url: string, tok: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tok}`, ...headers } });
  async function queue(tok: string, qs = ''): Promise<{ items: QueueItem[]; nextCursor: string | null; truncated: boolean }> {
    const res = await get(`/api/v1/integration/1c/deliveries/queue${qs}`, tok);
    expect(res.statusCode).toBe(200);
    return res.json();
  }
  const reasonOf = (q: { items: QueueItem[] }, id: string) => q.items.find((i) => i.id === id)?.reason ?? null;
  async function one(tok: string, id: string) {
    const res = await get(`/api/v1/integration/1c/deliveries/${id}`, tok);
    return res.json();
  }
  async function ackItems(tok: string, items: unknown[]) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/integration/1c/deliveries/ack',
      headers: { authorization: `Bearer ${tok}` },
      payload: { items },
    });
    return res;
  }
  async function ackCurrent(tok: string, id: string) {
    const d = await one(tok, id);
    const res = await ackItems(tok, [{ id, contentHash: d.contentHash, hashVersion: d.hashVersion }]);
    expect(res.json().results[0].result).toBe('ok');
    return d.contentHash as string;
  }

  // ─────────────────────────── Авторизация ───────────────────────────

  describe('авторизация', () => {
    it('секрет → токен; неверный секрет и неизвестный client — одна ошибка, аудит пишется', async () => {
      const ok = await tokenFor();
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ token_type: 'Bearer', expires_in: 600 });
      expect(ok.json().scope.split(' ').sort()).toEqual(['onec.deliveries:ack', 'onec.deliveries:read']);

      const bad = await tokenFor(CLIENT_ID, 'неверный');
      const unknown = await tokenFor('nobody-here', SECRET);
      expect(bad.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      expect(bad.json()).toEqual(unknown.json());

      const events = await sql<{ event: string }[]>`
        SELECT event FROM auth_events WHERE meta->>'clientId' = ${CLIENT_ID} ORDER BY id`;
      expect(events.map((e) => e.event)).toEqual(
        expect.arrayContaining(['machine_token_issued', 'machine_token_denied']),
      );
    });

    it('рубильник закрывает и выдачу токена, и все маршруты канала', async () => {
      const tok = await token();
      enabled = false;
      expect((await tokenFor()).statusCode).toBe(503);
      expect((await get('/api/v1/integration/1c/deliveries/queue', tok)).statusCode).toBe(503);
      expect((await get(`/api/v1/integration/1c/deliveries/${randomUUID()}`, tok)).statusCode).toBe(503);
      expect((await ackItems(tok, [{ id: randomUUID(), deleted: true }])).statusCode).toBe(503);
    });

    it('отзыв учётки действует на уже выданный токен сразу', async () => {
      const tok = await token();
      expect((await get('/api/v1/integration/1c/deliveries/queue', tok)).statusCode).toBe(200);
      await sql`UPDATE service_accounts SET is_active = false WHERE id = ${accountId}`;
      expect((await get('/api/v1/integration/1c/deliveries/queue', tok)).statusCode).toBe(401);
      expect((await tokenFor()).statusCode).toBe(401);
    });

    it('ротация по поколению: новый токен в ту же секунду проходит, старый — нет', async () => {
      const old = await token();
      const newSecret = `${SECRET}-rotated`;
      await sql`UPDATE service_accounts SET secret_generation = 2, secret_hash = ${hashClientSecret(newSecret)}
                WHERE id = ${accountId}`;
      const fresh = await tokenFor(CLIENT_ID, newSecret);
      expect(fresh.statusCode).toBe(200);
      expect((await get('/api/v1/integration/1c/deliveries/queue', fresh.json().access_token)).statusCode).toBe(200);
      expect((await get('/api/v1/integration/1c/deliveries/queue', old)).statusCode).toBe(401);
      expect((await tokenFor(CLIENT_ID, SECRET)).statusCode).toBe(401);
    });

    it('сети учётки: и при выдаче, и на каждом запросе (по X-Real-IP, не XFF)', async () => {
      await sql`UPDATE service_accounts SET allowed_cidrs = string_to_array('10.0.0.0/8', ',') WHERE id = ${accountId}`;
      expect((await tokenFor(CLIENT_ID, SECRET, '192.168.1.1')).statusCode).toBe(401);
      const res = await tokenFor(CLIENT_ID, SECRET, '10.1.2.3');
      expect(res.statusCode).toBe(200);
      const tok = res.json().access_token;
      expect((await get('/api/v1/integration/1c/deliveries/queue', tok, { 'x-real-ip': '10.1.2.3' })).statusCode).toBe(200);
      expect((await get('/api/v1/integration/1c/deliveries/queue', tok, { 'x-real-ip': '192.168.1.1' })).statusCode).toBe(401);
      expect(
        (
          await get('/api/v1/integration/1c/deliveries/queue', tok, {
            'x-real-ip': '192.168.1.1',
            'x-forwarded-for': '10.1.2.3',
          })
        ).statusCode,
      ).toBe(401);
    });

    it('изоляция: пользовательский JWT в канал не пускают, machine-токен — в портал', async () => {
      const userJwt = await signAccessToken({ sub: userId, role: 'admin', sid: randomUUID(), aal: 'aal1' });
      expect((await get('/api/v1/integration/1c/deliveries/queue', userJwt)).statusCode).toBe(401);
      const tok = await token();
      expect((await get('/api/v1/sites', tok)).statusCode).toBe(401);
    });

    it('токен только из заголовка: cookie в канале не читается', async () => {
      const tok = await token();
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/integration/1c/deliveries/queue',
        cookies: { mc_access: tok, access_token: tok },
      });
      expect(res.statusCode).toBe(401);
    });

    it('scope: учётка только на чтение не подтверждает', async () => {
      const res = await tokenFor(READ_ONLY_CLIENT, READ_ONLY_SECRET);
      const tok = res.json().access_token;
      expect((await get('/api/v1/integration/1c/deliveries/queue', tok)).statusCode).toBe(200);
      const ackRes = await ackItems(tok, [{ id: randomUUID(), deleted: true }]);
      expect(ackRes.statusCode).toBe(403);
      expect(ackRes.json()).toMatchObject({ error: 'insufficient_scope' });
    });
  });

  // ─────────────────────────── Очередь и данные ───────────────────────────

  describe('очередь и данные', () => {
    it('new: подтверждённая — да; перемещение, корзина и подтверждённая до начала — нет', async () => {
      const tok = await token();
      const { id } = await confirmedWithDoc();
      const transfer = await delivery({ transfer: true });
      const early = await delivery({ confirmedAt: '2020-01-01T00:00:00Z' });
      const trashed = await delivery();
      await sql`UPDATE deliveries SET pending_deletion_at = now(), pending_deletion_by_user_id = ${userId} WHERE id = ${trashed}`;
      const q = await queue(tok);
      expect(reasonOf(q, id)).toBe('new');
      expect(reasonOf(q, transfer)).toBeNull();
      expect(reasonOf(q, early)).toBeNull();
      expect(reasonOf(q, trashed)).toBeNull();
      // Перемещение доступно по номеру, с пометкой.
      expect((await one(tok, transfer)).operation).toBe('transfer');
    });

    it('без даты начала очередь не отдаётся, а не выдаёт всю историю', async () => {
      const tok = await token();
      since = undefined;
      const res = await get('/api/v1/integration/1c/deliveries/queue', tok);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: 'not_configured' });
      since = 'не дата';
      expect((await get('/api/v1/integration/1c/deliveries/queue', tok)).statusCode).toBe(503);
    });

    it('данные: группа документа, суммы, номер; по номеру приёмки — то же', async () => {
      const tok = await token();
      const { id, doc } = await confirmedWithDoc('123.4567');
      const d = await one(tok, id);
      expect(d.groups).toHaveLength(1);
      expect(d.groups[0]).toMatchObject({
        groupKey: `doc:${doc}`,
        document: { linked: true, dedupKey: { supplierInn: '5012093506', date: '2026-11-10' } },
        totals: { linesTotal: 1, sumExVat: '1234.57', vatSum: '200.00', sumWithVat: '1434.57', complete: true },
      });
      expect(d.groups[0].lines[0]).toMatchObject({ qty: '10.0000', price: '123.4567', priceWithVat: '148.1480' });
      expect(d.export.state).toBe('not_exported');
      const byNumber = await get(`/api/v1/integration/1c/deliveries/by-number/${d.displayId}`, tok);
      expect(byNumber.json().contentHash).toBe(d.contentHash);
    });

    it('подтверждение снимает с очереди; правка цены → changed с хешем, равным contentHash пачки', async () => {
      const tok = await token();
      const { id } = await confirmedWithDoc();
      const h1 = await ackCurrent(tok, id);
      expect(reasonOf(await queue(tok), id)).toBeNull();
      expect((await one(tok, id)).export.state).toBe('exported');

      await sql`UPDATE delivery_items SET price = 150 WHERE delivery_id = ${id}`;
      const q = await queue(tok);
      const it2 = q.items.find((i) => i.id === id)!;
      expect(it2.reason).toBe('changed');
      expect(it2.exportedHash).toBe(h1);
      const batch = await get(`/api/v1/integration/1c/deliveries?ids=${id}`, tok);
      expect(batch.json().items[0].contentHash).toBe(it2.detectedHash);
      expect(batch.json().items[0].export.state).toBe('changed');

      await ackCurrent(tok, id);
      expect(reasonOf(await queue(tok), id)).toBeNull();
    });

    it('отвязка УПД из ЭДО (следа во времени нет) → changed', async () => {
      const tok = await token();
      const { id, doc } = await confirmedWithDoc();
      const { matchId } = await edo(id, doc, Buffer.from('<?xml version="1.0"?><Файл/>'));
      await ackCurrent(tok, id);
      // Время — текстом: drizzle подменяет разбор дат у общего клиента postgres.js.
      const before = await sql<{ updated_at: string }[]>`SELECT updated_at::text FROM deliveries WHERE id = ${id}`;
      await sql`DELETE FROM delivery_edo_matches WHERE id = ${matchId}`;
      const after = await sql<{ updated_at: string }[]>`SELECT updated_at::text FROM deliveries WHERE id = ${id}`;
      expect(after[0]!.updated_at).toBe(before[0]!.updated_at);
      expect(reasonOf(await queue(tok), id)).toBe('changed');
    });

    it('повтор подтверждения не сдвигает окно', async () => {
      const tok = await token();
      const { id } = await confirmedWithDoc();
      const h = await ackCurrent(tok, id);
      await sql`UPDATE delivery_onec_exports SET exported_at = exported_at - interval '3 days' WHERE delivery_id = ${id}`;
      const [before] = await sql<{ exported_at: string; ack_count: number }[]>`
        SELECT exported_at::text, ack_count FROM delivery_onec_exports WHERE delivery_id = ${id}`;
      await ackItems(tok, [{ id, contentHash: h, hashVersion: 1 }]);
      const [after] = await sql<{ exported_at: string; ack_count: number }[]>`
        SELECT exported_at::text, ack_count FROM delivery_onec_exports WHERE delivery_id = ${id}`;
      expect(after!.exported_at).toBe(before!.exported_at);
      expect(after!.ack_count).toBe(before!.ack_count + 1);
    });

    it('откат правки: проход успел — подтверждение H снимает пометку', async () => {
      const tok = await token();
      const { id } = await confirmedWithDoc();
      const h = await ackCurrent(tok, id);
      await sql`UPDATE delivery_items SET price = 150 WHERE delivery_id = ${id}`;
      expect(reasonOf(await queue(tok), id)).toBe('changed');
      await sql`UPDATE delivery_items SET price = 100 WHERE delivery_id = ${id}`;
      const q = await queue(tok);
      const item = q.items.find((i) => i.id === id)!;
      // Пометка остаётся (одна лишняя пересылка), но найденный хеш — снова H.
      expect(item.reason).toBe('changed');
      expect(item.detectedHash).toBe(h);
      expect(await ackCurrent(tok, id)).toBe(h);
      expect(reasonOf(await queue(tok), id)).toBeNull();
    });

    it('откат между проходом и выборкой — сходится в следующем цикле; старое H при C не снимает', async () => {
      const tok = await token();
      const { id } = await confirmedWithDoc();
      const h = await ackCurrent(tok, id);
      await sql`UPDATE delivery_items SET price = 150 WHERE delivery_id = ${id}`;
      expect(reasonOf(await queue(tok), id)).toBe('changed');
      // Старое подтверждение H, пока содержимое C: пометка остаётся.
      await ackItems(tok, [{ id, contentHash: h, hashVersion: 1 }]);
      expect(reasonOf(await queue(tok), id)).toBe('changed');
      // Откат без прохода, 1С загрузила H и подтвердила — это повтор.
      await sql`UPDATE delivery_items SET price = 100 WHERE delivery_id = ${id}`;
      await ackItems(tok, [{ id, contentHash: h, hashVersion: 1 }]);
      const q = await queue(tok);
      expect(reasonOf(q, id)).toBe('changed');
      expect(q.items.find((i) => i.id === id)!.detectedHash).toBe(h);
      await ackItems(tok, [{ id, contentHash: h, hashVersion: 1 }]);
      expect(reasonOf(await queue(tok), id)).toBeNull();
    });

    it('ошибка первой загрузки: остаётся new с текстом ошибки; успех снимает', async () => {
      const tok = await token();
      const { id } = await confirmedWithDoc();
      const res = await ackItems(tok, [{ id, failed: { message: 'нет номенклатуры' } }]);
      expect(res.json().results[0].result).toBe('ok');
      const q = await queue(tok);
      expect(q.items.find((i) => i.id === id)).toMatchObject({ reason: 'new', lastError: 'нет номенклатуры' });
      await ackCurrent(tok, id);
      expect(reasonOf(await queue(tok), id)).toBeNull();
    });

    it('изменение + удаление → deleted (приоритет); подтверждение удаления → восстановили → restored', async () => {
      const tok = await token();
      const { id } = await confirmedWithDoc();
      await ackCurrent(tok, id);
      await sql`UPDATE delivery_items SET price = 150 WHERE delivery_id = ${id}`;
      expect(reasonOf(await queue(tok), id)).toBe('changed');
      await sql`UPDATE deliveries SET pending_deletion_at = now(), pending_deletion_by_user_id = ${userId} WHERE id = ${id}`;
      expect(reasonOf(await queue(tok), id)).toBe('deleted');
      await ackItems(tok, [{ id, deleted: true }]);
      expect(reasonOf(await queue(tok), id)).toBeNull();
      await sql`UPDATE deliveries SET pending_deletion_at = NULL, pending_deletion_by_user_id = NULL WHERE id = ${id}`;
      expect(reasonOf(await queue(tok), id)).toBe('restored');
      await ackCurrent(tok, id);
      expect(reasonOf(await queue(tok), id)).toBeNull();
    });

    it('гонка: 1С применила удаление, а приёмку уже восстановили — подтверждение принято, будет restored', async () => {
      const tok = await token();
      const { id } = await confirmedWithDoc();
      await ackCurrent(tok, id);
      await sql`UPDATE deliveries SET pending_deletion_at = now(), pending_deletion_by_user_id = ${userId} WHERE id = ${id}`;
      expect(reasonOf(await queue(tok), id)).toBe('deleted');
      await sql`UPDATE deliveries SET pending_deletion_at = NULL, pending_deletion_by_user_id = NULL WHERE id = ${id}`;
      const res = await ackItems(tok, [{ id, deleted: true }]);
      expect(res.json().results[0].result).toBe('ok');
      expect(reasonOf(await queue(tok), id)).toBe('restored');
    });

    it('восстановили до того, как 1С увидела удаление → перепроверка, подтверждение H снимает', async () => {
      const tok = await token();
      const { id } = await confirmedWithDoc();
      const h = await ackCurrent(tok, id);
      await sql`UPDATE deliveries SET pending_deletion_at = now(), pending_deletion_by_user_id = ${userId} WHERE id = ${id}`;
      expect(reasonOf(await queue(tok), id)).toBe('deleted');
      await sql`UPDATE deliveries SET pending_deletion_at = NULL, pending_deletion_by_user_id = NULL WHERE id = ${id}`;
      const q = await queue(tok);
      expect(q.items.find((i) => i.id === id)).toMatchObject({ reason: 'changed', detectedHash: h });
      await ackItems(tok, [{ id, contentHash: h, hashVersion: 1 }]);
      expect(reasonOf(await queue(tok), id)).toBeNull();
    });

    it('снова удалили до подтверждения restored — причина снята', async () => {
      const tok = await token();
      const { id } = await confirmedWithDoc();
      await ackCurrent(tok, id);
      await ackItems(tok, [{ id, deleted: true }]);
      expect(reasonOf(await queue(tok), id)).toBe('restored');
      await sql`UPDATE deliveries SET pending_deletion_at = now(), pending_deletion_by_user_id = ${userId} WHERE id = ${id}`;
      expect(reasonOf(await queue(tok), id)).toBeNull();
    });

    it('жёсткое удаление → deleted; в пачке — missing deleted', async () => {
      const tok = await token();
      const { id } = await confirmedWithDoc();
      await ackCurrent(tok, id);
      await sql`DELETE FROM delivery_items WHERE delivery_id = ${id}`;
      await sql`DELETE FROM delivery_sources WHERE delivery_id = ${id}`;
      await sql`DELETE FROM deliveries WHERE id = ${id}`;
      await sql`INSERT INTO entity_deletions (entity_type, entity_id, site_id) VALUES ('delivery', ${id}, ${siteId})`;
      expect(reasonOf(await queue(tok), id)).toBe('deleted');
      const batch = await get(`/api/v1/integration/1c/deliveries?ids=${id},${randomUUID()}`, tok);
      expect(batch.json().missing.map((m: { state: string }) => m.state).sort()).toEqual(['deleted', 'not_found']);
      expect((await ackItems(tok, [{ id, deleted: true }])).json().results[0].result).toBe('ok');
      expect(reasonOf(await queue(tok), id)).toBeNull();
    });

    it('окно: изменение вне окна не ищется; найденное в окне держится после окна', async () => {
      const tok = await token();
      const outside = await confirmedWithDoc();
      const found = await confirmedWithDoc();
      await ackCurrent(tok, outside.id);
      await ackCurrent(tok, found.id);
      await queue(tok); // проход: last_pass = сейчас
      // Найденное в окне…
      await sql`UPDATE delivery_items SET price = 150 WHERE delivery_id = ${found.id}`;
      expect(reasonOf(await queue(tok), found.id)).toBe('changed');
      // …а потом оба выгружены «40 дней назад».
      await sql`UPDATE delivery_onec_exports SET exported_at = now() - interval '40 days'
                WHERE delivery_id IN (${outside.id}, ${found.id})`;
      await sql`UPDATE delivery_items SET price = 150 WHERE delivery_id = ${outside.id}`;
      const q = await queue(tok);
      expect(reasonOf(q, outside.id)).toBeNull();
      expect(reasonOf(q, found.id)).toBe('changed');
    });

    it('простой 1С: окно закрылось во время простоя — изменение всё равно найдено', async () => {
      const tok = await token();
      const { id } = await confirmedWithDoc();
      await ackCurrent(tok, id);
      await sql`UPDATE delivery_onec_exports SET exported_at = now() - interval '35 days' WHERE delivery_id = ${id}`;
      await sql`INSERT INTO onec_detection_state (id, last_pass_started_at) VALUES (1, now() - interval '40 days')
                ON CONFLICT (id) DO UPDATE SET last_pass_started_at = now() - interval '40 days'`;
      await sql`UPDATE delivery_items SET price = 150 WHERE delivery_id = ${id}`;
      expect(reasonOf(await queue(tok), id)).toBe('changed');
    });

    it('обход страницами: без изменений — каждый ровно один раз; битый курсор — 400', async () => {
      const tok = await token();
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push((await confirmedWithDoc()).id);
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const q = await queue(tok, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        seen.push(...q.items.map((i) => i.id));
        cursor = q.nextCursor;
        pages += 1;
      } while (cursor && pages < 20);
      const mine = seen.filter((id) => ids.includes(id));
      expect(mine.sort()).toEqual([...ids].sort());
      expect(new Set(seen).size).toBe(seen.length);
      expect((await get('/api/v1/integration/1c/deliveries/queue?cursor=мусор', tok)).statusCode).toBe(400);
    });

    it('смена причины между страницами: пропущенное приходит в следующем цикле с начала', async () => {
      const tok = await token();
      const a = await confirmedWithDoc();
      const b = await confirmedWithDoc();
      await ackCurrent(tok, a.id);
      // Первая страница — только b (new); a подтверждена.
      const first = await queue(tok, '?limit=500');
      expect(reasonOf(first, b.id)).toBe('new');
      expect(reasonOf(first, a.id)).toBeNull();
      // Между страницами a изменили: страницы без прохода её не увидят…
      await sql`UPDATE delivery_items SET price = 150 WHERE delivery_id = ${a.id}`;
      if (first.nextCursor) {
        const next = await queue(tok, `?cursor=${first.nextCursor}`);
        expect(reasonOf(next, a.id)).toBeNull();
      }
      // …а новый цикл с начала — увидит.
      expect(reasonOf(await queue(tok), a.id)).toBe('changed');
    });

    it('общая УПД в двух приёмках: соседи видны, правка одной — changed только ей', async () => {
      const tok = await token();
      const a = await confirmedWithDoc();
      const b = await delivery();
      await sql`INSERT INTO delivery_sources (delivery_id, source_document_id) VALUES (${b}, ${a.doc})`;
      await line(b, a.doc);
      const da = await one(tok, a.id);
      const db = await one(tok, b);
      expect(da.groups[0].groupKey).toBe(db.groups[0].groupKey);
      expect(da.groups[0].document.sharedWith.map((s: { id: string }) => s.id)).toEqual([b]);
      await ackCurrent(tok, a.id);
      await ackCurrent(tok, b);
      await sql`UPDATE delivery_items SET price = 150 WHERE delivery_id = ${b}`;
      const q = await queue(tok);
      expect(reasonOf(q, b)).toBe('changed');
      expect(reasonOf(q, a.id)).toBeNull();
    });

    it('возможные дубли: две карточки с тем же ключом поставщик+номер+дата', async () => {
      const tok = await token();
      const a = await delivery();
      const docA = await document(a, 'УТ-ДУБЛЬ');
      const b = await delivery();
      const docB = await document(b, 'УТ-ДУБЛЬ');
      const d = await one(tok, a);
      expect(d.groups[0].document.portalDuplicates).toEqual([docB]);
      expect(docA).not.toBe(docB);
    });

    it('подтверждение: неизвестный id, битый хеш, неизвестная версия — по элементу, остальные проходят', async () => {
      const tok = await token();
      const { id } = await confirmedWithDoc();
      const d = await one(tok, id);
      const res = await ackItems(tok, [
        { id: randomUUID(), deleted: true },
        { id, contentHash: 'xyz', hashVersion: 1 },
        { id, contentHash: d.contentHash, hashVersion: 99 },
        { id, contentHash: d.contentHash, hashVersion: 1 },
      ]);
      expect(res.statusCode).toBe(200);
      expect(res.json().results.map((r: { result: string }) => r.result)).toEqual([
        'unknown_delivery',
        'invalid_hash',
        'unsupported_hash_version',
        'ok',
      ]);
    });
  });

  // ─────────────────────────── XML ───────────────────────────

  describe('XML УПД из ЭДО', () => {
    const cp1251 = Buffer.concat([
      Buffer.from('<?xml version="1.0" encoding="windows-1251"?><Файл ИдФайл="'),
      Buffer.from([0xd3, 0xcf, 0xc4]), // «УПД» в cp1251
      Buffer.from('"/>'),
    ]);

    it('байты как есть, кодировка в заголовке, sha256; путь из данных приёмки', async () => {
      const tok = await token();
      const { id, doc } = await confirmedWithDoc();
      await edo(id, doc, cp1251);
      const d = await one(tok, id);
      const path = d.groups[0].document.edo[0].xmlPath as string;
      const res = await get(path, tok);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/xml; charset=windows-1251');
      expect(res.rawPayload.equals(cp1251)).toBe(true);
      expect(res.headers['x-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
    });

    it('чужая привязка — 404; сбой хранилища — 503 с Retry-After; размер больше предела — 413', async () => {
      const tok = await token();
      const { id, doc } = await confirmedWithDoc();
      const other = await delivery();
      const { matchId, docId } = await edo(id, doc, cp1251);
      expect((await get(`/api/v1/integration/1c/deliveries/${other}/edo/${matchId}/xml`, tok)).statusCode).toBe(404);
      s3Down = true;
      const down = await get(`/api/v1/integration/1c/deliveries/${id}/edo/${matchId}/xml`, tok);
      expect(down.statusCode).toBe(503);
      expect(down.headers['retry-after']).toBe('30');
      s3Down = false;
      await sql`UPDATE edo_export_documents SET size_bytes = 999999999 WHERE id = ${docId}`;
      expect((await get(`/api/v1/integration/1c/deliveries/${id}/edo/${matchId}/xml`, tok)).statusCode).toBe(413);
    });
  });
});
