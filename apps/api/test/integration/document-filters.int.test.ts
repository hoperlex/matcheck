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
  // Тройка для проверки ПОРЯДКА и дат поставки: суммы и даты различаются, номер
  // общим префиксом — чтобы отобрать ровно их поиском по номеру.
  const docSortLow = randomUUID();
  const docSortMid = randomUUID();
  const docSortHigh = randomUUID();
  // Поставка: один пакет — пять документов. На ней проверяется, что страница
  // не разрезает машину пополам.
  const deliveryBundle = randomUUID();
  const deliveryDocs = Array.from({ length: 5 }, () => randomUUID());

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

    // parsed_at задаём намеренно «вразнобой» с суммами: порядок по умолчанию
    // (parsed_at desc) обязан отличаться и от возрастания, и от убывания по
    // сумме. Иначе тест сортировки был бы зелёным даже с выключенной
    // сортировкой — просто по совпадению.
    const insertSortDoc = async (
      id: string,
      num: string,
      total: string,
      expected: string,
      parsedAt: string,
    ) => {
      await sql`INSERT INTO source_documents
                  (id, kind, direction, status, origin, site_id, doc_number, doc_date,
                   total_sum, expected_date, parsed_at, is_technical)
                VALUES (${id}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId},
                        ${num}, '2026-08-01', ${total}, ${expected}, ${parsedAt}, false)`;
    };
    await insertSortDoc(docSortLow, 'SORT-1', '10.00', '2026-09-01', '2026-08-27T10:02:00Z');
    await insertSortDoc(docSortMid, 'SORT-2', '20.00', '2026-09-02', '2026-08-27T10:03:00Z');
    await insertSortDoc(docSortHigh, 'SORT-3', '30.00', '2026-09-03', '2026-08-27T10:01:00Z');

    // Пять документов одной загрузки. Суммы разные и «вперемешку» с одиночками
    // выше — чтобы сортировка по сумме реально пыталась их растащить.
    await sql`INSERT INTO source_bundles (id, bundle_hash, direction, status, site_id)
              VALUES (${deliveryBundle}, ${`hash-${deliveryBundle}`}, 'inbound', 'parsed', ${siteId})`;
    for (const [i, id] of deliveryDocs.entries()) {
      await sql`INSERT INTO source_documents
                  (id, kind, direction, status, origin, site_id, bundle_id, doc_number, doc_date,
                   total_sum, expected_date, parsed_at, is_technical)
                VALUES (${id}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId},
                        ${deliveryBundle}, ${`PACK-${i + 1}`}, '2026-08-01',
                        ${`${(i + 1) * 7}.00`}, '2026-09-05',
                        ${`2026-08-27T11:0${i}:00Z`}, false)`;
    }
  });

  afterAll(async () => {
    if (!sql) return;
    await app.close();
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE id = ${deliveryBundle}`;
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

  it('без sort порядок прежний — по свежести разбора', async () => {
    // Опора для тестов ниже: естественный порядок ОТЛИЧАЕТСЯ от порядка по
    // сумме в обе стороны, поэтому совпадение там означает работу сортировки.
    const ids = await listIds(`direction=inbound&siteIds=${siteId}&q=SORT-`);
    expect(ids).toEqual([docSortMid, docSortLow, docSortHigh]);
  });

  it('сортировка по сумме упорядочивает выдачу, а не только принимается', async () => {
    // Проверяем сами значения, а не наличие параметра: список долго «принимал»
    // sort и отдавал прежний порядок, потому что клиент его не слал, и никакой
    // тест этого не ловил.
    const asc = await listIds(`direction=inbound&siteIds=${siteId}&q=SORT-&sort=totalSum&order=asc`);
    expect(asc).toEqual([docSortLow, docSortMid, docSortHigh]);

    const desc = await listIds(
      `direction=inbound&siteIds=${siteId}&q=SORT-&sort=totalSum&order=desc`,
    );
    expect(desc).toEqual([docSortHigh, docSortMid, docSortLow]);
  });

  it('смещение работает вместе с сортировкой', async () => {
    // Страница считается окном по УЖЕ отсортированной выборке: без этого
    // вторая страница показывала бы те же строки, что и первая.
    const second = await listIds(
      `direction=inbound&siteIds=${siteId}&q=SORT-&sort=totalSum&order=asc&limit=1&offset=1`,
    );
    expect(second).toEqual([docSortMid]);
  });

  it('фильтр по дате поставки включает обе границы', async () => {
    const single = await listIds(
      `direction=inbound&siteIds=${siteId}&q=SORT-&expectedDateFrom=2026-09-02&expectedDateTo=2026-09-02`,
    );
    expect(single).toEqual([docSortMid]);

    const range = await listIds(
      `direction=inbound&siteIds=${siteId}&q=SORT-&expectedDateFrom=2026-09-01&expectedDateTo=2026-09-03&sort=expectedDate&order=asc`,
    );
    expect(range).toEqual([docSortLow, docSortMid, docSortHigh]);
  });

  it('выгрузка повторяет порядок экрана', async () => {
    const query = `direction=inbound&siteIds=${siteId}&q=SORT-&sort=totalSum&order=desc`;
    const list = await listIds(query);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/source-documents/export.xlsx?${query}`,
    });
    expect(res.statusCode).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const numbers: string[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // шапка
      const value = row.getCell(4).value; // «№ документа»
      if (typeof value === 'string' && value.startsWith('SORT-')) numbers.push(value);
    });
    // Файл обязан повторять экран: раньше схема экспорта не принимала sort и
    // выгрузка всегда шла по parsed_at desc.
    expect(numbers).toEqual(['SORT-3', 'SORT-2', 'SORT-1']);
    expect(list).toEqual([docSortHigh, docSortMid, docSortLow]);
  });

  it('поставка не разрывается между страницами', async () => {
    // Страница в три строки на выборке из пяти документов одной машины: режь
    // мы по документам, на первой оказалось бы три из пяти, а два уехали бы на
    // вторую — и связь между ними на экране терялась.
    const query = `direction=inbound&siteIds=${siteId}&q=PACK-&limit=3`;
    const first = await listIds(`${query}&offset=0`);
    expect(first).toHaveLength(5);
    expect(new Set(first)).toEqual(new Set(deliveryDocs));

    // Дальше страниц нет: вся поставка уместилась на первой.
    const second = await listIds(`${query}&offset=3`);
    expect(second).toEqual([]);
  });

  it('сортировка переставляет поставки целиком, а не документы по отдельности', async () => {
    // В выборке: поставка из пяти (суммы 7..35) и три одиночки (10, 20, 30).
    // Сортировка по убыванию суммы поставила бы одиночки МЕЖДУ документами
    // машины, если бы сортировала строки, а не поставки.
    const ids = await listIds(
      `direction=inbound&siteIds=${siteId}&sort=totalSum&order=desc&limit=50`,
    );
    const packPositions = deliveryDocs
      .map((id) => ids.indexOf(id))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
    expect(packPositions).toHaveLength(5);
    // Позиции идут подряд — машина осталась цельной.
    expect(packPositions[4]! - packPositions[0]!).toBe(4);
  });

  it('документ без пакета — сам себе поставка, а не общая куча', async () => {
    // У SORT-1..3 нет bundle_id. Если бы ключом поставки был NULL, они слиплись
    // бы в одну группу и всегда ходили вместе.
    const ids = await listIds(
      `direction=inbound&siteIds=${siteId}&q=SORT-&sort=totalSum&order=asc&limit=1&offset=1`,
    );
    expect(ids).toEqual([docSortMid]);
  });

  it('страницы покрывают выборку целиком, без потерь и повторов', async () => {
    const query = `direction=inbound&siteIds=${siteId}&limit=3`;
    const first = await app.inject({
      method: 'GET',
      url: `/api/v1/source-documents?${query}&offset=0`,
    });
    const { total, pageCount } = first.json() as { total: number; pageCount: number };

    const seen: string[] = [];
    for (let p = 0; p < pageCount; p++) {
      seen.push(...(await listIds(`${query}&offset=${p * 3}`)));
    }
    // Ни одна строка не потерялась между страницами и не показалась дважды.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(total);
  });

  it('кривая дата даёт 400, а не пятисотку из Postgres', async () => {
    const fields = ['docDateFrom', 'docDateTo', 'expectedDateFrom', 'expectedDateTo'];
    // Несуществующее число тоже отказ: `2026-02-30` проходит regex, но Date
    // молча превращает его во второе марта — фильтр отобрал бы другой день.
    const values = ['не-дата', '2026-02-30', '01.09.2026'];
    for (const field of fields) {
      for (const value of values) {
        for (const path of ['/api/v1/source-documents', '/api/v1/source-documents/export.xlsx']) {
          const res = await app.inject({
            method: 'GET',
            url: `${path}?direction=inbound&siteIds=${siteId}&${field}=${encodeURIComponent(value)}`,
          });
          expect(res.statusCode, `${path} ${field}=${value}`).toBe(400);
        }
      }
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
