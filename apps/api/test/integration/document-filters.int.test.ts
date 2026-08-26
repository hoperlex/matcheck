/**
 * Фильтры списка документов и их совпадение с выгрузкой Excel.
 *
 * Три вещи, которые ломались молча и потому проверяются на живой базе:
 *
 * 1. Поставщик у современных УПД лежит в `supplier_directory_id` (справочник
 *    заказчика), а у исторических — в `supplier_id` (операционный контрагент).
 *    Фильтр обязан находить оба, получив на вход id справочника: именно его
 *    показывает выпадающий список.
 * 2. Список и выгрузка строятся ОДНИМ набором условий. Раньше выгрузка не
 *    убирала технические записи и не знала про `kind` — файл приходил шире
 *    экрана.
 * 3. Кривой id из ссылки не должен ронять запрос: `?siteIds=abc` уходил в
 *    `IN ('abc')` и валился ошибкой Postgres.
 *
 * Запуск: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test
 * Без переменной набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as schema from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

vi.mock('../../src/instrument.js', () => ({}));
vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  presign: vi.fn(),
  getObject: vi.fn(),
  deleteObject: vi.fn(),
}));

const { sourceDocumentRoutes } = await import('../../src/routes/source-documents.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('фильтры документов (реальный PostgreSQL)', { timeout: 60_000 }, () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;

  const siteId = randomUUID();
  // Один ИНН на три записи: справочник поставщиков, операционный контрагент
  // (исторический путь) и — отдельным ИНН — подрядчик.
  const supplierInn = `77${String(Date.now()).slice(-8)}`;
  const contractorInn = `78${String(Date.now()).slice(-8)}`;
  const supplierDirId = randomUUID();
  const supplierOpId = randomUUID();
  const contractorDirId = randomUUID();
  const contractorOpId = randomUUID();

  const docDirectory = randomUUID(); // поставщик через справочник
  const docLegacy = randomUUID(); // поставщик через counterparties
  const docOther = randomUUID(); // без поставщика, с подрядчиком
  const docTechnical = randomUUID(); // техническая запись пакета

  const manager = { id: randomUUID(), role: 'manager', siteId: null } as unknown as AuthUser;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    app.decorate('db', drizzle(sql, { schema, casing: 'snake_case' }) as never);
    app.decorate('queues', { updParse: { add: vi.fn() } } as never);
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
    await app.register(sourceDocumentRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`FLT${Date.now() % 10000}`}, 'Фильтры документов')`;
    await sql`INSERT INTO suppliers (id, inn, name) VALUES (${supplierDirId}, ${supplierInn}, 'ООО «Поставщик справочника»')`;
    await sql`INSERT INTO counterparties (id, inn, name, is_supplier)
              VALUES (${supplierOpId}, ${supplierInn}, 'ООО «Поставщик операционный»', true)`;
    await sql`INSERT INTO customer_counterparties (id, inn, name)
              VALUES (${contractorDirId}, ${contractorInn}, 'ООО «Подрядчик справочника»')`;
    await sql`INSERT INTO counterparties (id, inn, name, is_contractor)
              VALUES (${contractorOpId}, ${contractorInn}, 'ООО «Подрядчик операционный»', true)`;

    const insertDoc = async (
      id: string,
      extra: { supplierDir?: string; supplierOp?: string; contractor?: string; technical?: boolean },
    ) => {
      await sql`INSERT INTO source_documents
                  (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum,
                   supplier_directory_id, supplier_id, contractor_id, is_technical)
                VALUES (${id}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId},
                        ${`FLT-${id.slice(0, 8)}`}, '2026-08-01', 100.00,
                        ${extra.supplierDir ?? null}, ${extra.supplierOp ?? null},
                        ${extra.contractor ?? null}, ${extra.technical ?? false})`;
    };
    await insertDoc(docDirectory, { supplierDir: supplierDirId });
    await insertDoc(docLegacy, { supplierOp: supplierOpId });
    await insertDoc(docOther, { contractor: contractorOpId });
    await insertDoc(docTechnical, { supplierDir: supplierDirId, technical: true });
  });

  afterAll(async () => {
    if (!sql) return;
    await app.close();
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM counterparties WHERE id IN (${supplierOpId}, ${contractorOpId})`;
    await sql`DELETE FROM customer_counterparties WHERE id = ${contractorDirId}`;
    await sql`DELETE FROM suppliers WHERE id = ${supplierDirId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  const listIds = async (query: string): Promise<string[]> => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/source-documents?${query}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string }> };
    return body.items.map((i) => i.id);
  };

  it('id справочника поставщика находит и современный, и исторический документ', async () => {
    const ids = await listIds(`direction=inbound&siteIds=${siteId}&supplierIds=${supplierDirId}`);

    expect(ids).toContain(docDirectory);
    expect(ids).toContain(docLegacy);
    expect(ids).not.toContain(docOther);
  });

  it('техническая запись пакета не попадает в выдачу', async () => {
    const ids = await listIds(`direction=inbound&siteIds=${siteId}`);

    expect(ids).not.toContain(docTechnical);
    expect(ids).toContain(docDirectory);
  });

  it('id справочника подрядчика разворачивается в операционного по ИНН', async () => {
    const ids = await listIds(
      `direction=inbound&siteIds=${siteId}&contractorIds=${contractorDirId}`,
    );

    expect(ids).toEqual([docOther]);
  });

  it('подрядчик без пары по ИНН даёт пустую выдачу, а не весь список', async () => {
    const orphan = randomUUID();
    await sql`INSERT INTO customer_counterparties (id, inn, name)
              VALUES (${orphan}, ${`79${String(Date.now()).slice(-8)}`}, 'ООО «Без пары»')`;
    try {
      const ids = await listIds(`direction=inbound&siteIds=${siteId}&contractorIds=${orphan}`);
      expect(ids).toEqual([]);
    } finally {
      await sql`DELETE FROM customer_counterparties WHERE id = ${orphan}`;
    }
  });

  it('фильтры комбинируются через И', async () => {
    const ids = await listIds(
      `direction=inbound&siteIds=${siteId}&supplierIds=${supplierDirId}&q=${encodeURIComponent(`FLT-${docDirectory.slice(0, 8)}`)}`,
    );

    expect(ids).toEqual([docDirectory]);
  });

  it('кривой id в ссылке не роняет запрос', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/source-documents?direction=inbound&siteIds=abc,${'-'.repeat(36)}`,
    });

    expect(res.statusCode).toBe(200);
  });

  it('выгрузка Excel отдаёт ровно те же документы, что список', async () => {
    const query = `direction=inbound&siteIds=${siteId}&supplierIds=${supplierDirId}`;
    const ids = await listIds(query);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/source-documents/export.xlsx?${query}`,
    });
    expect(res.statusCode).toBe(200);

    const XLSX = await import('xlsx');
    const wb = XLSX.read(res.rawPayload, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]!]!;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
    // Строки позиций у документов без items не появляются, поэтому сравниваем
    // номера документов: в файле должны быть те же, что на экране.
    const numbersInFile = new Set(
      rows.map((r) => String(r['Номер'] ?? r['№ документа'] ?? '')).filter(Boolean),
    );
    const expected = [docDirectory, docLegacy].map((id) => `FLT-${id.slice(0, 8)}`);
    for (const num of expected) expect(numbersInFile).toContain(num);
    expect(numbersInFile.size).toBe(ids.length);
  });
});
