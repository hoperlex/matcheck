/**
 * Подбор УПД из ЭДО к приёмке — на настоящем PostgreSQL.
 *
 * Обещания, которые проверяются базой, а не чтением кода:
 *   - нужная УПД находится по номеру, даже когда в окне дат сотни чужих;
 *   - битый ИНН бумажной УПД не мешает: поиск идёт по номеру и названию;
 *   - фото-эталон работает без бумажной УПД, «сильное» — только с ИНН и полным номером;
 *   - квоты не молчат: упёрлись — в ответе `truncated`;
 *   - ручной поиск ставит точный номер выше близости даты;
 *   - привязка не меняет ни версии, ни позиций приёмки.
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
import * as schema from '../../src/db/schema.js';
import type { Db } from '../../src/db/client.js';
import { QUOTA, findEdoCandidates } from '../../src/domain/operations/edo-candidates.js';
import type { AuthUser } from '../../src/plugins/auth.js';
import type * as S3Signer from '../../src/domain/storage/s3.signer.js';

const PREVIEW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Файл ИдФайл="ON_NSCHFDOPPR" ВерсФорм="5.03">
  <Документ КНД="1115131" Функция="СЧФДОП">
    <СвСчФакт НомерДок="Т31-PREVIEW" ДатаДок="10.03.2031">
      <СвПрод><ИдСв><СвЮЛУч НаимОрг="ООО «Терма Альянс»" ИННЮЛ="5009091604" КПП="500901001"/></ИдСв></СвПрод>
    </СвСчФакт>
    <ТаблСчФакт>
      <СведТов НомСтр="1" НаимТов="Труба ПП 20" НаимЕдИзм="м" КолТов="40" ЦенаТов="50"
               СтТовБезНДС="2000" НалСт="20%" СтТовУчНал="2400">
        <СумНал><СумНал>400</СумНал></СумНал>
        <ДопСведТов ПрТовРаб="1"/>
      </СведТов>
      <ВсегоОпл СтТовБезНДСВсего="2000" СтТовУчНалВсего="2400"><СумНалВсего><СумНал>400</СумНал></СумНалВсего></ВсегоОпл>
    </ТаблСчФакт>
  </Документ>
</Файл>`;

vi.mock('../../src/domain/storage/s3.signer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Signer>()),
  getObject: vi.fn(async () => Buffer.from(PREVIEW_XML, 'utf8')),
}));

const { deliveryRoutes } = await import('../../src/routes/deliveries.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** ИНН юрлица с верной контрольной цифрой. */
function inn10(prefix9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const digits = [...prefix9].map(Number);
  return prefix9 + String((weights.reduce((acc, w, i) => acc + w * digits[i]!, 0) % 11) % 10);
}

const RUN = String(Date.now()).slice(-6);
const TERMA_INN = inn10(`31${RUN}1`);
const PHOTO_INN = inn10(`31${RUN}2`);
const BULK_INN = inn10(`31${RUN}3`);
const ABSENT_INN = inn10(`31${RUN}4`);
const FILLER_INN = inn10(`31${RUN}5`);
/** Тот же ИНН с ошибкой в цифре — как у бумажной УПД 19134. */
const BROKEN_INN = `${TERMA_INN.slice(0, 9)}${(Number(TERMA_INN[9]) + 1) % 10}`;

const NUMBER = `Т31-${RUN}-11`;
const ANCHOR = '2031-03-10';

suite('подбор УПД из ЭДО к приёмке (реальный PostgreSQL)', { timeout: 120_000 }, () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let db: Db;

  const siteId = randomUUID();
  const managerId = randomUUID();
  const accountId = randomUUID();
  const brokenDirectoryId = randomUUID();
  const photoSupplierId = randomUUID();
  const bulkSupplierId = randomUUID();
  const absentSupplierId = randomUUID();
  const paperDocId = randomUUID();

  const paperDelivery = randomUUID(); // бумажная УПД с битым ИНН
  const photoDelivery = randomUUID(); // только фото, поставщик у приёмки
  const bulkDelivery = randomUUID(); // ИНН без номера, документов больше квоты
  const absentDelivery = randomUUID(); // ИНН, которого нет в реестре
  const bareDelivery = randomUUID(); // ни номера, ни поставщика

  const targetId = randomUUID();
  const photoExactId = randomUUID();
  const photoCoreId = randomUUID();
  const searchExactId = randomUUID();

  const manager = { id: managerId, role: 'manager', siteId: null } as unknown as AuthUser;

  async function exportDoc(o: {
    id?: string;
    number: string;
    date: string;
    inn: string;
    name: string;
    sum: string;
  }): Promise<string> {
    const id = o.id ?? randomUUID();
    await sql`INSERT INTO edo_export_documents
        (id, edo_account_id, message_id, entity_id, document_type, document_number, document_date,
         supplier_inn, supplier_name, total_sum, content_category, status, s3_key, content_sha256,
         received_at)
      VALUES (${id}, ${accountId}, ${`m-${id}`}, ${`e-${id}`}, 'UniversalTransferDocument',
              ${o.number}, ${o.date}, ${o.inn}, ${o.name}, ${o.sum}, 'materials', 'stored',
              ${`edo-export/test/${id}.xml`}, ${id.replace(/-/g, '').padEnd(64, '0')},
              ${`${o.date}T09:00:00Z`})`;
    return id;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql, { schema, casing: 'snake_case' }) as unknown as Db;
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

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`EDO${RUN}`}, 'Подбор ЭДО')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
              VALUES (${managerId}, ${`edo-${managerId}@test`}, 'x', 'manager', NULL)`;
    await sql`INSERT INTO edo_accounts (id, name, credentials_encrypted, box_id)
              VALUES (${accountId}, ${`ЭДО ${RUN}`}, '{}', ${`box-${RUN}`})`;
    await sql`INSERT INTO suppliers (id, inn, name) VALUES (${brokenDirectoryId}, ${BROKEN_INN}, 'Терма Альянс')`;
    for (const [id, inn, name] of [
      [photoSupplierId, PHOTO_INN, 'ООО «Фото-поставщик»'],
      [bulkSupplierId, BULK_INN, 'ООО «Оптовик»'],
      [absentSupplierId, ABSENT_INN, 'ООО «Без ЭДО»'],
    ] as const) {
      await sql`INSERT INTO counterparties (id, inn, name, is_supplier) VALUES (${id}, ${inn}, ${name}, true)`;
    }

    const statusId = (
      await sql<{ id: string }[]>`
        SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`
    )[0]!.id;
    const seed = async (id: string, supplier: string | null) => {
      await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, supplier_id, arrived_at, version)
                VALUES (${id}, ${siteId}, ${managerId}, ${statusId}, ${supplier},
                        ${`${ANCHOR}T07:00:00Z`}, 3)`;
    };
    await seed(paperDelivery, null);
    await seed(photoDelivery, photoSupplierId);
    await seed(bulkDelivery, bulkSupplierId);
    await seed(absentDelivery, absentSupplierId);
    await seed(bareDelivery, null);
    await sql`INSERT INTO delivery_items (id, delivery_id, name_raw, qty_actual, unit, line_no)
              VALUES (${randomUUID()}, ${paperDelivery}, 'Труба ПП 20', 40, 'м', 1)`;

    // Бумажная УПД 19134: верный номер, битый ИНН и такая же запись справочника.
    await sql`INSERT INTO source_documents
                (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum,
                 supplier_inn_raw, supplier_directory_id)
              VALUES (${paperDocId}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId},
                      ${NUMBER}, ${ANCHOR}, 100.00, ${BROKEN_INN}, ${brokenDirectoryId})`;
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id)
              VALUES (${paperDelivery}, ${paperDocId})`;

    // Нужная УПД и соседи по серии того же поставщика.
    await exportDoc({ id: targetId, number: NUMBER, date: ANCHOR, inn: TERMA_INN, name: 'ООО «Терма Альянс»', sum: '100.00' });
    for (const suffix of ['1', '10']) {
      await exportDoc({ number: `Т31-${RUN}-${suffix}`, date: ANCHOR, inn: TERMA_INN, name: 'ООО «Терма Альянс»', sum: '200.00' });
    }
    // 520 чужих УПД позже нужной — прежний LIMIT 500 по дате убыв. её отсекал.
    await sql`INSERT INTO edo_export_documents
        (edo_account_id, message_id, entity_id, document_type, document_number, document_date,
         supplier_inn, supplier_name, total_sum, content_category, status, s3_key, content_sha256,
         received_at)
      SELECT ${accountId}, 'fill-' || ${RUN} || '-' || g, 'e', 'UniversalTransferDocument',
             'F-' || ${RUN} || '-' || g, (date '2031-03-11' + (g % 25))::timestamp,
             ${FILLER_INN}, 'ООО «Чужой»', 999.00, 'materials', 'stored',
             'edo-export/test/fill-' || g, lpad(g::text, 64, '0'), now()
        FROM generate_series(1, 520) g`;

    // Фото-приёмка: две страницы одной УПД; в реестре — тот же номер и номер по цифрам.
    for (const page of ['111.00', '222.00']) {
      const photoId = randomUUID();
      await sql`INSERT INTO delivery_photos (id, delivery_id, kind, stage, s3_key, content_hash)
                VALUES (${photoId}, ${photoDelivery}, 'document', 'before', ${`test/${photoId}.jpg`},
                        ${randomUUID().replace(/-/g, '')})`;
      await sql`INSERT INTO photo_recognized_items (id, delivery_photo_id, parser, doc_number, doc_date, total_sum)
                VALUES (${randomUUID()}, ${photoId}, 'upd_vision', ${`УТ-${RUN}7`}, ${ANCHOR}, ${page})`;
    }
    await exportDoc({ id: photoExactId, number: `УТ-${RUN}7`, date: ANCHOR, inn: PHOTO_INN, name: 'ООО «Фото-поставщик»', sum: '333.00' });
    await exportDoc({ id: photoCoreId, number: `${RUN}7`, date: ANCHOR, inn: PHOTO_INN, name: 'ООО «Фото-поставщик»', sum: '333.00' });

    // ИНН без номера, документов больше квоты.
    await sql`INSERT INTO edo_export_documents
        (edo_account_id, message_id, entity_id, document_type, document_number, document_date,
         supplier_inn, supplier_name, total_sum, content_category, status, s3_key, content_sha256,
         received_at)
      SELECT ${accountId}, 'bulk-' || ${RUN} || '-' || g, 'e', 'UniversalTransferDocument',
             'B-' || ${RUN} || '-' || g, (date '2031-03-01' + (g % 20))::timestamp,
             ${BULK_INN}, 'ООО «Оптовик»', 10.00, 'materials', 'stored',
             'edo-export/test/bulk-' || g, lpad(g::text, 64, '0'), now()
        FROM generate_series(1, ${QUOTA.inn + 20}) g`;

    // Ручной поиск: 210 похожих номеров рядом с датой и один точный — далеко.
    await sql`INSERT INTO edo_export_documents
        (edo_account_id, message_id, entity_id, document_type, document_number, document_date,
         supplier_inn, supplier_name, total_sum, content_category, status, s3_key, content_sha256,
         received_at)
      SELECT ${accountId}, 'q-' || ${RUN} || '-' || g, 'e', 'UniversalTransferDocument',
             'Q' || ${RUN} || '-' || g, ${ANCHOR}::timestamp,
             ${FILLER_INN}, 'ООО «Чужой»', 1.00, 'materials', 'stored',
             'edo-export/test/q-' || g, lpad(g::text, 64, '0'), now()
        FROM generate_series(1, 210) g`;
    await exportDoc({ id: searchExactId, number: `Q${RUN}`, date: '2030-06-01', inn: FILLER_INN, name: 'ООО «Чужой»', sum: '1.00' });
  });

  afterAll(async () => {
    if (!sql) return;
    await app.close();
    await sql`DELETE FROM delivery_edo_matches WHERE delivery_id IN (SELECT id FROM deliveries WHERE site_id = ${siteId})`;
    await sql`DELETE FROM edo_export_documents WHERE edo_account_id = ${accountId}`;
    await sql`DELETE FROM delivery_sources WHERE source_document_id = ${paperDocId}`;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_documents WHERE id = ${paperDocId}`;
    await sql`DELETE FROM counterparties WHERE id IN (${photoSupplierId}, ${bulkSupplierId}, ${absentSupplierId})`;
    await sql`DELETE FROM suppliers WHERE id = ${brokenDirectoryId}`;
    await sql`DELETE FROM edo_accounts WHERE id = ${accountId}`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  it('битый ИНН бумажной УПД: нужная УПД первой по номеру и названию, среди сотен чужих', async () => {
    const result = (await findEdoCandidates(db, paperDelivery))!;
    const [first] = result.items;
    expect(first?.id).toBe(targetId);
    expect(first?.foundBy).toEqual(expect.arrayContaining(['number', 'name']));
    expect(first?.level).toBe('possible'); // без проверенного ИНН — не «сильное»
    expect(first?.matches).toEqual(expect.arrayContaining(['номер УПД', 'дата документа', 'название поставщика', 'сумма']));
    // Соседи по серии — ниже и с расхождением номера; чужие 520 не набежали.
    const neighbours = result.items.slice(1);
    expect(neighbours).toHaveLength(2);
    for (const item of neighbours) expect(item.conflicts).toContain('номер УПД отличается');
    expect(result.diagnostics.innUnreadable).toBe(true);
    expect(result.referenceMissing).toContain('ИНН поставщика (не проходит проверку)');
    expect(result.truncated).toEqual([]);
  });

  it('фото-приёмка: полный номер + ИНН + дата — «сильное», совпадение по цифрам — «проверьте»', async () => {
    const result = (await findEdoCandidates(db, photoDelivery))!;
    const exact = result.items.find((item) => item.id === photoExactId);
    const core = result.items.find((item) => item.id === photoCoreId);
    expect(result.items[0]?.id).toBe(photoExactId);
    expect(exact?.level).toBe('high');
    expect(exact?.reference.origin).toBe('photo');
    expect(core?.level).toBe('possible');
    expect(core?.matches).toContain('номер совпал по цифрам');
  });

  it('квота по ИНН: показано не больше квоты и признак усечения в ответе', async () => {
    const result = (await findEdoCandidates(db, bulkDelivery))!;
    expect(result.items).toHaveLength(QUOTA.inn);
    expect(result.truncated).toContain('inn');
  });

  it('ручной поиск: точный номер выше двухсот похожих рядом по дате', async () => {
    const result = (await findEdoCandidates(db, paperDelivery, { q: `Q${RUN}` }))!;
    expect(result.items[0]?.id).toBe(searchExactId);
    expect(result.items).toHaveLength(QUOTA.search);
    expect(result.truncated).toContain('search');
  });

  it('диагностика: ИНН, которого нет в реестре, и подбор только по дате', async () => {
    const absent = (await findEdoCandidates(db, absentDelivery))!;
    expect(absent.diagnostics.innsAbsentInRegistry).toEqual([ABSENT_INN]);
    expect(absent.diagnostics.registryReceivedUntil).not.toBeNull();
    const bare = (await findEdoCandidates(db, bareDelivery))!;
    expect(bare.diagnostics.dateOnly).toBe(true);
    expect(bare.items.length).toBeLessThanOrEqual(QUOTA.date);
  });

  it('маршрут: подбор, просмотр, привязка и отвязка не трогают приёмку', async () => {
    const before = await sql<{ version: number; items: number }[]>`
      SELECT version, (SELECT count(*)::int FROM delivery_items WHERE delivery_id = ${paperDelivery}) AS items
        FROM deliveries WHERE id = ${paperDelivery}`;

    const list = await app.inject({ method: 'GET', url: `/api/v1/deliveries/${paperDelivery}/edo-candidates` });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: { id: string }[] }).items[0]?.id).toBe(targetId);

    const preview = await app.inject({
      method: 'GET',
      url: `/api/v1/deliveries/${paperDelivery}/edo-candidates/export/${targetId}/preview`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      docNumber: 'Т31-PREVIEW',
      docDate: '2031-03-10',
      items: [{ lineNo: 1, nameRaw: 'Труба ПП 20', qty: 40 }],
    });

    const link = await app.inject({
      method: 'POST',
      url: `/api/v1/deliveries/${paperDelivery}/edo-matches`,
      payload: { documentId: targetId, source: 'export' },
    });
    expect(link.statusCode).toBe(200);
    const again = await app.inject({ method: 'GET', url: `/api/v1/deliveries/${paperDelivery}/edo-candidates` });
    expect((again.json() as { items: { id: string }[] }).items.map((i) => i.id)).not.toContain(targetId);

    const linked = await app.inject({ method: 'GET', url: `/api/v1/deliveries/${paperDelivery}/edo-matches` });
    const [match] = (linked.json() as { items: { id: string; documentId: string }[] }).items;
    expect(match?.documentId).toBe(targetId);
    const unlink = await app.inject({
      method: 'DELETE',
      url: `/api/v1/deliveries/${paperDelivery}/edo-matches/${match!.id}`,
    });
    expect(unlink.statusCode).toBe(200);

    const after = await sql<{ version: number; items: number }[]>`
      SELECT version, (SELECT count(*)::int FROM delivery_items WHERE delivery_id = ${paperDelivery}) AS items
        FROM deliveries WHERE id = ${paperDelivery}`;
    expect(after).toEqual(before);
  });
});
