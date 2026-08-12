/**
 * Стороны документа в API: список, сортировка и выгрузка в Excel.
 *
 * Что здесь ловится и не ловится больше нигде:
 *   * имя стороны без ИНН. FK у неё пустой, и если DTO собирать только по
 *     джойну, колонка окажется пустой при заполненной БД;
 *   * sort=buyerName / sort=consigneeName. Список валидирует параметр по
 *     списку разрешённых полей, поэтому забытая строчка в SORT_FIELDS даёт
 *     400 — при полностью рабочем SQL;
 *   * порядок и содержимое колонок выгрузки: она собирается отдельным
 *     запросом со своими джойнами и легко расходится с экраном.
 *
 * Запуск: см. заголовок test/integration/upload-documents-characterization.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
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

const { sourceDocumentRoutes } = await import('../../src/routes/source-documents.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('стороны документа в API (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  const siteId = randomUUID();
  const consigneeCpId = randomUUID();
  // ИНН уникален в пределах таблицы, а базу делят все интеграционные наборы —
  // константа здесь падала бы при повторном прогоне и на чужих контрагентах.
  const consigneeInn = `77${String(Date.now()).slice(-8)}`;
  // Поставщик из справочника с ПУСТЫМ ИНН (suppliers.inn — NOT NULL DEFAULT '',
  // таких записей в справочнике заказчика много) и legacy-контрагент с
  // настоящим: вместе проверяют, что пустая строка не блокирует fallback.
  const supplierDirId = randomUUID();
  const supplierCpId = randomUUID();
  const supplierCpInn = `78${String(Date.now()).slice(-8)}`;
  // Документы: «Альянс» без ИНН в графе 4, «ФСК» — нормализованный контрагент.
  const docWithRawId = randomUUID();
  const docWithFkId = randomUUID();
  // Документ, у которого ИНН стороны есть и в справочнике, и в самом документе,
  // причём разные: так видно, какой из источников выигрывает. Живёт на ОТДЕЛЬНОМ
  // объекте: тесты сортировки ниже сверяют список целиком и ловят каждую лишнюю
  // строку, а у этого документа половина полей намеренно пуста.
  const siteInnId = randomUUID();
  const docInnRawId = randomUUID();
  const rawConsigneeInn = `79${String(Date.now()).slice(-8)}`;
  // ИНН, который человек вводит в карточке при ручной правке поставщика.
  const patchSupplierInn = `76${String(Date.now()).slice(-8)}`;

  const manager = { id: randomUUID(), role: 'manager', siteId: null } as unknown as AuthUser;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    app.decorate('db', drizzle(sql) as never);
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

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`PAR${Date.now() % 10000}`}, 'Стороны API')`;
    await sql`INSERT INTO counterparties (id, inn, kpp, name, is_customer)
              VALUES (${consigneeCpId}, ${consigneeInn}, NULL, 'ООО "ФСК Инжиниринг"', true)`;

    await sql`INSERT INTO source_documents
      (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum,
       buyer_name_raw, consignee_name_raw)
      VALUES (${docWithRawId}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId}, '2519',
              '2026-07-10', 100.00, 'ООО «СУ-10»', 'ООО «АЛЬЯНС»')`;
    await sql`INSERT INTO source_documents
      (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum,
       buyer_name_raw, consignee_id)
      VALUES (${docWithFkId}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId}, '2520',
              '2026-07-11', 200.00, 'ООО «Бета»', ${consigneeCpId})`;

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteInnId}, ${`INN${Date.now() % 10000}`}, 'ИНН сторон')`;
    await sql`INSERT INTO suppliers (id, inn, name) VALUES (${supplierDirId}, '', 'ООО «Поставщик без ИНН»')`;
    await sql`INSERT INTO counterparties (id, inn, kpp, name, is_supplier)
              VALUES (${supplierCpId}, ${supplierCpInn}, NULL, 'ООО «Поставщик легаси»', true)`;
    await sql`INSERT INTO source_documents
      (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum,
       supplier_id, supplier_directory_id, consignee_id, consignee_inn_raw)
      VALUES (${docInnRawId}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteInnId}, '2521',
              '2026-07-12', 300.00, ${supplierCpId}, ${supplierDirId}, ${consigneeCpId},
              ${rawConsigneeInn})`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM source_documents WHERE site_id IN (${siteId}, ${siteInnId})`;
    await sql`DELETE FROM sites WHERE id IN (${siteId}, ${siteInnId})`;
    await sql`DELETE FROM counterparties WHERE id IN (${consigneeCpId}, ${supplierCpId})`;
    // PATCH-тест заводит поставщика в справочнике через matchOrCreateSupplier —
    // убираем и его, иначе набор оставляет мусор после каждого прогона.
    await sql`DELETE FROM suppliers WHERE id = ${supplierDirId} OR inn = ${patchSupplierInn}`;
    await sql.end({ timeout: 5 });
  });

  async function listDocs(query = ''): Promise<Record<string, unknown>[]> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/source-documents?direction=inbound&limit=200${query}`,
    });
    expect(res.statusCode).toBe(200);
    return (res.json().items as Record<string, unknown>[]).filter((i) => i.siteId === siteId);
  }

  it('список отдаёт имя стороны без ИНН — из raw, а не из джойна', async () => {
    const items = await listDocs();
    const raw = items.find((i) => i.id === docWithRawId)!;
    expect(raw.buyerName).toBe('ООО «СУ-10»');
    expect(raw.consigneeName).toBe('ООО «АЛЬЯНС»');
    expect(raw.consigneeId).toBeNull();
  });

  it('нормализованная сторона: имя приходит, FK не пустой', async () => {
    const items = await listDocs();
    const fk = items.find((i) => i.id === docWithFkId)!;
    expect(fk.consigneeId).toBe(consigneeCpId);
    expect(fk.consigneeName).toBe('ООО "ФСК Инжиниринг"');
  });

  it('деталь документа отдаёт те же стороны, что и список', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/source-documents/${docWithRawId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.buyerName).toBe('ООО «СУ-10»');
    expect(body.consigneeName).toBe('ООО «АЛЬЯНС»');
  });

  // ─── ИНН сторон (вторая строка ячейки в списке) ───────────────────────────
  //
  // Ловится здесь и больше нигде: у списка, детали и снимка операции свои
  // запросы, и расходятся они молча — на экране просто пропадает ИНН.

  async function innDoc(): Promise<Record<string, unknown>> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/source-documents?direction=inbound&limit=200&siteIds=${siteInnId}`,
    });
    expect(res.statusCode).toBe(200);
    const items = (res.json().items as Record<string, unknown>[]).filter(
      (i) => i.id === docInnRawId,
    );
    expect(items).toHaveLength(1);
    return items[0]!;
  }

  it('сторона без ИНН и без FK: поле пустое, а не выдуманное', async () => {
    const items = await listDocs();
    const raw = items.find((i) => i.id === docWithRawId)!;
    expect(raw.buyerInn ?? null).toBeNull();
    expect(raw.consigneeInn ?? null).toBeNull();
  });

  it('ИНН нормализованной стороны берётся из справочника', async () => {
    const items = await listDocs();
    const fk = items.find((i) => i.id === docWithFkId)!;
    expect(fk.consigneeInn).toBe(consigneeInn);
  });

  it('ИНН из документа приоритетнее справочного', async () => {
    // Справочную запись правят люди, а *_inn_raw отвечает на другой вопрос —
    // что напечатано в документе. Показываем второе.
    const doc = await innDoc();
    expect(doc.consigneeInn).toBe(rawConsigneeInn);
    expect(doc.consigneeInn).not.toBe(consigneeInn);
  });

  it('пустой ИНН справочника не блокирует legacy-контрагента', async () => {
    // suppliers.inn — NOT NULL DEFAULT '', и без NULLIF(BTRIM(…)) пустая строка
    // выиграла бы у counterparties.inn, оставив колонку без ИНН.
    const doc = await innDoc();
    expect(doc.supplierInn).toBe(supplierCpInn);
  });

  it('деталь документа отдаёт те же ИНН, что и список', async () => {
    // Список, деталь и loadSdNames — три независимых сборщика DTO. Пока их
    // держали в согласии только глазами, карточка молча показывала пустоту.
    const fromList = await innDoc();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/source-documents/${docInnRawId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.consigneeInn).toBe(fromList.consigneeInn);
    expect(body.supplierInn).toBe(fromList.supplierInn);
  });

  it('ручная правка поставщика: ИНН из документа уступает выбранному', async () => {
    // Поставщика назвал человек — распознанный ИНН эту сторону больше не
    // описывает. PATCH обнуляет supplier_inn_raw, и DTO показывает ИНН
    // справочной записи, то есть ровно тот, который человек и ввёл.
    await sql`UPDATE source_documents SET supplier_inn_raw = '9999999999' WHERE id = ${docInnRawId}`;
    expect((await innDoc()).supplierInn).toBe('9999999999');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/source-documents/${docInnRawId}`,
      payload: {
        supplier: { inn: patchSupplierInn, name: 'ООО «Поставщик выбранный»' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().supplierInn).toBe(patchSupplierInn);
    expect((await innDoc()).supplierInn).toBe(patchSupplierInn);
  });

  it.each(['buyerName', 'consigneeName'])('sort=%s принимается и сортирует', async (field) => {
    const asc = await listDocs(`&sort=${field}&order=asc`);
    const desc = await listDocs(`&sort=${field}&order=desc`);
    expect(asc.length).toBe(2);
    // Ровно наоборот — это и значит, что сортировка применилась к нужному полю.
    expect(asc.map((i) => i.id)).toEqual([...desc.map((i) => i.id)].reverse());
  });

  it('Excel-выгрузка: три колонки сторон в правильном порядке', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/source-documents/export.xlsx?direction=inbound',
    });
    expect(res.statusCode).toBe(200);

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Документы')!;
    const headers = (ws.getRow(1).values as unknown[]).slice(1).map(String);
    const buyerAt = headers.indexOf('Покупатель');
    expect(buyerAt).toBeGreaterThan(-1);
    expect(headers[buyerAt + 1]).toBe('Грузополучатель');
    expect(headers[buyerAt + 2]).toBe('Поставщик');
    // Колонки «Подрядчик» в выгрузке больше нет — она уехала на экране.
    expect(headers).not.toContain('Подрядчик');

    // И значения тоже на месте: заголовки без данных — половина дела.
    let found = false;
    ws.eachRow((row) => {
      const values = (row.values as unknown[]).map((v) => (v == null ? '' : String(v)));
      if (values.includes('2519')) {
        expect(values).toContain('ООО «СУ-10»');
        expect(values).toContain('ООО «АЛЬЯНС»');
        found = true;
      }
    });
    expect(found).toBe(true);
  });
});
