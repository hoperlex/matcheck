/**
 * Номер, дата и суммы приёмки по УПД из ЭДО — на настоящем PostgreSQL.
 *
 * Обещания, которые проверяются базой, а не чтением кода:
 *   - `edoSummary` одиночного DTO и строки списка совпадают (одна сборка);
 *   - у приёмки без ЭДО поля нет — шапка и список как раньше;
 *   - число приёмок у общей УПД считает все приёмки, включая эту;
 *   - выгрузка «Принятые»: итог как в списке, под ним строки XML вместо факта
 *     пары, затем остаток факта; сумма строк сходится с итогом;
 *   - файл не прочитался — под итогом факт пары с причиной, итог из ЭДО;
 *   - приёмка без ЭДО в выгрузке — прежние строки, «Источник» = «факт».
 *
 * Запуск: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test
 * Без переменной набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EdoSummary } from '@matcheck/contracts';
import * as schema from '../../src/db/schema.js';
import type { Db } from '../../src/db/client.js';
import type { AuthUser } from '../../src/plugins/auth.js';
import type * as S3Signer from '../../src/domain/storage/s3.signer.js';

/** Файлы «хранилища» по ключу; нет ключа — чтение падает, как 404 у S3. */
const s3 = vi.hoisted(() => ({ files: new Map<string, Buffer>() }));

vi.mock('../../src/domain/storage/s3.signer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Signer>()),
  getObject: vi.fn(async (key: string) => {
    const file = s3.files.get(key);
    if (!file) throw new Error(`S3 GET ${key} failed: HTTP 404`);
    return file;
  }),
}));

const { deliveryRoutes } = await import('../../src/routes/deliveries.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const RUN = String(Date.now()).slice(-6);

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<Файл ИдФайл="ON_NSCHFDOPPR_SUM${RUN}" ВерсФорм="5.03">
  <Документ КНД="1115131" Функция="СЧФДОП">
    <СвСчФакт НомерДок="ИЗ-ФАЙЛА-${RUN}" ДатаДок="23.10.2031">
      <СвПрод><ИдСв><СвЮЛУч НаимОрг="ООО «Фаворит-Электро»" ИННЮЛ="7701677700" КПП="770101001"/></ИдСв></СвПрод>
    </СвСчФакт>
    <ТаблСчФакт>
      <СведТов НомСтр="1" НаимТов="Бирка кабельная У-136" НаимЕдИзм="упак" КолТов="45" ЦенаТов="128.79"
               СтТовБезНДС="5795.55" НалСт="22%" СтТовУчНал="7070.57">
        <СумНал><СумНал>1275.02</СумНал></СумНал>
      </СведТов>
      <СведТов НомСтр="2" НаимТов="Доставка" НаимЕдИзм="усл" КолТов="1" ЦенаТов="5827.73"
               СтТовБезНДС="5827.73" НалСт="22%" СтТовУчНал="7109.83">
        <СумНал><СумНал>1282.10</СумНал></СумНал>
      </СведТов>
      <ВсегоОпл СтТовБезНДСВсего="11623.28" СтТовУчНалВсего="14180.40"><СумНалВсего><СумНал>2557.12</СумНал></СумНалВсего></ВсегоОпл>
    </ТаблСчФакт>
  </Документ>
</Файл>`;

type DeliveryDto = { id: string; displayId: number; edoSummary?: EdoSummary };

suite('УПД из ЭДО: номер, дата и суммы приёмки (реальный PostgreSQL)', { timeout: 120_000 }, () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;

  const siteId = randomUUID();
  const managerId = randomUUID();
  const accountId = randomUUID();
  /** Скан A + УПД ЭДО в его блоке + ручная строка с ценой. */
  const mixedId = randomUUID();
  /** Только УПД из ЭДО, она же — у второй приёмки. */
  const edoOnlyId = randomUUID();
  const sharedId = randomUUID();
  /** Без ЭДО. */
  const plainId = randomUUID();
  const scanA = randomUUID();
  const edoDocA = randomUUID();
  const edoDocShared = randomUUID();
  const s3KeyA = `edo-export/test/${edoDocA}.xml`;

  const manager = {
    id: managerId,
    role: 'manager',
    siteId: null,
    contractorCustomerId: null,
    sessionId: randomUUID(),
  } as unknown as AuthUser;

  async function exportDoc(id: string, number: string, total: string, vat: string, s3Key: string) {
    await sql`INSERT INTO edo_export_documents
        (id, edo_account_id, message_id, entity_id, document_type, document_number, document_date,
         supplier_inn, supplier_name, total_sum, vat_sum, content_category,
         status, s3_key, content_sha256, size_bytes, received_at)
      VALUES (${id}, ${accountId}, ${`m-${id}`}, ${`e-${id}`},
              'UniversalTransferDocument', ${number}, '2031-10-23',
              '7701677700', 'ООО «Фаворит-Электро»', ${total}, ${vat},
              'materials', 'stored', ${s3Key}, ${id.replace(/-/g, '').padEnd(64, '0')},
              ${Buffer.byteLength(XML)}, '2031-10-23T09:00:00Z')`;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    const db = drizzle(sql, { schema, casing: 'snake_case' }) as unknown as Db;
    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', db as never);
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

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`ESM${RUN}`}, 'Суммы ЭДО')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
              VALUES (${managerId}, ${`esm-${managerId}@test`}, 'x', 'manager', NULL)`;
    await sql`INSERT INTO edo_accounts (id, provider, auth_mode, name, credentials_encrypted, box_id)
              VALUES (${accountId}, 'sbis', 'sbis_service_key', ${`СБИС ${RUN}`}, '{}', ${`esm-${RUN}`})`;
    // «Не оформлена»: журнал движений, который читает всю базу, такие приёмки
    // не считает, и строки с ценой здесь соседние наборы не сбивают.
    const statusId = (
      await sql<{ id: string }[]>`
        SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'not_filled' LIMIT 1`
    )[0]!.id;
    for (const id of [mixedId, edoOnlyId, sharedId, plainId]) {
      await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, arrived_at, version)
                VALUES (${id}, ${siteId}, ${managerId}, ${statusId}, '2031-10-24T07:00:00Z', 1)`;
    }

    // Скан A: итог распознан с ошибкой (1 000 вместо 14 180,40).
    await sql`INSERT INTO source_documents
                (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum, vat_sum)
              VALUES (${scanA}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId},
                      ${`СКАН-${RUN}`}, '2031-10-23', 1000.00, NULL)`;
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id)
              VALUES (${mixedId}, ${scanA})`;
    await sql`INSERT INTO delivery_items
                (id, delivery_id, name_raw, qty_actual, unit, price, vat_sum, line_no, source_document_id)
              VALUES (${randomUUID()}, ${mixedId}, 'Бирка (факт скана)', 45, 'упак', 10.00, 99.00, 1, ${scanA}),
                     (${randomUUID()}, ${mixedId}, 'Ручная строка', 2, 'шт', 50.00, 22.00, 2, NULL),
                     (${randomUUID()}, ${plainId}, 'Без ЭДО', 3, 'шт', 100.00, 66.00, 1, NULL)`;

    await exportDoc(edoDocA, `РЕЕСТР-${RUN}-1`, '14180.40', '2557.12', s3KeyA);
    s3.files.set(s3KeyA, Buffer.from(XML, 'utf8'));
    await exportDoc(
      edoDocShared,
      `РЕЕСТР-${RUN}-2`,
      '2650.00',
      '477.87',
      `edo-export/test/${edoDocShared}.xml`,
    );
    s3.files.set(`edo-export/test/${edoDocShared}.xml`, Buffer.from(XML, 'utf8'));

    await sql`INSERT INTO delivery_edo_matches
                (id, delivery_id, export_document_id, linked_by_user_id, section_document_id)
              VALUES (${randomUUID()}, ${mixedId}, ${edoDocA}, ${managerId}, ${scanA}),
                     (${randomUUID()}, ${edoOnlyId}, ${edoDocShared}, ${managerId}, NULL),
                     (${randomUUID()}, ${sharedId}, ${edoDocShared}, ${managerId}, NULL)`;
  });

  afterAll(async () => {
    if (!sql) return;
    await app.close();
    const ids = [mixedId, edoOnlyId, sharedId, plainId];
    await sql`DELETE FROM delivery_edo_matches WHERE delivery_id = ANY(${ids})`;
    await sql`DELETE FROM delivery_sources WHERE delivery_id = ANY(${ids})`;
    await sql`DELETE FROM delivery_items WHERE delivery_id = ANY(${ids})`;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_documents WHERE id = ${scanA}`;
    await sql`DELETE FROM edo_export_documents WHERE edo_account_id = ${accountId}`;
    await sql`DELETE FROM edo_accounts WHERE id = ${accountId}`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  async function listRows(): Promise<DeliveryDto[]> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/deliveries?siteIds=${siteId}&limit=200`,
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { items: DeliveryDto[] }).items;
  }

  async function single(id: string): Promise<DeliveryDto> {
    const res = await app.inject({ method: 'GET', url: `/api/v1/deliveries/${id}` });
    expect(res.statusCode).toBe(200);
    return res.json() as DeliveryDto;
  }

  type SheetRow = { level: number; values: Record<string, unknown> };

  /** Строки выгрузки по подписям колонок: итог приёмки и строки под ним. */
  async function exportRows(): Promise<Map<number, { top: SheetRow; lines: SheetRow[] }>> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/deliveries/export.xlsx?siteIds=${siteId}`,
    });
    expect(res.statusCode).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const headers: string[] = [];
    ws.getRow(1).eachCell((cell, col) => {
      headers[col] = String(cell.value);
    });
    const byDisplayId = new Map<number, { top: SheetRow; lines: SheetRow[] }>();
    let current: { top: SheetRow; lines: SheetRow[] } | null = null;
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const values: Record<string, unknown> = {};
      row.eachCell((cell, col) => {
        values[headers[col]!] = cell.value;
      });
      const sheetRow = { level: row.outlineLevel ?? 0, values };
      if (sheetRow.level === 0) {
        current = { top: sheetRow, lines: [] };
        byDisplayId.set(values['id'] as number, current);
      } else {
        current!.lines.push(sheetRow);
      }
    });
    return byDisplayId;
  }

  it('DTO: одиночный путь и строка списка дают один edoSummary; без ЭДО поля нет', async () => {
    const rows = await listRows();
    const mixedRow = rows.find((r) => r.id === mixedId)!;
    const mixedSingle = await single(mixedId);
    expect(mixedRow.edoSummary).toEqual(mixedSingle.edoSummary);

    const summary = mixedSingle.edoSummary!;
    expect(summary.documents).toHaveLength(1);
    expect(summary.documents[0]).toMatchObject({
      pairedSourceDocumentId: scanA,
      pairedBy: 'section',
      operator: 'sbis',
      docNumber: `РЕЕСТР-${RUN}-1`,
      docDate: '2031-10-23',
      deliveryCount: 1,
      replacesFact: true,
    });
    expect(summary.header).toEqual({
      total: 14180.4,
      known: 1,
      count: 1,
      source: 'edo',
      comparison: { edo: 14180.4, scan: 1000, mismatch: true },
    });
    // Без НДС: УПД 11 623,28 + ручная строка 2 × 50; НДС: 2 557,12 + 22.
    expect(summary.list).toMatchObject({ source: 'mixed', vat: 2579.12, edoExVat: 11623.28 });
    expect(summary.list.exVat).toBeCloseTo(11723.28, 6);

    expect(rows.find((r) => r.id === plainId)!.edoSummary).toBeUndefined();
    expect((await single(plainId)).edoSummary).toBeUndefined();
  });

  it('общая УПД: число приёмок — все, включая эту', async () => {
    const summary = (await single(edoOnlyId)).edoSummary!;
    expect(summary.documents[0]!.deliveryCount).toBe(2);
    expect(summary.sharedMax).toBe(2);
    expect(summary.header).toMatchObject({ total: 2650, source: 'edo', comparison: null });
    expect(summary.list).toMatchObject({ exVat: 2172.13, vat: 477.87, source: 'edo' });
  });

  it('выгрузка: итог как в списке, под ним строки XML и остаток факта', async () => {
    const rows = await listRows();
    const mixed = rows.find((r) => r.id === mixedId)!;
    const plain = rows.find((r) => r.id === plainId)!;
    const sheet = await exportRows();

    const m = sheet.get(mixed.displayId)!;
    expect(m.top.values['Сумма']).toBeCloseTo(mixed.edoSummary!.list.exVat!, 6);
    expect(m.top.values['Сумма НДС']).toBeCloseTo(mixed.edoSummary!.list.vat!, 6);
    expect(m.top.values['Источник']).toBe('ЭДО + факт');
    expect(m.top.values['№ УПД']).toBe(`РЕЕСТР-${RUN}-1`);
    expect(m.lines.map((l) => [l.values['Наименование'], l.values['Источник']])).toEqual([
      ['Бирка кабельная У-136', `ЭДО (СБИС) № РЕЕСТР-${RUN}-1`],
      ['Доставка', `ЭДО (СБИС) № РЕЕСТР-${RUN}-1`],
      ['Ручная строка', 'факт'],
    ]);
    const linesSum = m.lines.reduce((sum, l) => sum + Number(l.values['Сумма'] ?? 0), 0);
    expect(linesSum).toBeCloseTo(Number(m.top.values['Сумма']), 6);
    // Строка УПД: количество по документу — в «План», «Факт» пуст.
    expect(m.lines[0]!.values['План']).toBe(45);
    expect(m.lines[0]!.values['Факт']).toBeUndefined();

    // Без ЭДО — как раньше, только с «Источником».
    const p = sheet.get(plain.displayId)!;
    expect(p.top.values['Сумма']).toBe(300);
    expect(p.top.values['Источник']).toBe('факт');
    expect(p.lines.map((l) => l.values['Источник'])).toEqual(['факт']);
  });

  it('выгрузка: файл УПД не прочитался — факт пары с причиной, итог из ЭДО', async () => {
    const file = s3.files.get(s3KeyA)!;
    s3.files.delete(s3KeyA);
    try {
      const mixed = (await listRows()).find((r) => r.id === mixedId)!;
      const m = (await exportRows()).get(mixed.displayId)!;
      expect(m.top.values['Сумма']).toBeCloseTo(11723.28, 6);
      expect(m.lines.map((l) => [l.values['Наименование'], l.values['Источник']])).toEqual([
        ['Бирка (факт скана)', 'факт: строки ЭДО не прочитаны: файл не получен из хранилища'],
        ['Ручная строка', 'факт'],
      ]);
    } finally {
      s3.files.set(s3KeyA, file);
    }
  });
});
