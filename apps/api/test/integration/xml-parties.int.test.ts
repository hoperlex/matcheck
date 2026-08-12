/**
 * Стороны и их ИНН на XML-маршрутах: ручная загрузка и импорт из ЭДО.
 *
 * Оба маршрута создают документ в обход воркера и своим кодом — поэтому
 * «воркер стороны пишет» здесь не значит ничего. Проверяются две вещи:
 *
 *   1. ИНН из XML сохраняется на самом документе (supplier_inn_raw /
 *      buyer_inn_raw). Раньше он использовался только чтобы найти или создать
 *      контрагента и выбрасывался, а в списке вторая строка ячейки пустовала;
 *   2. покупатель попадает в buyer_id / buyer_name_raw, а не только в
 *      recipient_id. Бэкфилл миграции 0083 закрыл лишь то, что было в базе на
 *      момент миграции, и колонка «Покупатель» у новых XML-документов снова
 *      оказывалась пустой.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EdoAdapter } from '../../src/domain/edo/adapter.js';
import type { AuthUser } from '../../src/plugins/auth.js';

vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  putObject: vi.fn(),
  presign: vi.fn(),
  getObject: vi.fn(),
  deleteObject: vi.fn(),
}));

const { sourceDocumentRoutes } = await import('../../src/routes/source-documents.js');
const { runEdoSyncForAccount } = await import('../../src/domain/jobs/edo-poller.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** Минимальный УПД в формате приказа ФНС — ровно то, что читает parseUpdXml. */
function updXml(opts: {
  docNumber: string;
  supplierInn: string;
  buyerInn: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Файл ИдФайл="test">
  <Документ КНД="1115131" НомерДок="${opts.docNumber}" ДатаДок="10.07.2026">
    <СвСчФакт>
      <СвПрод ИННЮЛ="${opts.supplierInn}" КПП="772201001" НаимОрг="ООО «Продавец из XML»"/>
      <СвПокуп ИННЮЛ="${opts.buyerInn}" КПП="773601001" НаимОрг="ООО «СУ-10»"/>
      <ТаблСчФакт>
        <СведТов НомСтр="1" НаимТов="Труба стальная" КолТов="2" ОКЕИ_Тов="шт"
                 ЦенаТов="100" СтоимТовБезНДС="200" НалСт="20" СтоимНалог="40"/>
        <ВсегоОпл СтоимТовБезНДСВсего="200" СумНалВсего="40"/>
      </ТаблСчФакт>
    </СвСчФакт>
  </Документ>
</Файл>`;
}

suite('стороны XML-документов: ручная загрузка и ЭДО (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;

  const siteId = randomUUID();
  const contractorId = randomUUID();
  const edoAccountId = randomUUID();
  // ИНН уникальны в counterparties, а базу делят все интеграционные наборы.
  const stamp = String(Date.now()).slice(-8);
  const manualSupplierInn = `70${stamp}`;
  const manualBuyerInn = `71${stamp}`;
  const edoSupplierInn = `72${stamp}`;
  const edoBuyerInn = `73${stamp}`;

  // Пользователь нужен в БД по-настоящему: upload-upd пишет created_by_user_id
  // (мобильный клиент берёт оттуда телефон менеджера), и это FK на users.
  const managerId = randomUUID();
  const manager = { id: managerId, role: 'manager', siteId: null } as unknown as AuthUser;

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

    await sql`INSERT INTO users (id, email, password_hash, role, is_active)
              VALUES (${managerId}, ${`xml-parties-${stamp}@test.local`}, 'not-a-real-hash', 'manager', true)`;
    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`XML${Date.now() % 10000}`}, 'XML-стороны')`;
    await sql`INSERT INTO counterparties (id, inn, name, is_contractor)
              VALUES (${contractorId}, ${`74${stamp}`}, 'ООО «Подрядчик»', true)`;
    await sql`INSERT INTO edo_accounts (id, provider, name, credentials_encrypted)
              VALUES (${edoAccountId}, 'diadoc', 'test-edo', 'not-a-real-secret')`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM source_document_items WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId} OR edo_account_id = ${edoAccountId})`;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId} OR edo_account_id = ${edoAccountId}`;
    await sql`DELETE FROM edo_accounts WHERE id = ${edoAccountId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql`DELETE FROM counterparties WHERE id = ${contractorId}
                 OR inn IN (${manualSupplierInn}, ${manualBuyerInn}, ${edoSupplierInn}, ${edoBuyerInn})`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql.end({ timeout: 5 });
  });

  type DocRow = {
    supplier_inn_raw: string | null;
    buyer_inn_raw: string | null;
    buyer_id: string | null;
    buyer_name_raw: string | null;
    recipient_id: string | null;
  };

  async function docById(id: string): Promise<DocRow> {
    const [row] = await sql<DocRow[]>`
      SELECT supplier_inn_raw, buyer_inn_raw, buyer_id, buyer_name_raw, recipient_id
        FROM source_documents WHERE id = ${id}`;
    return row!;
  }

  it('ручная загрузка XML: ИНН обеих сторон и покупатель сохраняются', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/source-documents/upload-upd',
      payload: {
        xml: updXml({
          docNumber: `XML-${stamp}`,
          supplierInn: manualSupplierInn,
          buyerInn: manualBuyerInn,
        }),
        direction: 'inbound',
        contractorId,
        siteId,
      },
    });
    expect(res.statusCode, res.body).toBe(201);

    const row = await docById(res.json().id as string);
    expect(row.supplier_inn_raw).toBe(manualSupplierInn);
    expect(row.buyer_inn_raw).toBe(manualBuyerInn);
    // Покупатель, а не только операционный получатель: колонка «Покупатель»
    // читает buyer_*, и без этой пары она оставалась бы пустой.
    expect(row.buyer_name_raw).toBe('ООО «СУ-10»');
    expect(row.buyer_id).toBe(row.recipient_id);
    expect(row.buyer_id).not.toBeNull();
  });

  it('импорт из ЭДО: те же поля заполняются', async () => {
    const providerMessageId = `edo-${stamp}`;
    const adapter: EdoAdapter = {
      listIncoming: async () => [
        {
          providerMessageId,
          receivedAt: new Date('2026-07-10T10:00:00Z'),
          xml: updXml({
            docNumber: `EDO-${stamp}`,
            supplierInn: edoSupplierInn,
            buyerInn: edoBuyerInn,
          }),
        },
      ],
      markProcessed: async () => {},
    };

    const [account] = await sql`SELECT * FROM edo_accounts WHERE id = ${edoAccountId}`;
    // Поллеру нужны только db и log.warn; свой log здесь для того, чтобы
    // проглоченная ошибка разбора («failed: 1») не осталась без объяснения.
    const failures: unknown[] = [];
    const pollerApp = {
      db: app.db,
      log: { warn: (o: unknown) => failures.push(o) },
    } as never;
    const result = await runEdoSyncForAccount(pollerApp, account as never, adapter);
    expect(failures, JSON.stringify(failures)).toHaveLength(0);
    expect(result).toEqual({ imported: 1, failed: 0 });

    const [created] = await sql<{ id: string }[]>`
      SELECT id FROM source_documents WHERE edo_account_id = ${edoAccountId}
         AND provider_message_id = ${providerMessageId}`;
    const row = await docById(created!.id);
    expect(row.supplier_inn_raw).toBe(edoSupplierInn);
    expect(row.buyer_inn_raw).toBe(edoBuyerInn);
    expect(row.buyer_name_raw).toBe('ООО «СУ-10»');
    expect(row.buyer_id).toBe(row.recipient_id);
    expect(row.buyer_id).not.toBeNull();
  });
});
