/**
 * Область поиска журнала вызовов в карточке документа.
 *
 * Разбор ПАКЕТА накладных логируется на техническую запись, которую воркер
 * удаляет: с миграции 0127 ссылка на документ у такой записи обнуляется, и
 * найти вызов можно только по пакету. Поэтому маршрут ищет по трём
 * координатам — сам документ, его пакет и НЕПОСРЕДСТВЕННЫЙ корень этого пакета.
 *
 * Главное здесь — граница: у каждого файла загрузки свой дочерний пакет, и
 * окно одного документа не имеет права показывать вызовы соседнего.
 *
 * Запуск: см. заголовок test/integration/expected-date-transfer.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
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
  getObject: vi.fn(),
  deleteObject: vi.fn(),
  presign: vi.fn().mockResolvedValue('https://s3.example/signed'),
}));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** Четыре записи журнала: своя, пакетная, корневая и чужая (соседний пакет). */
const ownDocCall = randomUUID();
const ownBundleCall = randomUUID();
const rootCall = randomUUID();
const siblingCall = randomUUID();

suite('журнал вызовов: область поиска (реальный PostgreSQL)', { timeout: 40_000 }, () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  const siteId = randomUUID();
  const admin = { id: randomUUID(), role: 'admin', siteId: null } as unknown as AuthUser;

  const rootId = randomUUID();
  const childId = randomUUID();
  const siblingId = randomUUID();
  const docId = randomUUID();
  const siblingDocId = randomUUID();

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    await sql`INSERT INTO sites (id, code, name, is_active)
              VALUES (${siteId}, ${`LC${Date.now() % 10000}`}, 'Объект логов', true)`;

    // Одна загрузка (корень) с двумя файлами: у каждого свой дочерний пакет и
    // свой документ — ровно так, как это делает router сегодня.
    await sql`INSERT INTO source_bundles (id, site_id, direction, status, bundle_hash)
              VALUES (${rootId}, ${siteId}, 'inbound', 'parsed', ${rootId})`;
    for (const [bundleId, documentId] of [
      [childId, docId],
      [siblingId, siblingDocId],
    ] as const) {
      await sql`INSERT INTO source_bundles
          (id, site_id, direction, status, bundle_hash, parent_bundle_id)
        VALUES (${bundleId}, ${siteId}, 'inbound', 'parsed', ${bundleId}, ${rootId})`;
      await sql`INSERT INTO source_documents
          (id, kind, direction, status, origin, site_id, bundle_id)
        VALUES (${documentId}, 'transport_waybill', 'inbound', 'parsed', 'manual_pdf',
                ${siteId}, ${bundleId})`;
    }

    // Четыре записи журнала: своя по документу, своя по его пакету, общая по
    // корню (router-классификация) и чужая — по соседнему пакету.
    const call = (id: string, sourceDocumentId: string | null, bundleId: string | null) =>
      sql`INSERT INTO llm_calls (id, source_document_id, bundle_id, doc_kind, request_messages, latency_ms)
          VALUES (${id}, ${sourceDocumentId}, ${bundleId}, 'transport_waybill', '[]'::jsonb, 5)`;
    await call(ownDocCall, docId, null);
    await call(ownBundleCall, null, childId);
    await call(rootCall, null, rootId);
    await call(siblingCall, null, siblingId);

    vi.resetModules();
    const { sourceDocumentRoutes } = await import('../../src/routes/source-documents.js');
    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(multipart, { limits: { fileSize: 1024 * 1024, files: 1 } });
    app.decorate('db', drizzle(sql, { schema, casing: 'snake_case' }) as never);
    app.decorate('queues', { updParse: { add: vi.fn() }, s3Cleanup: { add: vi.fn() } } as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = admin;
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
  });

  afterAll(async () => {
    await app?.close();
    await sql`DELETE FROM llm_calls WHERE bundle_id IN (${rootId}, ${childId}, ${siblingId})
              OR source_document_id IN (${docId}, ${siblingDocId})`;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE parent_bundle_id = ${rootId}`;
    await sql`DELETE FROM source_bundles WHERE id = ${rootId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  it('отдаёт вызовы документа, его пакета и корня — и не отдаёт чужие', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/source-documents/${docId}/llm-calls` });

    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { items: { id: string }[] }).items.map((i) => i.id).sort();
    expect(ids).toEqual([ownDocCall, ownBundleCall, rootCall].sort());
    expect(ids).not.toContain(siblingCall);
  });

  it('у соседнего документа своя выборка', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/source-documents/${siblingDocId}/llm-calls`,
    });

    const ids = (res.json() as { items: { id: string }[] }).items.map((i) => i.id).sort();
    expect(ids).toEqual([siblingCall, rootCall].sort());
  });
});
