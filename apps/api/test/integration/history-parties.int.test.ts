/**
 * Стороны документа в историях операций (primarySourceDocument).
 *
 * Истории приёмок и отгрузок читают НЕ полный DTO документа, а сокращённый
 * PrimarySourceDocumentSchema, который собирается отдельными запросами в
 * routes/deliveries.ts и routes/shipments.ts. Из-за этого «стороны уже есть в
 * DTO документа» здесь ничего не значит — их нужно добавлять отдельно, и так же
 * отдельно проверять.
 *
 * Главное, что ловится: грузополучатель БЕЗ ИНН. Графу 4 печатают без ИНН
 * (consignee_id на проде пуст у всех документов), поэтому голый JOIN отдал бы
 * пустую колонку при заполненной базе — имя обязано доезжать через
 * COALESCE(consignee_name_raw, counterparties.name).
 *
 * Запуск: см. заголовок test/integration/upload-documents-characterization.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../../src/plugins/auth.js';

vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  putObject: vi.fn(),
  presign: vi.fn(),
  getObject: vi.fn(),
  deleteObject: vi.fn(),
}));

const { deliveryRoutes } = await import('../../src/routes/deliveries.js');
const { shipmentRoutes } = await import('../../src/routes/shipments.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('стороны документа в историях операций (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;

  const siteId = randomUUID();
  const managerId = randomUUID();
  const docId = randomUUID();
  const deliveryId = randomUUID();
  const shipmentId = randomUUID();
  const buyerCpId = randomUUID();
  // ИНН уникален в таблице, а базу делят все интеграционные наборы.
  const buyerInn = `78${String(Date.now()).slice(-8)}`;
  // ИНН грузополучателя есть только в самом документе: FK у стороны нет.
  const consigneeRawInn = `79${String(Date.now()).slice(-8)}`;

  let manager: AuthUser;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql) as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = manager;
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

    manager = { id: managerId, role: 'manager', siteId: null } as unknown as AuthUser;

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`HIP${Date.now() % 10000}`}, 'Стороны в истории')`;
    // Покупатель нормализован (есть ИНН), грузополучатель — только текстом.
    await sql`INSERT INTO counterparties (id, inn, name, is_customer)
              VALUES (${buyerCpId}, ${buyerInn}, 'ООО «СУ-10»', true)`;
    // consignee_inn_raw при пустом FK — ровно то, ради чего заведены raw-поля:
    // ИНН из документа, который связать со справочником не с чем.
    await sql`INSERT INTO source_documents
      (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum,
       buyer_id, consignee_name_raw, consignee_inn_raw)
      VALUES (${docId}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId}, 'H-1',
              '2026-07-10', 1000.00, ${buyerCpId}, 'ООО «АЛЬЯНС»', ${consigneeRawInn})`;

    await sql`INSERT INTO deliveries (id, site_id, status_id)
      VALUES (${deliveryId}, ${siteId},
              (SELECT id FROM statuses WHERE entity_type='delivery' AND code='not_filled'))`;
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id)
      VALUES (${deliveryId}, ${docId})`;

    // kind NOT NULL без дефолта; 'contractor' — обычная отгрузка подрядчику
    // (enum shipment_kind: contractor | return | transfer | writeoff).
    await sql`INSERT INTO shipments (id, site_id, kind, status_id)
      VALUES (${shipmentId}, ${siteId}, 'contractor',
              (SELECT id FROM statuses WHERE entity_type='shipment' AND code='not_filled'))`;
    await sql`INSERT INTO shipment_sources (shipment_id, source_document_id)
      VALUES (${shipmentId}, ${docId})`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM delivery_sources WHERE delivery_id = ${deliveryId}`;
    await sql`DELETE FROM shipment_sources WHERE shipment_id = ${shipmentId}`;
    await sql`DELETE FROM deliveries WHERE id = ${deliveryId}`;
    await sql`DELETE FROM shipments WHERE id = ${shipmentId}`;
    await sql`DELETE FROM source_documents WHERE id = ${docId}`;
    await sql`DELETE FROM counterparties WHERE id = ${buyerCpId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  async function primaryOf(url: string, id: string): Promise<Record<string, unknown>> {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Record<string, unknown>[] };
    const row = body.items.find((i) => i.id === id);
    expect(row, `операция ${id} не найдена в ${url}`).toBeTruthy();
    return row!.primarySourceDocument as Record<string, unknown>;
  }

  it('история приёмок: покупатель из справочника, грузополучатель без ИНН — из raw', async () => {
    const primary = await primaryOf(`/api/v1/deliveries?siteId=${siteId}&limit=100`, deliveryId);
    expect(primary.buyerName).toBe('ООО «СУ-10»');
    // Ключевой случай: FK пуст, имя обязано прийти из consignee_name_raw.
    expect(primary.consigneeName).toBe('ООО «АЛЬЯНС»');
  });

  it('история отгрузок отдаёт те же стороны — оба builder-а обязаны совпадать', async () => {
    const primary = await primaryOf(`/api/v1/shipments?siteId=${siteId}&limit=100`, shipmentId);
    expect(primary.buyerName).toBe('ООО «СУ-10»');
    expect(primary.consigneeName).toBe('ООО «АЛЬЯНС»');
  });

  it.each([
    ['приёмок', () => `/api/v1/deliveries?siteId=${siteId}&limit=100`, () => deliveryId],
    ['отгрузок', () => `/api/v1/shipments?siteId=${siteId}&limit=100`, () => shipmentId],
  ])('история %s: ИНН сторон — из справочника и из документа', async (_label, url, id) => {
    const primary = await primaryOf(url(), id());
    // Покупатель нормализован — ИНН приходит по FK.
    expect(primary.buyerInn).toBe(buyerInn);
    // Грузополучатель без FK: единственный источник — consignee_inn_raw. Голый
    // JOIN отдал бы здесь null при заполненной базе.
    expect(primary.consigneeInn).toBe(consigneeRawInn);
    // Поставщика у документа нет вовсе — поле обязано быть null, а не '' и не
    // отсутствовать: PrimarySourceDocumentSchema требует все три ключа.
    expect(primary.supplierInn).toBeNull();
  });
});
