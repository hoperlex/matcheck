/**
 * Стороны документа в API: ручная правка снимает пометку «покупатель =
 * поставщик», а подсказка «Получатель» приёмки берётся из сторон документов.
 *
 * Подсказка — только по ИНН, без своей организации, без выбора за человека
 * между разными подрядчиками и только при операционном контрагенте с тем же
 * ИНН (иначе from-directory ушёл бы в поиск по имени).
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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../../src/plugins/auth.js';

vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  putObject: vi.fn(),
  presign: vi.fn(),
  getObject: vi.fn(),
  deleteObject: vi.fn(),
}));

const { sourceDocumentRoutes } = await import('../../src/routes/source-documents.js');
const { registerDeliveryRecipientRoutes } = await import('../../src/routes/delivery-recipient.js');
const { resetSupplierInnCheckCache } =
  await import('../../src/domain/sourceDocuments/supplier-inn-check.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** Корректный десятизначный ИНН из девяти цифр: дописывает контрольную. */
function validInn(prefix9: string): string {
  const d = [...prefix9].map(Number);
  const check = ([2, 4, 10, 3, 5, 9, 4, 6, 8].reduce((a, w, i) => a + w * d[i]!, 0) % 11) % 10;
  return prefix9 + check;
}

suite('стороны документа и подсказка получателя в API (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  const run = String(Date.now()).slice(-6);
  const siteId = randomUUID();
  const edoAccountId = randomUUID();
  const ownInn = validInn(`91${run}1`);
  const contractorInn = validInn(`92${run}2`);
  const otherContractorInn = validInn(`92${run}3`);
  const noOperationalInn = validInn(`92${run}4`);
  const contractorCcId = randomUUID();
  const otherCcId = randomUUID();
  const noOperationalCcId = randomUUID();
  const ownCcId = randomUUID();
  let user: AuthUser;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    app.decorate('db', drizzle(sql) as never);
    app.decorate('queues', { updParse: { add: vi.fn() } } as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = user;
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
    registerDeliveryRecipientRoutes(app);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`RS${run.slice(-4)}`}, 'Подсказка получателя')`;
    // Своя организация — по ИНН учётки ЭДО (loadOwnInns).
    await sql`INSERT INTO edo_accounts (id, name, credentials_encrypted, org_inn)
              VALUES (${edoAccountId}, ${`Своя ${run}`}, ${Buffer.from('x')}, ${ownInn})`;
    await sql`INSERT INTO customer_counterparties (id, inn, name) VALUES
      (${contractorCcId}, ${`ИНН ${contractorInn}`}, ${`ООО «Стройсервис ${run}»`}),
      (${otherCcId}, ${otherContractorInn}, ${`ООО «Форум ${run}»`}),
      (${noOperationalCcId}, ${noOperationalInn}, ${`ООО «Без строки ${run}»`}),
      (${ownCcId}, ${ownInn}, ${`СУ-10 ${run}`})`;
    // Операционные строки есть у всех, кроме noOperationalInn.
    await sql`INSERT INTO counterparties (inn, name) VALUES
      (${contractorInn}, ${`ООО «СТРОЙСЕРВИС ${run}»`}),
      (${otherContractorInn}, ${`ООО «ФОРУМ ${run}»`}),
      (${ownInn}, ${`ООО «СУ-10 ${run}»`})`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM delivery_sources WHERE delivery_id IN (SELECT id FROM deliveries WHERE site_id = ${siteId})`;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM customer_counterparties WHERE id IN (${contractorCcId}, ${otherCcId}, ${noOperationalCcId}, ${ownCcId})`;
    await sql`DELETE FROM counterparties WHERE inn IN (${contractorInn}, ${otherContractorInn}, ${ownInn})`;
    await sql`DELETE FROM edo_accounts WHERE id = ${edoAccountId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(() => {
    resetSupplierInnCheckCache();
    user = { id: randomUUID(), role: 'manager', siteId: null } as unknown as AuthUser;
  });

  async function seedDoc(p: {
    buyerInn?: string | null;
    consigneeInn?: string | null;
    validation?: unknown;
  }): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO source_documents
      (id, kind, direction, status, origin, site_id, doc_number, buyer_inn_raw, buyer_name_raw,
       consignee_inn_raw, validation)
      VALUES (${id}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId}, ${`RS-${run}`},
              ${p.buyerInn ?? null}, ${p.buyerInn ? 'Покупатель' : null}, ${p.consigneeInn ?? null},
              ${p.validation ? JSON.stringify(p.validation) : null}::jsonb)`;
    return id;
  }

  async function seedDelivery(docIds: string[]): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, status_id)
              VALUES (${id}, ${siteId},
                      (SELECT id FROM statuses WHERE entity_type='delivery' AND code='not_filled'))`;
    for (const docId of docIds) {
      await sql`INSERT INTO delivery_sources (delivery_id, source_document_id) VALUES (${id}, ${docId})`;
    }
    return id;
  }

  async function suggestion(deliveryId: string) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/deliveries/${deliveryId}/recipient-suggestion`,
    });
  }

  describe('PATCH документа снимает пометку «покупатель = поставщик»', () => {
    const flaggedValidation = {
      hasMismatch: false,
      checkedAt: '2026-10-26T00:00:00.000Z',
      checks: [],
      warnings: [
        { name: 'buyer_same_as_supplier', scope: 'document' },
        { name: 'dropped_pages_not_parsed', scope: 'document' },
      ],
    };
    async function warnings(id: string): Promise<string[]> {
      const [r] = await sql<{ validation: { warnings?: Array<{ name: string }> } }[]>`
        SELECT validation FROM source_documents WHERE id = ${id}`;
      return (r!.validation.warnings ?? []).map((w) => w.name);
    }

    it('человек убрал покупателя', async () => {
      const id = await seedDoc({ validation: flaggedValidation });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/source-documents/${id}`,
        payload: { buyer: null },
      });
      expect(res.statusCode).toBe(200);
      expect(await warnings(id)).toEqual(['dropped_pages_not_parsed']);
    });

    it('человек сменил поставщика', async () => {
      const id = await seedDoc({ validation: flaggedValidation });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/source-documents/${id}`,
        payload: { supplier: { inn: validInn(`90${run}9`), name: `ООО «Поставщик ${run}»` } },
      });
      expect(res.statusCode).toBe(200);
      expect(await warnings(id)).toEqual(['dropped_pages_not_parsed']);
      await sql`DELETE FROM suppliers WHERE name = ${`ООО «Поставщик ${run}»`}`;
    });

    it('правка без сторон пометку не трогает', async () => {
      const id = await seedDoc({ validation: flaggedValidation });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/source-documents/${id}`,
        payload: { docNumber: `RS2-${run}` },
      });
      expect(res.statusCode).toBe(200);
      expect(await warnings(id)).toContain('buyer_same_as_supplier');
    });
  });

  describe('GET /deliveries/:id/recipient-suggestion', () => {
    it('21514: покупатель — подрядчик из справочника', async () => {
      const doc = await seedDoc({ buyerInn: contractorInn, consigneeInn: contractorInn });
      const res = await suggestion(await seedDelivery([doc]));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        suggestion: {
          customerCounterpartyId: contractorCcId,
          name: `ООО «Стройсервис ${run}»`,
          inn: contractorInn,
          from: 'buyer',
          sourceDocumentId: doc,
        },
      });
    });

    it('своя организация исключена — подсказка по грузополучателю', async () => {
      const doc = await seedDoc({ buyerInn: ownInn, consigneeInn: otherContractorInn });
      const res = await suggestion(await seedDelivery([doc]));
      expect(res.json().suggestion).toMatchObject({
        customerCounterpartyId: otherCcId,
        from: 'consignee',
      });
    });

    it('только своя организация — подсказки нет', async () => {
      const doc = await seedDoc({ buyerInn: ownInn, consigneeInn: ownInn });
      expect((await suggestion(await seedDelivery([doc]))).json()).toEqual({ suggestion: null });
    });

    it('два документа с разными подрядчиками — подсказки нет', async () => {
      const a = await seedDoc({ buyerInn: contractorInn });
      const b = await seedDoc({ buyerInn: otherContractorInn });
      expect((await suggestion(await seedDelivery([a, b]))).json()).toEqual({ suggestion: null });
    });

    it('нет операционного контрагента с этим ИНН — подсказки нет', async () => {
      const doc = await seedDoc({ buyerInn: noOperationalInn });
      expect((await suggestion(await seedDelivery([doc]))).json()).toEqual({ suggestion: null });
    });

    it('у документа нет ИНН сторон — подсказки нет (по имени не подсказываем)', async () => {
      const doc = await seedDoc({});
      await sql`UPDATE source_documents SET buyer_name_raw = ${`ООО «Стройсервис ${run}»`} WHERE id = ${doc}`;
      expect((await suggestion(await seedDelivery([doc]))).json()).toEqual({ suggestion: null });
    });

    it('инспектор и подрядчик — 403', async () => {
      const doc = await seedDoc({ buyerInn: contractorInn });
      const deliveryId = await seedDelivery([doc]);
      for (const role of ['inspector_kpp', 'contractor'] as const) {
        user = { id: randomUUID(), role, siteId } as unknown as AuthUser;
        expect((await suggestion(deliveryId)).statusCode).toBe(403);
      }
    });

    it('несуществующая приёмка — 404', async () => {
      expect((await suggestion(randomUUID())).statusCode).toBe(404);
    });
  });
});
