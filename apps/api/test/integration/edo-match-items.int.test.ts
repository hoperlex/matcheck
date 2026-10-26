/**
 * Строки привязанной УПД из ЭДО для блока материалов приёмки — на настоящем
 * PostgreSQL.
 *
 * Обещания, которые проверяются базой, а не чтением кода:
 *   - строки и итоги — ровно разбор файла (тот же, что у PDF), подпись — из реестра;
 *   - у каждого сбоя свой `state`, подпись есть, итогов и строк нет;
 *   - срок на чтение из хранилища доходит до getObject и обрывает зависшее чтение;
 *   - пустой разбор не выдаётся за пустой список;
 *   - карточка импорта читается из базы, без хранилища;
 *   - маршрут не трогает ни позиций, ни версии приёмки.
 *
 * Запуск: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test
 * Без переменной набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../src/db/schema.js';
import type { Db } from '../../src/db/client.js';
import { parseUpdXml } from '../../src/domain/edo/upd.parser.js';
import { UPD_PDF_MAX_ITEMS, UPD_PDF_MAX_XML_BYTES } from '../../src/domain/edo/upd-review-pdf.js';
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
const { getObject } = await import('../../src/domain/storage/s3.signer.js');
const { readExportItems } = await import('../../src/domain/edo/linked-edo-items.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const RUN = String(Date.now()).slice(-6);

function utd(rows: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Файл ИдФайл="ON_NSCHFDOPPR_${RUN}" ВерсФорм="5.03">
  <Документ КНД="1115131" Функция="СЧФДОП">
    <СвСчФакт НомерДок="ИЗ-ФАЙЛА-${RUN}" ДатаДок="23.10.2031">
      <СвПрод><ИдСв><СвЮЛУч НаимОрг="ООО «Фаворит-Электро»" ИННЮЛ="7701677700" КПП="770101001"/></ИдСв></СвПрод>
    </СвСчФакт>
    <ТаблСчФакт>
${rows}
      <ВсегоОпл СтТовБезНДСВсего="11623.28" СтТовУчНалВсего="14180.40"><СумНалВсего><СумНал>2557.12</СумНал></СумНалВсего></ВсегоОпл>
    </ТаблСчФакт>
  </Документ>
</Файл>`;
}

const ROW_MATERIAL = `      <СведТов НомСтр="1" НаимТов="Бирка кабельная «У-136» белая (100 шт/уп) REXANT" ОКЕИ_Тов="778"
               НаимЕдИзм="упак" КолТов="45" ЦенаТов="128.79" СтТовБезНДС="5795.55" НалСт="22%"
               СтТовУчНал="7070.57">
        <СумНал><СумНал>1275.02</СумНал></СумНал>
        <ДопСведТов ПрТовРаб="1" КодТов="00123"/>
      </СведТов>`;
const ROW_SERVICE = `      <СведТов НомСтр="2" НаимТов="Доставка" НаимЕдИзм="усл" КолТов="1" ЦенаТов="5827.73"
               СтТовБезНДС="5827.73" НалСт="22%" СтТовУчНал="7109.83">
        <СумНал><СумНал>1282.10</СумНал></СумНал>
        <ДопСведТов ПрТовРаб="3"/>
      </СведТов>`;
const ITEMS_XML = utd(`${ROW_MATERIAL}\n${ROW_SERVICE}`);
const EMPTY_XML = utd('');
const MANY_XML = utd(
  Array.from(
    { length: UPD_PDF_MAX_ITEMS + 1 },
    (_, i) =>
      `      <СведТов НомСтр="${i + 1}" НаимТов="Позиция ${i + 1}" НаимЕдИзм="шт" КолТов="1" ЦенаТов="1" СтТовБезНДС="1" НалСт="без НДС" СтТовУчНал="1"/>`,
  ).join('\n'),
);

const silentLog = {
  warn: () => undefined,
  error: () => undefined,
  info: () => undefined,
} as unknown as FastifyBaseLogger;

type ItemsResponse = {
  matchId: string;
  source: 'import' | 'export';
  label: {
    operator: string;
    docNumber: string | null;
    docDate: string | null;
    correctionNumber: string | null;
  };
  state: string;
  totals: { totalSum: number | null; totalExVat: number | null; vatSum: number | null } | null;
  reasons: string[];
  items: Record<string, unknown>[];
};

suite('строки привязанной УПД из ЭДО (реальный PostgreSQL)', { timeout: 120_000 }, () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let db: Db;

  const siteId = randomUUID();
  const managerId = randomUUID();
  const accountId = randomUUID();
  const deliveryId = randomUUID();
  const otherDeliveryId = randomUUID();
  const importCardId = randomUUID();
  const emptyCardId = randomUUID();

  const manager = { id: managerId, role: 'manager', siteId: null } as unknown as AuthUser;
  let currentUser: AuthUser = manager;

  /** Строка реестра и её привязка к приёмке. Возвращает id привязки. */
  async function linkedExport(o: {
    xml?: string;
    sizeBytes?: number | null;
    correction?: string | null;
    delivery?: string;
  }): Promise<{ matchId: string; documentId: string; s3Key: string }> {
    const documentId = randomUUID();
    const s3Key = `edo-export/test/${documentId}.xml`;
    const xml = o.xml ?? ITEMS_XML;
    s3.files.set(s3Key, Buffer.from(xml, 'utf8'));
    const sizeBytes = o.sizeBytes === undefined ? Buffer.byteLength(xml) : o.sizeBytes;
    await sql`INSERT INTO edo_export_documents
        (id, edo_account_id, message_id, entity_id, document_type, document_number, document_date,
         correction_number, supplier_inn, supplier_name, total_sum, vat_sum, content_category,
         status, s3_key, content_sha256, size_bytes, received_at)
      VALUES (${documentId}, ${accountId}, ${`m-${documentId}`}, ${`e-${documentId}`},
              'UniversalTransferDocument', ${`РЕЕСТР-${RUN}`}, '2031-10-23',
              ${o.correction ?? null}, '7701677700', 'ООО «Фаворит-Электро»', 14180.40, 2557.12,
              'materials', 'stored', ${s3Key}, ${documentId.replace(/-/g, '').padEnd(64, '0')},
              ${sizeBytes}, '2031-10-23T09:00:00Z')`;
    const matchId = randomUUID();
    await sql`INSERT INTO delivery_edo_matches (id, delivery_id, export_document_id, linked_by_user_id)
              VALUES (${matchId}, ${o.delivery ?? deliveryId}, ${documentId}, ${managerId})`;
    return { matchId, documentId, s3Key };
  }

  /** Привязка карточки импорта; повторный вызов отдаёт уже существующую. */
  async function linkedImport(cardId: string): Promise<string> {
    await sql`INSERT INTO delivery_edo_matches (id, delivery_id, source_document_id, linked_by_user_id)
              VALUES (${randomUUID()}, ${deliveryId}, ${cardId}, ${managerId})
              ON CONFLICT DO NOTHING`;
    const [row] = await sql<{ id: string }[]>`
      SELECT id FROM delivery_edo_matches
       WHERE delivery_id = ${deliveryId} AND source_document_id = ${cardId}`;
    return row!.id;
  }

  async function getItems(matchId: string, delivery = deliveryId) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/deliveries/${delivery}/edo-matches/${matchId}/items`,
    });
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

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`EDI${RUN}`}, 'Строки ЭДО')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
              VALUES (${managerId}, ${`edi-${managerId}@test`}, 'x', 'manager', NULL)`;
    await sql`INSERT INTO edo_accounts (id, provider, auth_mode, name, credentials_encrypted, box_id)
              VALUES (${accountId}, 'sbis', 'sbis_service_key', ${`СБИС ${RUN}`}, '{}', ${`sbis-${RUN}`})`;
    // «Не оформлена» и строка без цены: отчёты, которые читают всю базу (журнал
    // движений), такую приёмку не считают и параллельно идущие наборы не сбивают.
    const statusId = (
      await sql<{ id: string }[]>`
        SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'not_filled' LIMIT 1`
    )[0]!.id;
    for (const id of [deliveryId, otherDeliveryId]) {
      await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, arrived_at, version)
                VALUES (${id}, ${siteId}, ${managerId}, ${statusId}, '2031-10-24T07:00:00Z', 3)`;
    }
    // Факт инспектора: эти строки маршрут читать и менять не должен.
    await sql`INSERT INTO delivery_items (id, delivery_id, name_raw, qty_actual, unit, line_no)
              VALUES (${randomUUID()}, ${deliveryId}, 'Бирка кабельная', 45, 'упак', 1)`;

    // Карточки импорта Диадока: с позициями и без.
    for (const [id, number] of [
      [importCardId, `ИМП-${RUN}`],
      [emptyCardId, `ИМП0-${RUN}`],
    ] as const) {
      await sql`INSERT INTO source_documents
                  (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum, vat_sum)
                VALUES (${id}, 'upd', 'inbound', 'parsed', 'edo_diadoc', ${siteId},
                        ${number}, '2031-10-22', 2400.00, 400.00)`;
    }
    for (const [lineNo, name, qty, price, sum] of [
      [2, 'Муфта разборная d16', '200.0000', '8.07', '1969.08'],
      [1, 'Труба ПП 20', '40.0000', '50.00', '2400.00'],
    ] as const) {
      await sql`INSERT INTO source_document_items
                  (id, source_document_id, line_no, name_raw, qty, unit, price, sum, vat_rate, vat_sum)
                VALUES (${randomUUID()}, ${importCardId}, ${lineNo}, ${name}, ${qty}, 'шт',
                        ${price}, ${sum}, 22.00, 355.08)`;
    }
  });

  beforeEach(() => {
    vi.mocked(getObject).mockClear();
  });

  afterAll(async () => {
    if (!sql) return;
    await app.close();
    await sql`DELETE FROM delivery_edo_matches WHERE delivery_id IN (${deliveryId}, ${otherDeliveryId})`;
    await sql`DELETE FROM edo_export_documents WHERE edo_account_id = ${accountId}`;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_documents WHERE id IN (${importCardId}, ${emptyCardId})`;
    await sql`DELETE FROM edo_accounts WHERE id = ${accountId}`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  it('ready: строки и итоги — разбор файла по всем полям, подпись — из реестра', async () => {
    const { matchId, s3Key } = await linkedExport({ correction: '2' });
    const res = await getItems(matchId);
    expect(res.statusCode).toBe(200);
    const body = res.json() as ItemsResponse;
    const parsed = parseUpdXml(ITEMS_XML);

    expect(body).toMatchObject({ matchId, source: 'export', state: 'ready', reasons: [] });
    // Номер в подписи — из реестра, а не из файла: так же, как у чипа.
    expect(body.label).toEqual({
      operator: 'sbis',
      docNumber: `РЕЕСТР-${RUN}`,
      docDate: '2031-10-23',
      correctionNumber: '2',
    });
    expect(body.totals).toEqual({
      totalSum: parsed.totalSum,
      totalExVat: parsed.totalExVat,
      vatSum: parsed.vatSum,
    });
    expect(body.items).toEqual(
      parsed.items.map((item, position) => ({
        position,
        lineNo: item.lineNo,
        nameRaw: item.nameRaw,
        qty: item.qty,
        unit: item.unit,
        unitCode: item.unitCode,
        price: item.price,
        sumExVat: item.sumExVat,
        vatRate: item.vatRate,
        vatSum: item.vatSum,
        sum: item.sum,
        itemKind: item.kind,
        productCode: item.productCode,
      })),
    );
    // Узнаваемые значения, чтобы сравнение не прошло на двух пустых массивах.
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      nameRaw: expect.stringContaining('Бирка'),
      qty: 45,
      itemKind: 1,
    });
    expect(body.items[1]).toMatchObject({ nameRaw: 'Доставка', itemKind: 3 });
    // Срок на чтение передан в хранилище.
    expect(getObject).toHaveBeenCalledWith(s3Key, { signal: expect.any(AbortSignal) });
  });

  it('каждый сбой — свой state; подпись есть, итогов и строк нет', async () => {
    const expectFailed = (body: ItemsResponse, state: string) => {
      expect(body.state).toBe(state);
      expect(body.label.docNumber).toBe(`РЕЕСТР-${RUN}`);
      expect(body.label.operator).toBe('sbis');
      expect(body.totals).toBeNull();
      expect(body.items).toEqual([]);
    };

    // Хранилище недоступно.
    const unavailable = await linkedExport({});
    vi.mocked(getObject).mockRejectedValueOnce(new Error('S3 недоступен'));
    const storage = await getItems(unavailable.matchId);
    expect(storage.statusCode).toBe(200);
    expectFailed(storage.json() as ItemsResponse, 'storage_failed');

    // Не УПД.
    const broken = await linkedExport({ xml: '<?xml version="1.0"?><Другое/>' });
    expectFailed((await getItems(broken.matchId)).json() as ItemsResponse, 'parse_failed');

    // Объект больше, чем записано в реестре.
    const grown = await linkedExport({});
    vi.mocked(getObject).mockResolvedValueOnce(Buffer.alloc(UPD_PDF_MAX_XML_BYTES + 1, 0x20));
    expectFailed((await getItems(grown.matchId)).json() as ItemsResponse, 'too_large');

    // Строк больше предела PDF.
    const many = await linkedExport({ xml: MANY_XML });
    expectFailed((await getItems(many.matchId)).json() as ItemsResponse, 'too_large');
  });

  it('размер по реестру проверяется до чтения: хранилище не трогается', async () => {
    const huge = await linkedExport({ sizeBytes: UPD_PDF_MAX_XML_BYTES + 1 });
    const unknown = await linkedExport({ sizeBytes: null });
    vi.mocked(getObject).mockClear();
    const tooBig = (await getItems(huge.matchId)).json() as ItemsResponse;
    const noSize = (await getItems(unknown.matchId)).json() as ItemsResponse;
    expect(tooBig).toMatchObject({ state: 'too_large', totals: null, items: [], reasons: [] });
    expect(noSize).toMatchObject({
      state: 'too_large',
      totals: null,
      items: [],
      reasons: ['размер файла в реестре не указан'],
    });
    expect(getObject).not.toHaveBeenCalled();
  });

  it('зависшее чтение обрывается сроком — storage_failed не позже срока', async () => {
    const { documentId, s3Key } = await linkedExport({});
    let seenSignal: AbortSignal | undefined;
    vi.mocked(getObject).mockImplementationOnce(
      (_key: string, opts?: { signal?: AbortSignal }) =>
        new Promise<Buffer>((_resolve, reject) => {
          seenSignal = opts?.signal;
          // Отвечает только на отмену — как узел S3, который не шлёт заголовки.
          opts?.signal?.addEventListener('abort', () => reject(opts.signal!.reason), {
            once: true,
          });
        }),
    );
    const started = Date.now();
    const result = await readExportItems(
      { id: documentId, status: 'stored', s3Key, sizeBytes: 100 },
      { log: silentLog, deadlineMs: 50 },
    );
    expect(result).toEqual({ state: 'storage_failed', totals: null, reasons: [], items: [] });
    expect(seenSignal?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    // Свой срок теста: без обрыва чтение висит вечно, и падать надо быстро,
    // а не по общему сроку набора.
  }, 10_000);

  it('пустой разбор — incomplete с причиной, а не пустой список', async () => {
    const { matchId } = await linkedExport({ xml: EMPTY_XML });
    const body = (await getItems(matchId)).json() as ItemsResponse;
    expect(body.state).toBe('incomplete');
    expect(body.reasons).toEqual(['не прочитана ни одна позиция']);
    expect(body.items).toEqual([]);
    // Итоги файла при этом известны: разбор был.
    expect(body.totals).toEqual({ totalSum: 14180.4, totalExVat: 11623.28, vatSum: 2557.12 });
  });

  it('карточка импорта: строки из базы по порядку строк, без хранилища', async () => {
    const matchId = await linkedImport(importCardId);
    const body = (await getItems(matchId)).json() as ItemsResponse;
    expect(body).toMatchObject({
      matchId,
      source: 'import',
      state: 'ready',
      reasons: [],
      label: {
        operator: 'diadoc',
        docNumber: `ИМП-${RUN}`,
        docDate: '2031-10-22',
        correctionNumber: null,
      },
      totals: { totalSum: 2400, totalExVat: null, vatSum: 400 },
    });
    expect(body.items).toEqual([
      expect.objectContaining({
        position: 0,
        lineNo: 1,
        nameRaw: 'Труба ПП 20',
        qty: 40,
        price: 50,
      }),
      expect.objectContaining({ position: 1, lineNo: 2, nameRaw: 'Муфта разборная d16', qty: 200 }),
    ]);
    for (const item of body.items) {
      expect(item).toMatchObject({
        sumExVat: null,
        unitCode: null,
        itemKind: null,
        productCode: null,
      });
    }
    expect(getObject).not.toHaveBeenCalled();

    const empty = (await getItems(await linkedImport(emptyCardId))).json() as ItemsResponse;
    expect(empty).toMatchObject({
      state: 'incomplete',
      reasons: ['не прочитана ни одна позиция'],
      items: [],
    });
  });

  it('чужая привязка и неизвестная привязка — 404; инспектору — 403', async () => {
    const { matchId } = await linkedExport({ delivery: otherDeliveryId });
    expect((await getItems(matchId)).statusCode).toBe(404);
    expect((await getItems(matchId, otherDeliveryId)).statusCode).toBe(200);
    expect((await getItems(randomUUID())).statusCode).toBe(404);

    currentUser = { ...manager, role: 'inspector_kpp' } as AuthUser;
    try {
      expect((await getItems(matchId, otherDeliveryId)).statusCode).toBe(403);
    } finally {
      currentUser = manager;
    }
  });

  it('маршрут не меняет позиции, версию и время правки приёмки', async () => {
    const snapshot = async () => ({
      delivery: (
        await sql<{ version: number; updated_at: Date }[]>`
          SELECT version, updated_at FROM deliveries WHERE id = ${deliveryId}`
      )[0],
      items: await sql`
        SELECT id, name_raw, qty_planned, qty_actual, unit, line_no, price, vat_rate, vat_sum,
               source_document_id, source_document_item_id
          FROM delivery_items WHERE delivery_id = ${deliveryId} ORDER BY id`,
    });
    const before = await snapshot();
    const { matchId } = await linkedExport({});
    await getItems(matchId);
    await getItems(await linkedImport(importCardId));
    expect(await snapshot()).toEqual(before);
    expect(before.items).toHaveLength(1);
  });
});
