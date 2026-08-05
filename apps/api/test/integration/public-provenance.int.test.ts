/**
 * Признак «от поставщика» на документах публичной загрузки.
 *
 * Две ловушки, из-за которых наивная реализация ломается:
 *
 *  1. Накладные router разворачивает в ДОЧЕРНИЙ пакет (worker.ts: sub-bundle с
 *     parent_bundle_id), и реальный документ ТН/ОС-2 висит уже на нём. Событие
 *     приёма при этом лежит на родителе — поиск по прямому bundle_id ничего не
 *     найдёт, и накладная от поставщика выглядела бы загруженной вручную.
 *
 *  2. На одном пакете может быть НЕСКОЛЬКО публичных событий (тот же комплект
 *     прислали повторно). Обычный LEFT JOIN размножил бы строки документа —
 *     поехали бы пагинация и total.
 *
 * Плюс проверка того, что комментарий поставщика доходит до карточки документа
 * и виден всем, кто вообще видит документ, — персональных данных в нём нет.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../../src/plugins/auth.js';

const mocks = vi.hoisted(() => ({ putObject: vi.fn(), presign: vi.fn(), queueAdd: vi.fn() }));
vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  putObject: mocks.putObject,
  presign: mocks.presign,
}));

const { sourceDocumentRoutes } = await import('../../src/routes/source-documents.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('провенанс публичной загрузки (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  const siteId = randomUUID();
  const userId = randomUUID();
  let currentUser: AuthUser;

  const manager = { id: userId, role: 'manager', siteId: null } as unknown as AuthUser;
  const inspector = { id: userId, role: 'inspector_kpp', siteId } as unknown as AuthUser;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql) as never);
    app.decorate('queues', { updParse: { add: mocks.queueAdd } } as never);
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
    await app.register(sourceDocumentRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'PRV'}, 'Провенанс')`;
    await sql`INSERT INTO users (id, email, password_hash, role)
      VALUES (${userId}, ${`prv-${userId}@test`}, 'x', 'manager')`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await wipe();
    await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  async function wipe() {
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  }

  beforeEach(async () => {
    currentUser = manager;
    await wipe();
  });

  /** Пакет + событие публичной отправки. Возвращает id пакета. */
  async function publicBundle(hash: string, comment = 'две машины, вторая после обеда'): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO source_bundles (id, bundle_hash, kind, direction, site_id, status)
      VALUES (${id}, ${hash}, 'mixed', 'inbound', ${siteId}, 'parsed')`;
    await sql`INSERT INTO ingest_events
        (bundle_id, channel, public_ticket, submission_comment, submitter_ip, submission_manifest)
      VALUES (${id}, 'public', ${randomUUID().slice(0, 22)}, ${comment}, '203.0.113.7',
              ${JSON.stringify([{ filename: 'a.pdf', accepted: true }])}::jsonb)`;
    return id;
  }

  async function document(bundleId: string, kind = 'upd'): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO source_documents
        (id, kind, direction, origin, status, site_id, bundle_id, doc_number, doc_date, total_sum, parsed_at)
      VALUES (${id}, ${kind}, 'inbound', 'manual_pdf', 'parsed', ${siteId}, ${bundleId},
              'Д-1', now(), 100, now())`;
    return id;
  }

  const list = () =>
    app.inject({ method: 'GET', url: '/api/v1/source-documents?direction=inbound&limit=50' });
  const detail = (id: string) =>
    app.inject({ method: 'GET', url: `/api/v1/source-documents/${id}` });

  it('документ публичного пакета помечен признаком', async () => {
    const bundleId = await publicBundle('hash-direct');
    const docId = await document(bundleId);

    const res = await list();
    expect(res.statusCode).toBe(200);
    const row = res.json().items.find((r: { id: string }) => r.id === docId);
    expect(row.fromSupplierPortal).toBe(true);
  });

  it('накладная из ДОЧЕРНЕГО пакета тоже помечена', async () => {
    // Ровно то, что делает router: sub-bundle на файл накладной, документ — на нём.
    const parentId = await publicBundle('hash-parent');
    const childId = randomUUID();
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, kind, direction, site_id, status, parent_bundle_id)
      VALUES (${childId}, ${'hash-child'}, 'waybill', 'inbound', ${siteId}, 'parsed', ${parentId})`;
    const docId = await document(childId, 'transport_waybill');

    const row = (await list()).json().items.find((r: { id: string }) => r.id === docId);
    expect(row.fromSupplierPortal).toBe(true);

    const card = await detail(docId);
    expect(card.json().submission).toMatchObject({ comment: 'две машины, вторая после обеда' });
  });

  it('внутренняя загрузка признака не получает', async () => {
    const id = randomUUID();
    await sql`INSERT INTO source_bundles (id, bundle_hash, kind, direction, site_id, status)
      VALUES (${id}, ${'hash-internal'}, 'mixed', 'inbound', ${siteId}, 'parsed')`;
    const docId = await document(id);

    const row = (await list()).json().items.find((r: { id: string }) => r.id === docId);
    expect(row.fromSupplierPortal).toBe(false);
    expect((await detail(docId)).json().submission).toBeNull();
  });

  it('две отправки на пакет НЕ дублируют документ в списке', async () => {
    const bundleId = await publicBundle('hash-twice', 'первый комментарий');
    await sql`INSERT INTO ingest_events
        (bundle_id, channel, public_ticket, submission_comment, submitter_ip, submission_manifest)
      VALUES (${bundleId}, 'public', ${randomUUID().slice(0, 22)}, 'второй комментарий',
              '203.0.113.8', ${JSON.stringify([{ filename: 'b.pdf', accepted: true }])}::jsonb)`;
    const docId = await document(bundleId);

    const body = (await list()).json();
    const matches = body.items.filter((r: { id: string }) => r.id === docId);
    expect(matches).toHaveLength(1);
    expect(body.total).toBe(1);

    // В карточке — последняя отправка: комментарий из самой свежей.
    const card = await detail(docId);
    expect(card.json().submission.comment).toBe('второй комментарий');
  });

  it('инспектор видит комментарий поставщика', async () => {
    // Контактов больше нет, персональных данных в отправке не осталось —
    // комментарий про поставку инспектору на объекте как раз полезен.
    const bundleId = await publicBundle('hash-role', 'машина после обеда');
    const docId = await document(bundleId);

    currentUser = inspector;
    const card = await detail(docId);
    expect(card.statusCode).toBe(200);
    expect(card.json().fromSupplierPortal).toBe(true);
    expect(card.json().submission.comment).toBe('машина после обеда');
  });
});
