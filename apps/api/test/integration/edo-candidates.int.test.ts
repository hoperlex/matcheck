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
import { UPD_PDF_MAX_XML_BYTES } from '../../src/domain/edo/upd-review-pdf.js';
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
  presign: vi.fn(async ({ key }: { key: string }) => `https://s3.test/${key}?signed`),
}));

const { deliveryRoutes } = await import('../../src/routes/deliveries.js');
const { getObject } = await import('../../src/domain/storage/s3.signer.js');

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
/** Приёмка 19507: свой поставщик и чужой с теми же цифрами номера. */
const OWN_INN = inn10(`31${RUN}6`);
const STRANGER_INN = inn10(`31${RUN}7`);
/** ИНН владельца ящика ЭДО — в графе поставщика это прочитанный ИНН покупателя. */
const ORG_INN = inn10(`31${RUN}8`);
const REAL_INN = inn10(`31${RUN}9`);
// Ноль после RUN: ядро таких номеров не совпадёт с наполнителями «F-RUN-g».
const OWN_NUMBER = `ТК-${RUN}0055`;
const ORG_NUMBER = `Р-${RUN}0066`;
const LATE_NUMBER = `Л-${RUN}0077`;
const LATE_DATE = '2032-01-15';

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
  const strangerDelivery = randomUUID(); // в реестре — чужой поставщик с теми же цифрами
  const orgDelivery = randomUUID(); // в графе поставщика ИНН владельца ящика
  const lateDelivery = randomUUID(); // УПД датирована позже реестра
  const ownDocId = randomUUID();
  const orgDocId = randomUUID();
  const lateDocId = randomUUID();

  const targetId = randomUUID();
  const ownExactId = randomUUID();
  const strangerId = randomUUID();
  const orgTargetId = randomUUID();
  const photoExactId = randomUUID();
  const photoCoreId = randomUUID();
  const searchExactId = randomUUID();

  const manager = { id: managerId, role: 'manager', siteId: null } as unknown as AuthUser;
  /** Кем представляется запрос к маршрутам; по умолчанию — менеджер. */
  let currentUser: AuthUser = manager;

  async function exportDoc(o: {
    id?: string;
    number: string;
    date: string;
    inn: string;
    name: string;
    sum: string;
    category?: string | null;
    sizeBytes?: number | null;
    failed?: boolean;
  }): Promise<string> {
    const id = o.id ?? randomUUID();
    const category = o.category === undefined ? 'materials' : o.category;
    await sql`INSERT INTO edo_export_documents
        (id, edo_account_id, message_id, entity_id, document_type, document_number, document_date,
         supplier_inn, supplier_name, total_sum, content_category, status, s3_key, content_sha256,
         size_bytes, received_at)
      VALUES (${id}, ${accountId}, ${`m-${id}`}, ${`e-${id}`}, 'UniversalTransferDocument',
              ${o.number}, ${o.date}, ${o.inn}, ${o.name}, ${o.sum}, ${category},
              ${o.failed ? 'failed' : 'stored'},
              ${o.failed ? null : `edo-export/test/${id}.xml`},
              ${o.failed ? null : id.replace(/-/g, '').padEnd(64, '0')},
              ${o.sizeBytes ?? null}, ${`${o.date}T09:00:00Z`})`;
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
      req.user = currentUser;
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
    await sql`INSERT INTO edo_accounts (id, name, credentials_encrypted, box_id, org_inn)
              VALUES (${accountId}, ${`ЭДО ${RUN}`}, '{}', ${`box-${RUN}`}, ${ORG_INN})`;
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

    // Бумажные УПД для проверки «чужого поставщика», ИНН владельца ящика и даты позже реестра.
    await seed(strangerDelivery, null);
    await seed(orgDelivery, null);
    await seed(lateDelivery, null);
    for (const [docId, deliveryId, number, date, inn] of [
      [ownDocId, strangerDelivery, OWN_NUMBER, ANCHOR, OWN_INN],
      [orgDocId, orgDelivery, ORG_NUMBER, ANCHOR, ORG_INN],
      [lateDocId, lateDelivery, LATE_NUMBER, LATE_DATE, OWN_INN],
    ] as const) {
      await sql`INSERT INTO source_documents
                  (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum, supplier_inn_raw)
                VALUES (${docId}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId},
                        ${number}, ${date}, 500.00, ${inn})`;
      await sql`INSERT INTO delivery_sources (delivery_id, source_document_id)
                VALUES (${deliveryId}, ${docId})`;
    }
    await exportDoc({ id: ownExactId, number: OWN_NUMBER, date: ANCHOR, inn: OWN_INN, name: 'ООО «Свой»', sum: '500.00' });
    await exportDoc({ id: strangerId, number: `УТ-${RUN}0055`, date: '2031-03-01', inn: STRANGER_INN, name: 'ООО «Чужой с тем же номером»', sum: '77.00' });
    await exportDoc({ id: orgTargetId, number: ORG_NUMBER, date: ANCHOR, inn: REAL_INN, name: 'ООО «Настоящий»', sum: '500.00' });
  });

  afterAll(async () => {
    if (!sql) return;
    await app.close();
    await sql`DELETE FROM delivery_edo_matches WHERE delivery_id IN (SELECT id FROM deliveries WHERE site_id = ${siteId})`;
    await sql`DELETE FROM edo_export_documents WHERE edo_account_id = ${accountId}`;
    const docIds = [paperDocId, ownDocId, orgDocId, lateDocId];
    await sql`DELETE FROM delivery_sources WHERE source_document_id IN ${sql(docIds)}`;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_documents WHERE id IN ${sql(docIds)}`;
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

  it('чужой поставщик с теми же цифрами номера — «мало совпадений» и признак в ответе', async () => {
    const result = (await findEdoCandidates(db, strangerDelivery))!;
    const own = result.items.find((item) => item.id === ownExactId);
    const stranger = result.items.find((item) => item.id === strangerId);
    expect(result.items[0]?.id).toBe(ownExactId);
    expect(own).toMatchObject({ level: 'high', otherSupplier: false });
    expect(own?.supplierCheck.matchedInn).toBe(OWN_INN);
    expect(stranger).toMatchObject({ level: 'weak', otherSupplier: true });
    expect(stranger?.supplierCheck).toEqual({
      documentInns: [STRANGER_INN],
      referenceInns: [OWN_INN],
      matchedInn: null,
    });
  });

  it('ИНН владельца ящика в графе поставщика — не ИНН поставщика', async () => {
    const result = (await findEdoCandidates(db, orgDelivery))!;
    const target = result.items.find((item) => item.id === orgTargetId);
    // С ИНН владельца в эталоне правильная УПД стала бы «чужой».
    expect(target).toMatchObject({ otherSupplier: false, level: 'possible' });
    expect(target?.supplierCheck.referenceInns).toEqual([]);
    expect(result.diagnostics.innUnreadable).toBe(true);
    expect(result.diagnostics.innsAbsentInRegistry).toEqual([]);
  });

  it('эталон позже последнего получения в реестре — в диагностике, ровесники — нет', async () => {
    const late = (await findEdoCandidates(db, lateDelivery))!;
    expect(late.diagnostics.referencesAfterRegistry).toEqual([
      { label: LATE_NUMBER, date: LATE_DATE },
    ]);
    // УПД реестра получены 10.03.2031 — бумажная того же дня могла успеть.
    const sameDay = (await findEdoCandidates(db, paperDelivery))!;
    expect(sameDay.diagnostics.referencesAfterRegistry).toEqual([]);
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

  it('файл из реестра (/file): ссылка на XML; нехранимый, чужой состав и неизвестный — 404', async () => {
    const fileUrl = (id: string, delivery = paperDelivery) =>
      `/api/v1/deliveries/${delivery}/edo-candidates/export/${id}/file`;
    const ok = await app.inject({ method: 'GET', url: fileUrl(targetId) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      url: `https://s3.test/edo-export/test/${targetId}.xml?signed`,
      filename: `${targetId}.xml`,
      mimeType: 'application/xml',
    });

    const doc = { date: ANCHOR, inn: FILLER_INN, name: 'ООО «Чужой»', sum: '1.00' };
    const undetermined = await exportDoc({
      ...doc,
      number: `X-${RUN}-U`,
      category: 'undetermined',
    });
    const uncategorized = await exportDoc({ ...doc, number: `X-${RUN}-N`, category: null });
    for (const id of [undetermined, uncategorized]) {
      expect((await app.inject({ method: 'GET', url: fileUrl(id) })).statusCode).toBe(200);
    }

    const failed = await exportDoc({ ...doc, number: `X-${RUN}-F`, failed: true });
    const services = await exportDoc({ ...doc, number: `X-${RUN}-S`, category: 'services' });
    for (const id of [failed, services, randomUUID()]) {
      const res = await app.inject({ method: 'GET', url: fileUrl(id) });
      expect(res.statusCode).toBe(404);
    }
    const noDelivery = await app.inject({ method: 'GET', url: fileUrl(targetId, randomUUID()) });
    expect(noDelivery.statusCode).toBe(404);
  });

  it('PDF из реестра (/pdf): доступ как у /file, лимиты до чтения S3, у каждой ошибки есть текст', async () => {
    const pdfUrl = (id: string, delivery = paperDelivery) =>
      `/api/v1/deliveries/${delivery}/edo-candidates/export/${id}/pdf`;
    const get = (id: string, delivery?: string) =>
      app.inject({ method: 'GET', url: pdfUrl(id, delivery) });
    const doc = { date: ANCHOR, inn: FILLER_INN, name: 'ООО «Чужой»', sum: '1.00' };
    const sized = await exportDoc({ ...doc, number: `P-${RUN}-1`, sizeBytes: 2048 });

    const ok = await get(sized);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('application/pdf');
    expect(ok.headers['content-disposition']).toBe(
      `inline; filename*=UTF-8''${encodeURIComponent('УПД_Т31-PREVIEW.pdf')}`,
    );
    expect(ok.headers['cache-control']).toBe('private, max-age=600');
    expect(ok.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // Привязана к другой приёмке: подбор её больше не покажет, но открыть можно —
    // правила выбора кандидата не ограничивают чтение.
    const link = await app.inject({
      method: 'POST',
      url: `/api/v1/deliveries/${bareDelivery}/edo-matches`,
      payload: { documentId: sized, source: 'export' },
    });
    expect(link.statusCode).toBe(200);
    expect((await get(sized)).statusCode).toBe(200);

    const failed = await exportDoc({ ...doc, number: `P-${RUN}-F`, failed: true });
    const services = await exportDoc({
      ...doc,
      number: `P-${RUN}-S`,
      category: 'services',
      sizeBytes: 2048,
    });
    for (const [id, delivery] of [
      [failed, paperDelivery],
      [services, paperDelivery],
      [randomUUID(), paperDelivery],
      [sized, randomUUID()],
    ] as const) {
      const res = await get(id, delivery);
      expect(res.statusCode).toBe(404);
      expect((res.json() as { message?: string }).message).toBeTruthy();
    }

    // Размер из реестра проверяется ДО чтения: S3 не трогаем вовсе.
    vi.mocked(getObject).mockClear();
    const unknownSize = await exportDoc({ ...doc, number: `P-${RUN}-0` });
    const huge = await exportDoc({
      ...doc,
      number: `P-${RUN}-H`,
      sizeBytes: UPD_PDF_MAX_XML_BYTES + 1,
    });
    const noSize = await get(unknownSize);
    expect(noSize.statusCode).toBe(413);
    expect(noSize.json()).toMatchObject({ error: 'size_unknown' });
    const tooBig = await get(huge);
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json()).toMatchObject({ error: 'too_large' });
    expect(getObject).not.toHaveBeenCalled();

    // Сбой S3, не разобранный XML и объект больше, чем записано в реестре.
    vi.mocked(getObject).mockRejectedValueOnce(new Error('S3 недоступен'));
    const storage = await get(sized);
    expect(storage.statusCode).toBe(502);
    expect(storage.json()).toMatchObject({ error: 'storage_failed' });

    vi.mocked(getObject).mockResolvedValueOnce(
      Buffer.from('<?xml version="1.0"?><Другое/>', 'utf8'),
    );
    const parse = await get(sized);
    expect(parse.statusCode).toBe(422);
    expect(parse.json()).toMatchObject({ error: 'parse_failed' });

    vi.mocked(getObject).mockResolvedValueOnce(Buffer.alloc(UPD_PDF_MAX_XML_BYTES + 1, 0x20));
    const grown = await get(sized);
    expect(grown.statusCode).toBe(413);
    expect(grown.json()).toMatchObject({ error: 'too_large' });

    for (const res of [noSize, tooBig, storage, parse, grown]) {
      expect((res.json() as { message?: string }).message).toBeTruthy();
    }

    currentUser = { ...manager, role: 'inspector_kpp' } as AuthUser;
    try {
      expect((await get(sized)).statusCode).toBe(403);
    } finally {
      currentUser = manager;
    }
  });
});
