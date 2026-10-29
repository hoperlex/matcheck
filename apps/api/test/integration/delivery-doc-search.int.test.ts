/**
 * Поиск приёмки по номеру УПД или накладной (параметр q).
 *
 * Документ приёмки бывает в трёх местах: в связях (delivery_sources), только в
 * происхождении строк (документ отвязан, строки остались) и в подтверждении
 * ЭДО — своей копией УПД или записью реестра выгрузки. Раньше q искал только
 * по связям. Номер сравнивается и как есть, и без разделителей: «1029/01»
 * находит «1029-01». Список и выгрузка строят условие одной функцией — тест
 * сверяет, что они отдают одно и то же.
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
import { deliveries, sites, statuses, users } from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('поиск приёмки по номеру документа (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  const RUN = String(Date.now()).slice(-7);
  const siteId = randomUUID();
  const managerId = randomUUID();
  const accountId = randomUUID();
  const currentUser: AuthUser = {
    id: managerId,
    role: 'manager',
    siteId: null,
    contractorCustomerId: null,
    sessionId: randomUUID(),
  };

  const d = {
    linkedUpd: randomUUID(),
    waybill: randomUUID(),
    originOnly: randomUUID(),
    edoSource: randomUUID(),
    edoExport: randomUUID(),
    percent: randomUUID(),
    lookalike: randomUUID(),
  };
  const docIds: string[] = [];
  const exportDocId = randomUUID();

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    const db = drizzle(sql, { schema: { deliveries, sites, statuses, users } });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', db as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = currentUser;
    });
    app.decorate('authorize', () => async () => undefined);
    await app.register(deliveryRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`DS${RUN.slice(-4)}`}, 'Поиск по номеру')`;
    await sql`INSERT INTO users (id, email, password_hash, role)
      VALUES (${managerId}, ${`search-${managerId}@test`}, 'x', 'manager')`;
    const [filled] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    for (const id of Object.values(d)) {
      await sql`INSERT INTO deliveries (id, site_id, status_id, version)
        VALUES (${id}, ${siteId}, ${filled!.id}, 1)`;
    }

    const doc = async (kind: 'upd' | 'transport_waybill', docNumber: string): Promise<string> => {
      const id = randomUUID();
      docIds.push(id);
      await sql`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, doc_number)
        VALUES (${id}, ${kind}, 'inbound', 'parsed', 'manual_pdf', ${siteId}, ${docNumber})`;
      return id;
    };
    const link = (deliveryId: string, docId: string) =>
      sql`INSERT INTO delivery_sources (delivery_id, source_document_id) VALUES (${deliveryId}, ${docId})`;

    await link(d.linkedUpd, await doc('upd', `УТ-1029-01-${RUN}`));
    await link(d.waybill, await doc('transport_waybill', `ТН 777/${RUN}`));
    // Документ отвязан, его строки остались в приёмке.
    const orphan = await doc('upd', `ОРФ-${RUN}`);
    await sql`INSERT INTO delivery_items (delivery_id, name_raw, line_no, source_document_id)
      VALUES (${d.originOnly}, 'Труба', 1, ${orphan})`;
    // Подтверждение ЭДО своей копией УПД.
    const edoCopy = await doc('upd', `ЭДО-${RUN}`);
    await sql`INSERT INTO delivery_edo_matches (delivery_id, source_document_id)
      VALUES (${d.edoSource}, ${edoCopy})`;
    // Подтверждение ЭДО записью реестра выгрузки.
    await sql`INSERT INTO edo_accounts (id, name, credentials_encrypted)
      VALUES (${accountId}, ${`Поиск ${RUN}`}, '{}')`;
    await sql`INSERT INTO edo_export_documents
        (id, edo_account_id, message_id, entity_id, document_type, document_number, status)
      VALUES (${exportDocId}, ${accountId}, ${`m-${RUN}`}, ${`e-${RUN}`},
              'UniversalTransferDocument', ${`РЕЕСТР 55-${RUN}`}, 'not_in_list')`;
    await sql`INSERT INTO delivery_edo_matches (delivery_id, export_document_id)
      VALUES (${d.edoExport}, ${exportDocId})`;
    // «%» — литерал, а не любой символ.
    await link(d.percent, await doc('upd', `П100%-${RUN}`));
    await link(d.lookalike, await doc('upd', `П100Х-${RUN}`));
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM edo_export_documents WHERE id = ${exportDocId}`;
    await sql`DELETE FROM edo_accounts WHERE id = ${accountId}`;
    await sql`DELETE FROM source_documents WHERE id = ANY(${docIds})`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  async function search(q: string): Promise<string[]> {
    const qs = new URLSearchParams({ siteIds: siteId, q, limit: '200' });
    const res = await app.inject({ method: 'GET', url: `/api/v1/deliveries?${qs}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: string; displayId: number }[] };
    const listDisplayIds = body.items.map((i) => i.displayId).sort();

    // Выгрузка с теми же параметрами — те же записи.
    const exp = await app.inject({
      method: 'GET',
      url: `/api/v1/deliveries/export.xlsx?${new URLSearchParams({ siteIds: siteId, q })}`,
    });
    expect(exp.statusCode).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(exp.rawPayload as unknown as ArrayBuffer);
    const exported: number[] = [];
    wb.worksheets[0]!.eachRow((row, n) => {
      if (n === 1 || row.outlineLevel === 1) return;
      const v = row.getCell(2).value;
      if (typeof v === 'number') exported.push(v);
    });
    expect(exported.sort()).toEqual(listDisplayIds);

    return body.items.map((i) => i.id).sort();
  }

  it('связанная УПД и накладная — как раньше', async () => {
    expect(await search(`1029-01-${RUN}`)).toEqual([d.linkedUpd]);
    expect(await search(`777/${RUN}`)).toEqual([d.waybill]);
  });

  it('документ только в строках приёмки', async () => {
    expect(await search(`ОРФ-${RUN}`)).toEqual([d.originOnly]);
  });

  it('УПД из ЭДО — своей копией и записью реестра', async () => {
    expect(await search(`ЭДО-${RUN}`)).toEqual([d.edoSource]);
    expect(await search(`РЕЕСТР 55-${RUN}`)).toEqual([d.edoExport]);
  });

  it('номер с другими разделителями', async () => {
    expect(await search(`1029/01 ${RUN}`)).toEqual([d.linkedUpd]);
    expect(await search(`102901${RUN}`)).toEqual([d.linkedUpd]);
    expect(await search(`ТН777${RUN}`)).toEqual([d.waybill]);
    expect(await search(`реестр55/${RUN}`)).toEqual([d.edoExport]);
  });

  it('«%» ищется буквально', async () => {
    expect(await search(`100%-${RUN}`)).toEqual([d.percent]);
  });

  it('несовпадающий номер — пусто', async () => {
    expect(await search(`НЕТ-ТАКОГО-${RUN}`)).toEqual([]);
  });
});
