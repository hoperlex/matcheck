/**
 * Признак «УПД из ЭДО/СБИС» (?features=edo) в списке приёмок.
 *
 * Привязка УПД из ЭДО живёт в delivery_edo_matches двумя способами: своей
 * копией УПД (source_document_id) и записью реестра выгрузки (export_document_id
 * — там и Диадок, и СБИС). Признак отбирает приёмку при любом из них, а
 * выгрузка — ровно то же, что список.
 *
 * Пункт виден тем, кому привязки ЭДО видны в карточке (возможность
 * operations.edit.link_source). Без неё параметр из чужой ссылки игнорируется:
 * список не сужается без видимого фильтра.
 *
 * Запуск: см. шапку foreign-site.int.test.ts (тот же TEST_DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserRole } from '@matcheck/contracts';
import { deliveryRoutes } from '../../src/routes/deliveries.js';
import { deliveries, sites, statuses, users } from '../../src/db/schema.js';
import { routeKey } from '../../src/lib/permissions/route-map.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('признак «УПД из ЭДО/СБИС» (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;
  const RUN = String(Date.now()).slice(-7);
  const siteId = randomUUID();
  const managerId = randomUUID();
  const diadocAccountId = randomUUID();
  const sbisAccountId = randomUUID();
  const diadocExportId = randomUUID();
  const sbisExportId = randomUUID();
  const docIds: string[] = [];

  const d = {
    edoCopy: randomUUID(),
    edoDiadoc: randomUUID(),
    // СБИС плюс бумажная УПД — для проверки «И» с признаком upd.
    edoSbisWithPaper: randomUUID(),
    paperOnly: randomUUID(),
    plain: randomUUID(),
  };
  const ALL = Object.values(d).sort();
  const WITH_EDO = [d.edoCopy, d.edoDiadoc, d.edoSbisWithPaper].sort();

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    const db = drizzle(sql, { schema: { deliveries, sites, statuses, users } });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', db as never);
    // Матрица выключена — дефолты ролей. Allow-list чтения привязок ЭДО — как
    // у боевого GET …/edo-matches: возможность есть у admin и manager.
    app.decorate('permissions', {
      enforced: false,
      get: async () => new Map(),
      routeRoles: new Map([
        [routeKey('GET', '/api/v1/deliveries/:id/edo-matches'), ['admin', 'manager']],
      ]),
      invalidateLocal: () => {},
      invalidateEverywhere: async () => {},
    } as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = currentUser;
    });
    app.decorate('authorize', () => async () => undefined);
    await app.register(deliveryRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`EF${RUN.slice(-4)}`}, 'Признак ЭДО')`;
    await sql`INSERT INTO users (id, email, password_hash, role)
      VALUES (${managerId}, ${`edo-f-${managerId}@test`}, 'x', 'manager')`;
    const [filled] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    for (const id of Object.values(d)) {
      await sql`INSERT INTO deliveries (id, site_id, status_id, version)
        VALUES (${id}, ${siteId}, ${filled!.id}, 1)`;
    }

    const doc = async (docNumber: string): Promise<string> => {
      const id = randomUUID();
      docIds.push(id);
      await sql`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, doc_number)
        VALUES (${id}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId}, ${docNumber})`;
      return id;
    };
    const linkPaper = async (deliveryId: string, docNumber: string) =>
      sql`INSERT INTO delivery_sources (delivery_id, source_document_id)
        VALUES (${deliveryId}, ${await doc(docNumber)})`;

    // Своя копия УПД.
    await sql`INSERT INTO delivery_edo_matches (delivery_id, source_document_id)
      VALUES (${d.edoCopy}, ${await doc(`КОПИЯ-${RUN}`)})`;
    // Записи реестра Диадока и СБИС.
    await sql`INSERT INTO edo_accounts (id, name, credentials_encrypted)
      VALUES (${diadocAccountId}, ${`Диадок ${RUN}`}, '{}')`;
    await sql`INSERT INTO edo_accounts (id, provider, auth_mode, name, credentials_encrypted)
      VALUES (${sbisAccountId}, 'sbis', 'sbis_service_key', ${`СБИС ${RUN}`}, '{}')`;
    await sql`INSERT INTO edo_export_documents
        (id, edo_account_id, message_id, entity_id, document_type, document_number, status)
      VALUES
        (${diadocExportId}, ${diadocAccountId}, ${`m-d-${RUN}`}, ${`e-d-${RUN}`},
         'UniversalTransferDocument', ${`Д-${RUN}`}, 'not_in_list'),
        (${sbisExportId}, ${sbisAccountId}, ${`m-s-${RUN}`}, ${`e-s-${RUN}`},
         'UniversalTransferDocument', ${`С-${RUN}`}, 'not_in_list')`;
    await sql`INSERT INTO delivery_edo_matches (delivery_id, export_document_id) VALUES
      (${d.edoDiadoc}, ${diadocExportId}),
      (${d.edoSbisWithPaper}, ${sbisExportId})`;

    await linkPaper(d.edoSbisWithPaper, `БУМ-1-${RUN}`);
    await linkPaper(d.paperOnly, `БУМ-2-${RUN}`);
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM edo_export_documents WHERE id IN (${diadocExportId}, ${sbisExportId})`;
    await sql`DELETE FROM edo_accounts WHERE id IN (${diadocAccountId}, ${sbisAccountId})`;
    await sql`DELETE FROM source_documents WHERE id = ANY(${docIds})`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  const as = (role: UserRole, id = randomUUID(), site: string | null = null): AuthUser => ({
    id,
    role,
    siteId: site,
    contractorCustomerId: null,
    sessionId: randomUUID(),
  });

  async function listIds(params: Record<string, string>): Promise<string[]> {
    const qs = new URLSearchParams({ siteIds: siteId, limit: '200', ...params });
    const res = await app.inject({ method: 'GET', url: `/api/v1/deliveries?${qs}` });
    expect(res.statusCode).toBe(200);
    return (res.json() as { items: { id: string }[] }).items.map((i) => i.id).sort();
  }
  async function exportCount(params: Record<string, string>): Promise<number> {
    const qs = new URLSearchParams({ siteIds: siteId, ...params });
    const res = await app.inject({ method: 'GET', url: `/api/v1/deliveries/export.xlsx?${qs}` });
    expect(res.statusCode).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    let n = 0;
    wb.worksheets[0]!.eachRow((r, i) => {
      if (i > 1 && r.outlineLevel !== 1) n++;
    });
    return n;
  }

  it('отбирает своя копия, реестр Диадока и реестр СБИС; выгрузка — то же', async () => {
    currentUser = as('manager', managerId);
    expect(await listIds({})).toEqual(ALL);
    expect(await listIds({ features: 'edo' })).toEqual(WITH_EDO);
    expect(await exportCount({ features: 'edo' })).toBe(WITH_EDO.length);
  });

  it('с другими признаками — И', async () => {
    currentUser = as('manager', managerId);
    expect(await listIds({ features: 'edo,upd' })).toEqual([d.edoSbisWithPaper]);
  });

  it('без права на привязки ЭДО параметр игнорируется — список не сужается', async () => {
    // Монитор видит все объекты, но привязки ЭДО по умолчанию ему закрыты.
    currentUser = as('monitor');
    expect(await listIds({ features: 'edo' })).toEqual(ALL);
    // Инспектор своего объекта.
    currentUser = as('inspector_kpp', randomUUID(), siteId);
    expect(await listIds({ features: 'edo' })).toEqual(ALL);
  });
});
