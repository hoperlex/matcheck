/**
 * Служебная запись пакета не должна доходить до инспектора.
 *
 * Когда менеджер загружает документы, до разбора живёт техническая запись
 * `source_documents` (kind='transport_waybill', status='queued'). Раньше она
 * уезжала в дельту `/sync` и висела на планшете фантомом до logout/login, а
 * после разбора удалялась без tombstone.
 *
 * Отличать её по `kind` нельзя — у реальных накладных он такой же, поэтому
 * фильтр идёт по флагу `is_technical`.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sourceDocumentRoutes } from '../../src/routes/source-documents.js';
import { syncRoutes } from '../../src/routes/sync.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('служебные записи пакета (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  let currentUser: AuthUser;

  const siteId = randomUUID();
  const inspectorId = randomUUID();
  const managerId = randomUUID();
  const realDocId = randomUUID();
  const techDocId = randomUUID();

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql) as never);
    app.decorate('queues', { updParse: { add: async () => ({ id: 'j' }) } } as never);
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
    await app.register(syncRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'TCH'}, 'Technical')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id) VALUES
      (${inspectorId}, ${`insp-${inspectorId}@test`}, 'x', 'inspector_kpp', ${siteId}),
      (${managerId}, ${`mgr-${managerId}@test`}, 'x', 'manager', NULL)`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM users WHERE id IN (${inspectorId}, ${managerId})`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    // Реальный документ и служебная запись — оба «свежие» и на одном объекте.
    // У распознанного УПД номер, дата и сумма обязательны (source_upd_required).
    await sql`INSERT INTO source_documents
        (id, kind, direction, origin, status, site_id, doc_number, doc_date, total_sum, is_technical)
      VALUES (${realDocId}, 'upd', 'inbound', 'manual_pdf', 'parsed', ${siteId},
        'УПД-1', DATE '2026-07-30', 1000.00, false)`;
    await sql`INSERT INTO source_documents (id, kind, direction, origin, status, site_id, is_technical)
      VALUES (${techDocId}, 'transport_waybill', 'inbound', 'manual_pdf', 'queued', ${siteId}, true)`;
    currentUser = { id: inspectorId, role: 'inspector_kpp', siteId } as AuthUser;
  });

  it('дельта /sync отдаёт реальный документ и не отдаёт служебный', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/sync?windowDays=90' });
    expect(res.statusCode).toBe(200);

    const ids: string[] = res.json().sourceDocuments.map((d: { id: string }) => d.id);
    expect(ids).toContain(realDocId);
    expect(ids).not.toContain(techDocId);
  });

  it('reconcile не считает служебную запись существующей на сервере', async () => {
    // Иначе клиент, у которого её нет, получал бы её как «пропавшую» на каждом
    // проходе сверки.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/reconcile',
      payload: {
        since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        deliveries: [],
        shipments: [],
        sourceDocuments: [{ id: techDocId, version: 1 }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Служебной записи для клиента не существует: сервер сообщает, что её нет.
    expect(body.sourceDocuments.missingOnServer).toContain(techDocId);
    expect(body.sourceDocuments.missingOnClient ?? []).not.toContain(techDocId);
  });

  it('список документов в портале служебную запись не показывает', async () => {
    currentUser = { id: managerId, role: 'manager', siteId: null } as AuthUser;
    const res = await app.inject({ method: 'GET', url: '/api/v1/source-documents?limit=100' });

    expect(res.statusCode).toBe(200);
    const ids: string[] = res.json().items.map((d: { id: string }) => d.id);
    expect(ids).toContain(realDocId);
    expect(ids).not.toContain(techDocId);
  });

  it('счётчик списка служебные записи не учитывает', async () => {
    currentUser = { id: managerId, role: 'manager', siteId: null } as AuthUser;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/source-documents?limit=100&siteIds=${siteId}`,
    });
    expect(res.json().total).toBe(1);
  });

  // Списками дело не ограничивается: со сборкой логических УПД служебной
  // записью стал ещё и промежуточный документ поставки. До публикации он
  // содержит половину распознанного комплекта, и открыть его по прямому id
  // (равно как отредактировать или удалить) нельзя — иначе менеджер увидит
  // документ, состав которого ещё меняется.
  it('карточка служебной записи отвечает 404 по прямому id', async () => {
    currentUser = { id: managerId, role: 'manager', siteId: null } as AuthUser;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/source-documents/${techDocId}`,
    });
    expect(res.statusCode).toBe(404);

    const real = await app.inject({
      method: 'GET',
      url: `/api/v1/source-documents/${realDocId}`,
    });
    expect(real.statusCode).toBe(200);
  });

  it('редактирование и удаление служебной записи отвечают 404', async () => {
    currentUser = { id: managerId, role: 'manager', siteId: null } as AuthUser;
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/source-documents/${techDocId}`,
      payload: { docNumber: 'подмена' },
    });
    expect(patch.statusCode).toBe(404);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/source-documents/${techDocId}`,
    });
    expect(del.statusCode).toBe(404);

    // Запись на месте: 404 означает «снаружи её нет», а не «удалена».
    const [row] = await sql<{ id: string }[]>`
      SELECT id FROM source_documents WHERE id = ${techDocId}`;
    expect(row?.id).toBe(techDocId);
  });

  it('файл служебной записи не отдаётся', async () => {
    currentUser = { id: managerId, role: 'manager', siteId: null } as AuthUser;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/source-documents/${techDocId}/file`,
    });
    expect(res.statusCode).toBe(404);
  });
});
