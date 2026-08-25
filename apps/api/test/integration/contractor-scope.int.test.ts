/**
 * Область видимости роли contractor: что именно даёт доступ к документу.
 *
 * Правило одно: подрядчик, проставленный АВТОМАТИКОЙ по ИНН покупателя
 * (`recipient_source='auto_buyer'`), правом доступа не является — содержимое
 * файла с открытой страницы /uploads недоверенное. Сама автоподстановка выключена
 * (её делал воркер), но такие документы остались в базе, поэтому здесь состояние
 * сеется напрямую, как исторические данные.
 *
 * Второй кейс — про провенанс: карточка приёмки больше не даёт выбирать
 * подрядчика, менеджер правит один МОЛ, и метка `auto_buyer` обязана пережить
 * это сохранение. Иначе недоверенная подстановка молча стала бы «решением
 * человека» и открыла бы документ подрядчику.
 *
 * Запуск: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test
 * Без переменной набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deliveries } from '../../src/db/schema.js';
import * as schema from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

vi.mock('../../src/instrument.js', () => ({}));
vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  presign: vi.fn(),
  getObject: vi.fn(),
  deleteObject: vi.fn(),
}));

const { sourceDocumentRoutes } = await import('../../src/routes/source-documents.js');
const { deliveryContractorPredicate, sourceDocumentVisibleToContractor } =
  await import('../../src/lib/contractor-scope.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('видимость для роли contractor (реальный PostgreSQL)', { timeout: 30_000 }, () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  const siteId = randomUUID();
  const contractorId = randomUUID();
  const molId = randomUUID();
  const inn = `75${String(Date.now()).slice(-8)}`;
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

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`CSC${Date.now() % 10000}`}, 'Скоуп подрядчика')`;
    await sql`INSERT INTO counterparties (id, inn, name, is_contractor)
              VALUES (${contractorId}, ${inn}, 'ООО «Подрядчик скоупа»', true)`;
    await sql`INSERT INTO responsible_persons (id, full_name, is_active)
              VALUES (${molId}, 'Иванов И.И.', true)`;
  });

  afterAll(async () => {
    if (!sql) return;
    await app.close();
    await sql`DELETE FROM delivery_sources WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM responsible_persons WHERE id = ${molId}`;
    await sql`DELETE FROM counterparties WHERE id = ${contractorId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  /** Документ с уже проставленным автоматикой подрядчиком — исторические данные. */
  async function seedAutoBuyerDoc(): Promise<string> {
    const docId = randomUUID();
    await sql`INSERT INTO source_documents
                (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum,
                 expected_date, contractor_id, recipient_source)
              VALUES (${docId}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId}, ${`AB-${docId.slice(0, 8)}`},
                      '2026-08-01', 100.00, '2026-08-02', ${contractorId}, 'auto_buyer')`;
    return docId;
  }

  it('приёмка, унаследовавшая auto_buyer-документ, подрядчику не видна; с явным contractor_id — видна', async () => {
    const docId = await seedAutoBuyerDoc();

    // Приёмка без своего подрядчика — видимость только через документ.
    const inheritedId = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, status_id)
              VALUES (${inheritedId}, ${siteId}, (SELECT id FROM statuses WHERE entity_type='delivery' AND code='not_filled'))`;
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id)
              VALUES (${inheritedId}, ${docId})`;

    // Приёмка с явно сохранённым подрядчиком — решение авторизованного человека.
    const explicitId = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, contractor_id, status_id)
              VALUES (${explicitId}, ${siteId}, ${contractorId},
                      (SELECT id FROM statuses WHERE entity_type='delivery' AND code='not_filled'))`;
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id)
              VALUES (${explicitId}, ${docId})`;

    // Проверяем НАСТОЯЩИЙ предикат из lib/contractor-scope, а не его копию:
    // копия в тесте разошлась бы с боевым кодом при первой же правке. drizzle
    // конфигурируем ровно как в приложении (db/client.ts).
    const orm = drizzle(sql, { schema, casing: 'snake_case' });
    const rows = await orm
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(and(eq(deliveries.siteId, siteId), deliveryContractorPredicate([contractorId])));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(explicitId);
    expect(ids).not.toContain(inheritedId);
  });

  it('правка одного МОЛ не превращает auto_buyer в решение человека', async () => {
    const docId = await seedAutoBuyerDoc();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/source-documents/${docId}`,
      payload: { recipientMolId: molId },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await sql<{ contractor_id: string; recipient_source: string | null }[]>`
      SELECT contractor_id, recipient_source FROM source_documents WHERE id = ${docId}`;
    // Подрядчик на месте (карточка его не трогает), провенанс — прежний.
    expect(row!.contractor_id).toBe(contractorId);
    expect(row!.recipient_source).toBe('auto_buyer');
    expect(
      sourceDocumentVisibleToContractor(
        { contractorId: row!.contractor_id, recipientSource: row!.recipient_source },
        [contractorId],
      ),
    ).toBe(false);
  });

  it('смена самого подрядчика — это уже решение человека', async () => {
    const docId = await seedAutoBuyerDoc();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/source-documents/${docId}`,
      payload: { contractorId: null },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await sql<{ recipient_source: string | null }[]>`
      SELECT recipient_source FROM source_documents WHERE id = ${docId}`;
    expect(row!.recipient_source).toBe('manual');
  });
});
