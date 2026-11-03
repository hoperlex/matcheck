/**
 * Фильтр «Поставщик» по группе одного поставщика (реальный PostgreSQL).
 *
 * Данные повторяют ТУЛА-СТАЛЬ на бою 02.11: настоящая запись из BillHub
 * («ТД»), дубли распознавания «ТОРГОВЫЙ ДОМ» с ошибочными ИНН, один — с ИНН
 * СУ-10. Человек выбирает одну строку; выдача обязана быть одинаковой при
 * любом участнике группы и не тянуть приёмки СУ-10 через чужой ИНН дубля.
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
const { deliveryRoutes } = await import('../../src/routes/deliveries.js');
const { shipmentRoutes } = await import('../../src/routes/shipments.js');
const { supplierRoutes } = await import('../../src/routes/suppliers.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** ИНН юрлица с верной контрольной суммой из девяти цифр. */
function innFrom(nine: string): string {
  const w = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = w.reduce((acc, x, i) => acc + x * Number(nine[i]), 0);
  return `${nine}${(sum % 11) % 10}`;
}

suite('фильтр «Поставщик» по группе (реальный PostgreSQL)', { timeout: 60_000 }, () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;

  const tag = String(Date.now()).slice(-7);
  const inn = (n: number): string => innFrom(`9${tag}${n}`);
  const siteId = randomUUID();
  const managerId = randomUUID();
  let role: AuthUser['role'] = 'manager';

  // Группа «ТУЛА-СТАЛЬ»: BillHub + три дубля.
  const bh = randomUUID();
  const dupSameName = randomUUID(); // корректный ИНН-ошибка, контрагент с тем же именем
  const dupSu10 = randomUUID(); // ИНН СУ-10
  const dupAlias = randomUUID(); // контрагент назван как алиас дубля
  const members = [bh, dupSameName, dupSu10, dupAlias];
  // Отдельная запись BillHub с некорректным ИНН.
  const bhBroken = randomUUID();

  const innBh = inn(1);
  const innSameName = inn(2);
  const innSu10 = inn(3);
  const innAlias = inn(4);
  const innBroken = `9${tag}55`; // 9 цифр: длина неверна

  const cpBhForeignName = randomUUID(); // ИНН BillHub, имя искажено («ЗМ ГРУПП»)
  const cpSameName = randomUUID();
  const cpSu10 = randomUUID();
  const cpAlias = randomUUID();
  const cpBrokenForeign = randomUUID();

  const docOnDup = randomUUID(); // современный документ на дубле
  const docLegacySu10 = randomUUID(); // старый документ через контрагента СУ-10
  const docLegacyBh = randomUUID(); // старый документ через контрагента с ИНН BillHub

  const dViaDupDoc = randomUUID();
  const dOwnBhForeign = randomUUID();
  const dOwnSameName = randomUUID();
  const dOwnAlias = randomUUID();
  const dOwnSu10 = randomUUID();
  const dOwnBrokenForeign = randomUUID();

  const shViaDoc = randomUUID();
  const shOwnSameName = randomUUID();
  const shOwnSu10 = randomUUID();

  const name = (s: string): string => `${s} ${tag}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    app.decorate('db', drizzle(sql, { schema, casing: 'snake_case' }) as never);
    app.decorate('queues', { updParse: { add: vi.fn() } } as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = { id: managerId, role, siteId: null } as unknown as AuthUser;
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
    await app.register(deliveryRoutes);
    await app.register(shipmentRoutes);
    await app.register(supplierRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`SFG${tag.slice(-4)}`}, 'Группы поставщиков')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
              VALUES (${managerId}, ${`sfg-${managerId}@test`}, 'x', 'manager', NULL)`;

    const tula = name('ТУЛА-СТАЛЬ');
    await sql`INSERT INTO suppliers (id, inn, name, billhub_id, created_at) VALUES
      (${bh}, ${innBh}, ${`ООО "ТД "${tula}"`}, ${randomUUID()}, '2026-01-01'),
      (${dupSameName}, ${innSameName}, ${`ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "ТОРГОВЫЙ ДОМ "${tula}"`}, NULL, '2026-02-01'),
      (${dupSu10}, ${innSu10}, ${`ООО «ТОРГОВЫЙ ДОМ «${tula}»`}, NULL, '2026-03-01'),
      (${bhBroken}, ${innBroken}, ${`ООО "${name('ВЕНТ')}"`}, ${randomUUID()}, '2026-01-01')`;
    await sql`INSERT INTO suppliers (id, inn, name, aliases, created_at) VALUES
      (${dupAlias}, ${innAlias}, ${`ООО "ТД ${tula}"`}, ${sql.array([`ООО "${name('ТЛ СТАЛЬ')}"`])}, '2026-04-01')`;

    await sql`INSERT INTO counterparties (id, inn, name, is_supplier) VALUES
      (${cpBhForeignName}, ${innBh}, ${`ООО "${name('ЗМ ГРУПП')}"`}, true),
      (${cpSameName}, ${innSameName}, ${`ООО «Торговый дом ${tula}»`}, true),
      (${cpSu10}, ${innSu10}, ${`ООО "${name('СУ-10')}"`}, true),
      (${cpAlias}, ${innAlias}, ${`ООО «${name('ТЛ СТАЛЬ')}»`}, true),
      (${cpBrokenForeign}, ${innBroken}, ${`ООО "${name('ЧУЖОЙ')}"`}, true)`;

    const insertDoc = async (
      id: string,
      extra: { dir?: string; op?: string; direction?: 'inbound' | 'outbound' },
    ): Promise<void> => {
      await sql`INSERT INTO source_documents
                  (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum,
                   supplier_directory_id, supplier_id)
                VALUES (${id}, 'upd', ${extra.direction ?? 'inbound'}, 'parsed', 'manual_pdf', ${siteId},
                        ${`SFG-${id.slice(0, 8)}`}, '2026-10-01', 100.00,
                        ${extra.dir ?? null}, ${extra.op ?? null})`;
    };
    await insertDoc(docOnDup, { dir: dupSameName });
    await insertDoc(docLegacySu10, { op: cpSu10 });
    await insertDoc(docLegacyBh, { op: cpBhForeignName });

    const deliveryStatus = (
      await sql<{ id: string }[]>`
        SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`
    )[0]!.id;
    const delivery = async (id: string, supplier: string | null): Promise<void> => {
      await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, supplier_id, arrived_at, version)
                VALUES (${id}, ${siteId}, ${managerId}, ${deliveryStatus}, ${supplier}, now(), 1)`;
    };
    await delivery(dViaDupDoc, null);
    await delivery(dOwnBhForeign, cpBhForeignName);
    await delivery(dOwnSameName, cpSameName);
    await delivery(dOwnAlias, cpAlias);
    await delivery(dOwnSu10, cpSu10);
    await delivery(dOwnBrokenForeign, cpBrokenForeign);
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id) VALUES (${dViaDupDoc}, ${docOnDup})`;

    const shipmentStatus = (
      await sql<{ id: string }[]>`
        SELECT id FROM statuses WHERE entity_type = 'shipment' AND code = 'not_filled' LIMIT 1`
    )[0]!.id;
    const shipment = async (id: string, supplier: string | null): Promise<void> => {
      await sql`INSERT INTO shipments (id, site_id, inspector_id, status_id, kind, supplier_id, version)
                VALUES (${id}, ${siteId}, ${managerId}, ${shipmentStatus}, 'contractor', ${supplier}, 1)`;
    };
    // Поставщик отгрузки известен только из её УПД (на дубле с ИНН СУ-10).
    const shipDoc = randomUUID();
    await insertDoc(shipDoc, { dir: dupSu10, direction: 'outbound' });
    await shipment(shViaDoc, null);
    await shipment(shOwnSameName, cpSameName);
    await shipment(shOwnSu10, cpSu10);
    await sql`INSERT INTO shipment_sources (shipment_id, source_document_id) VALUES (${shViaDoc}, ${shipDoc})`;
  });

  afterAll(async () => {
    if (!sql) return;
    await app.close();
    await sql`DELETE FROM shipment_sources WHERE shipment_id IN (SELECT id FROM shipments WHERE site_id = ${siteId})`;
    await sql`DELETE FROM shipments WHERE site_id = ${siteId}`;
    await sql`DELETE FROM delivery_sources WHERE delivery_id IN (SELECT id FROM deliveries WHERE site_id = ${siteId})`;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM counterparties WHERE id IN (${cpBhForeignName}, ${cpSameName}, ${cpSu10}, ${cpAlias}, ${cpBrokenForeign})`;
    await sql`DELETE FROM suppliers WHERE id IN (${bh}, ${dupSameName}, ${dupSu10}, ${dupAlias}, ${bhBroken})`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  const ids = async (path: string, supplier: string, extra = ''): Promise<string[]> => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/${path}?siteIds=${siteId}&supplierIds=${supplier}&limit=200${extra}`,
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { items: { id: string }[] }).items.map((i) => i.id).sort();
  };
  const deliveriesOf = (supplier: string) => ids('deliveries', supplier);
  const shipmentsOf = (supplier: string) => ids('shipments', supplier);
  const documentsOf = (supplier: string) => ids('source-documents', supplier, '&direction=inbound');

  it('приёмки: одна выдача на всю группу, без СУ-10', async () => {
    const expected = [dViaDupDoc, dOwnBhForeign, dOwnSameName, dOwnAlias].sort();
    for (const id of members) expect(await deliveriesOf(id)).toEqual(expected);
  });

  it('документы: одна выдача на всю группу, без СУ-10', async () => {
    const expected = [docOnDup, docLegacyBh].sort();
    for (const id of members) expect(await documentsOf(id)).toEqual(expected);
  });

  it('отгрузки: поставщик из УПД и свой supplier_id, без СУ-10', async () => {
    const expected = [shViaDoc, shOwnSameName].sort();
    for (const id of members) expect(await shipmentsOf(id)).toEqual(expected);
  });

  it('некорректный ИНН записи BillHub не берёт контрагента с чужим именем', async () => {
    expect(await deliveriesOf(bhBroken)).toEqual([]);
  });

  it('неизвестный id ничего не находит', async () => {
    expect(await deliveriesOf(randomUUID())).toEqual([]);
  });

  it('выгрузка приёмок по участнику группы совпадает со списком', async () => {
    const query = `siteIds=${siteId}&supplierIds=${dupSu10}`;
    const list = await app.inject({ method: 'GET', url: `/api/v1/deliveries?${query}&limit=200` });
    const listed = (list.json() as { items: { displayId: number }[] }).items.map(
      (d) => d.displayId,
    );
    const res = await app.inject({ method: 'GET', url: `/api/v1/deliveries/export.xlsx?${query}` });
    expect(res.statusCode).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const exported: number[] = [];
    wb.worksheets[0]!.eachRow((row, rowNumber) => {
      if (rowNumber === 1 || row.outlineLevel === 1) return;
      const value = row.getCell(2).value;
      if (typeof value === 'number') exported.push(value);
    });
    expect(listed).toHaveLength(4);
    expect(exported.sort()).toEqual(listed.sort());
  });

  it('filter-options: группа одной строкой, основная запись — BillHub', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/suppliers/filter-options' });
    expect(res.statusCode).toBe(200);
    const items = (res.json() as { items: { value: string; label: string; memberIds: string[] }[] })
      .items;
    const group = items.find((g) => g.memberIds.includes(dupSu10));
    expect(group?.value).toBe(bh);
    expect(group?.label).toBe(`ООО "ТД "${name('ТУЛА-СТАЛЬ')}"`);
    expect([...group!.memberIds].sort()).toEqual([...members].sort());
    expect(items.filter((g) => g.memberIds.some((m) => members.includes(m)))).toHaveLength(1);
  });

  it('filter-options закрыт для роли без доступа к справочнику', async () => {
    role = 'contractor';
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/suppliers/filter-options' });
      expect(res.statusCode).toBe(403);
    } finally {
      role = 'manager';
    }
  });
});
