/**
 * Фильтр «Поставщик» в списке приёмок ищет там же, куда смотрит человек.
 *
 * Собственное поле `deliveries.supplier_id` заполняется редко: у приёмки с
 * привязанной УПД ручной выбор поставщика запрещён (409 upd_takes_priority), а
 * воркер пишет поставщика только в справочник документа. Колонка «Поставщик» на
 * экране показывает документ — и фильтр обязан находить те же строки, иначе
 * менеджер выбирает поставщика, которого сам видит в таблице, и получает
 * пустой список.
 *
 * Запуск: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test
 * Без переменной набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliveryRoutes } from '../../src/routes/deliveries.js';
import * as schema from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('фильтр «Поставщик» у приёмок (реальный PostgreSQL)', { timeout: 60_000 }, () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;

  const siteId = randomUUID();
  const managerId = randomUUID();
  const inn = `76${String(Date.now()).slice(-8)}`;
  const supplierDirId = randomUUID();
  const supplierOpId = randomUUID();
  const docId = randomUUID();

  const viaDocument = randomUUID(); // поставщик известен только из УПД
  const viaOwnField = randomUUID(); // исторический путь: supplier_id у приёмки
  const unrelated = randomUUID(); // чужая приёмка

  // Колонка «Поставщик» в выгрузке: свой поставщик приёмки впереди документа,
  // из двух документов — тот же «первый», что у экрана.
  const ownCpId = randomUUID();
  const ownAndDocument = randomUUID(); // свой поставщик + привязанная УПД
  const dirFirstId = randomUUID();
  const dirSecondId = randomUUID();
  const docA = randomUUID();
  const docB = randomUUID();
  const twoDocuments = randomUUID(); // две УПД разных поставщиков

  const manager = { id: managerId, role: 'manager', siteId: null } as unknown as AuthUser;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql, { schema, casing: 'snake_case' }) as never);
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
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`SUP${Date.now() % 10000}`}, 'Фильтр поставщика')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
              VALUES (${managerId}, ${`sup-${managerId}@test`}, 'x', 'manager', NULL)`;
    await sql`INSERT INTO suppliers (id, inn, name) VALUES (${supplierDirId}, ${inn}, 'ООО «Поставщик»')`;
    await sql`INSERT INTO counterparties (id, inn, name, is_supplier)
              VALUES (${supplierOpId}, ${inn}, 'ООО «Поставщик»', true)`;
    // Документ с поставщиком ТОЛЬКО в справочнике — так пишет воркер.
    await sql`INSERT INTO source_documents
                (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum,
                 supplier_directory_id)
              VALUES (${docId}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId},
                      ${`SUP-${docId.slice(0, 8)}`}, '2026-08-01', 100.00, ${supplierDirId})`;

    const statusId = (
      await sql<{ id: string }[]>`
        SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`
    )[0]!.id;
    const seed = async (id: string, supplier: string | null): Promise<void> => {
      await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, supplier_id, arrived_at, version)
                VALUES (${id}, ${siteId}, ${managerId}, ${statusId}, ${supplier}, now(), 1)`;
    };
    await seed(viaDocument, null);
    await seed(viaOwnField, supplierOpId);
    await seed(unrelated, null);
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id)
              VALUES (${viaDocument}, ${docId})`;

    await sql`INSERT INTO counterparties (id, inn, name, is_supplier)
              VALUES (${ownCpId}, ${`77${String(Date.now()).slice(-8)}`}, 'ООО «Свой»', true)`;
    await seed(ownAndDocument, ownCpId);
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id)
              VALUES (${ownAndDocument}, ${docId})`;

    await sql`INSERT INTO suppliers (id, inn, name) VALUES
                (${dirFirstId}, ${`78${String(Date.now()).slice(-8)}`}, 'ООО «Первый»'),
                (${dirSecondId}, ${`79${String(Date.now()).slice(-8)}`}, 'ООО «Второй»')`;
    for (const [id, dir] of [
      [docA, dirFirstId],
      [docB, dirSecondId],
    ] as const) {
      await sql`INSERT INTO source_documents
                  (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum,
                   supplier_directory_id)
                VALUES (${id}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId},
                        ${`SUP-${id.slice(0, 8)}`}, '2026-08-01', 100.00, ${dir})`;
    }
    await seed(twoDocuments, null);
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id)
              VALUES (${twoDocuments}, ${docA}), (${twoDocuments}, ${docB})`;
  });

  afterAll(async () => {
    if (!sql) return;
    await app.close();
    await sql`DELETE FROM delivery_sources WHERE source_document_id IN (${docId}, ${docA}, ${docB})`;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM counterparties WHERE id IN (${supplierOpId}, ${ownCpId})`;
    await sql`DELETE FROM suppliers WHERE id IN (${supplierDirId}, ${dirFirstId}, ${dirSecondId})`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  it('находит приёмку, у которой поставщик известен только из привязанной УПД', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/deliveries?siteIds=${siteId}&supplierIds=${supplierDirId}&limit=200`,
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { items: { id: string }[] }).items.map((d) => d.id);

    expect(ids).toContain(viaDocument);
    expect(ids).toContain(viaOwnField);
    expect(ids).not.toContain(unrelated);
  });

  it('выгрузка сужается тем же фильтром, что и список', async () => {
    const query = `siteIds=${siteId}&supplierIds=${supplierDirId}`;
    const list = await app.inject({ method: 'GET', url: `/api/v1/deliveries?${query}&limit=200` });
    const items = (list.json() as { items: { id: string; displayId: number }[] }).items;

    const res = await app.inject({ method: 'GET', url: `/api/v1/deliveries/export.xlsx?${query}` });
    expect(res.statusCode).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const exported: number[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1 || row.outlineLevel === 1) return;
      const value = row.getCell(2).value;
      if (typeof value === 'number') exported.push(value);
    });

    expect(exported.sort()).toEqual(items.map((d) => d.displayId).sort());
  });

  it('колонка «Поставщик» в выгрузке совпадает с экраном, в том числе из документа', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/deliveries?siteIds=${siteId}&limit=200`,
    });
    type Item = {
      id: string;
      displayId: number;
      supplierName: string | null;
      primarySourceDocument: { supplierName: string | null } | null;
    };
    const items = (list.json() as { items: Item[] }).items;
    // То, что показывает колонка списка (resolveSupplierName в DeliveriesHistory).
    const onScreen = new Map(
      items.map((d) => [
        d.displayId,
        d.supplierName ?? d.primarySourceDocument?.supplierName ?? '',
      ]),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/deliveries/export.xlsx?siteIds=${siteId}`,
    });
    expect(res.statusCode).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    let supplierCol = 0;
    ws.getRow(1).eachCell((cell, col) => {
      if (cell.value === 'Поставщик') supplierCol = col;
    });
    expect(supplierCol).toBeGreaterThan(0);
    const exported = new Map<number, string>();
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1 || row.outlineLevel === 1) return;
      const displayId = row.getCell(2).value;
      if (typeof displayId === 'number') {
        exported.set(displayId, String(row.getCell(supplierCol).value ?? ''));
      }
    });

    expect(exported).toEqual(onScreen);

    const byId = new Map(items.map((d) => [d.id, d.displayId]));
    const cell = (id: string) => exported.get(byId.get(id)!);
    expect(cell(viaDocument)).toBe('ООО «Поставщик»');
    expect(cell(viaOwnField)).toBe('ООО «Поставщик»');
    expect(cell(ownAndDocument)).toBe('ООО «Свой»');
    expect(cell(unrelated)).toBe('');
    // «Первый» документ — с меньшим id, как в primarySourceDocument.
    expect(cell(twoDocuments)).toBe(
      [docA, docB].sort()[0] === docA ? 'ООО «Первый»' : 'ООО «Второй»',
    );
  });
});
