/**
 * Идентификатор «машины» (groupId/groupRevision) в /sync и в detail-роуте.
 *
 * Зачем: одна карточка «Машина N» на /uploads = один корневой пакет, из
 * которого выходит несколько документов. Без общего идентификатора планшет
 * рисует их отдельными карточками, и инспектор оформляет одну машину несколько
 * раз. Правило склейки живёт в domain/sourceDocuments/document-group.ts.
 *
 * Что здесь ловится и не ловится больше нигде:
 *   * КОРЕНЬ, а не bundle_id документа. Транспортную накладную router
 *     разворачивает в ДОЧЕРНИЙ пакет, и документ висит уже на нём. Наивное
 *     `sd.bundle_id` развалило бы машину на две группы — при полностью зелёном
 *     тесте на «две УПД в одном пакете»;
 *   * legacy-сборка отдаёт null. Там «файл = документ», и склейка страниц одной
 *     УПД дала бы задвоенный список позиций;
 *   * detail-роут отдаёт то же самое, что /sync. Планшет дотягивает через него
 *     документы после дельты (reconcile и backfill привязанных УПД), и
 *     пропущенное поле навсегда осталось бы NULL у всего закэшированного:
 *     дельта по updated_at новую колонку не привозит. Схема разрешает оба поля
 *     .optional(), так что забытая строчка проходит валидацию молча — ровно как
 *     и в sync-consignee.
 *
 * Запуск: см. заголовок sync-consignee.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { syncRoutes } from '../../src/routes/sync.js';
import type { AuthUser } from '../../src/plugins/auth.js';

vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  putObject: vi.fn(),
  presign: vi.fn(),
  getObject: vi.fn(),
  deleteObject: vi.fn(),
}));

const { sourceDocumentRoutes } = await import('../../src/routes/source-documents.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('группа документов одной машины (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  let currentUser: AuthUser;

  const siteId = randomUUID();
  const inspectorId = randomUUID();

  // Машина 1: logical_v1. Корневой пакет + дочерний пакет накладной — так их
  // и раскладывает router. Две УПД висят на корне, ТН — на дочернем.
  const rootBundleId = randomUUID();
  const childBundleId = randomUUID();
  const updAId = randomUUID();
  const updBId = randomUUID();
  const waybillId = randomUUID();

  // Машина 2: та же форма, но legacy-сборка.
  const legacyBundleId = randomUUID();
  const legacyDocId = randomUUID();

  // Документ вообще без пакета — путь EDO/mail.
  const looseDocId = randomUUID();

  const GROUP_REVISION = 7;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    app.decorate('db', drizzle(sql) as never);
    app.decorate('queues', { updParse: { add: vi.fn() } } as never);
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
    await app.register(syncRoutes);
    await app.register(sourceDocumentRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name)
              VALUES (${siteId}, ${`GRP${Date.now() % 10000}`}, 'Группа машины')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
              VALUES (${inspectorId}, ${`grp-${inspectorId}@test`}, 'x', 'inspector_kpp', ${siteId})`;

    // bundle_hash уникален в пределах таблицы, а базу делят все наборы.
    const hash = (s: string) => `${s}${randomUUID().replace(/-/g, '')}`.slice(0, 64);

    await sql`INSERT INTO source_bundles
        (id, bundle_hash, direction, site_id, status, doc_count, kind,
         assembly_version, published_generation, group_revision)
      VALUES (${rootBundleId}, ${hash('root')}, 'inbound', ${siteId}, 'parsed', 3, 'mixed',
              'logical_v1', 0, ${GROUP_REVISION})`;
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, direction, site_id, status, doc_count, kind,
         assembly_version, parent_bundle_id, group_revision)
      VALUES (${childBundleId}, ${hash('child')}, 'inbound', ${siteId}, 'parsed', 1, 'waybill',
              'legacy', ${rootBundleId}, 1)`;
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, direction, site_id, status, doc_count, kind,
         assembly_version, group_revision)
      VALUES (${legacyBundleId}, ${hash('legacy')}, 'inbound', ${siteId}, 'parsed', 1, 'mixed',
              'legacy', 4)`;

    const doc = (id: string, num: string, kind: string, bundleId: string | null) => sql`
      INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum, bundle_id)
      VALUES (${id}, ${kind}, false, 'inbound', 'manual_pdf', 'parsed', ${siteId}, now(),
              ${num}, now(), 100, ${bundleId})`;

    await doc(updAId, 'ГРП-1', 'upd', rootBundleId);
    await doc(updBId, 'ГРП-2', 'upd', rootBundleId);
    // Ключевой случай: документ на ДОЧЕРНЕМ пакете должен получить id корня.
    await doc(waybillId, 'ГРП-192', 'transport_waybill', childBundleId);
    await doc(legacyDocId, 'ГРП-L', 'upd', legacyBundleId);
    await doc(looseDocId, 'ГРП-0', 'upd', null);

    currentUser = {
      id: inspectorId,
      role: 'inspector_kpp',
      siteId,
      contractorCustomerId: null,
      sessionId: randomUUID(),
    } as unknown as AuthUser;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE parent_bundle_id = ${rootBundleId}`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await sql`DELETE FROM users WHERE id = ${inspectorId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  async function syncDocs(): Promise<Record<string, unknown>[]> {
    const res = await app.inject({ method: 'GET', url: '/api/v1/sync?windowDays=90' });
    expect(res.statusCode).toBe(200);
    return (res.json() as { sourceDocuments: Record<string, unknown>[] }).sourceDocuments;
  }

  async function detailDoc(id: string): Promise<Record<string, unknown>> {
    const res = await app.inject({ method: 'GET', url: `/api/v1/source-documents/${id}` });
    expect(res.statusCode).toBe(200);
    return res.json() as Record<string, unknown>;
  }

  it('/sync: все документы машины получают один groupId и одну groupRevision', async () => {
    const docs = await syncDocs();
    const byId = new Map(docs.map((d) => [d.id as string, d]));

    for (const id of [updAId, updBId, waybillId]) {
      expect(byId.get(id)!.groupId, `документ ${id}`).toBe(rootBundleId);
      expect(byId.get(id)!.groupRevision, `документ ${id}`).toBe(GROUP_REVISION);
    }
  });

  it('/sync: документ на дочернем пакете отдаёт id КОРНЯ, а не своего пакета', async () => {
    const doc = (await syncDocs()).find((d) => d.id === waybillId)!;
    expect(doc.groupId).toBe(rootBundleId);
    expect(doc.groupId).not.toBe(childBundleId);
    // И revision тоже корневая: у дочернего пакета она своя (1).
    expect(doc.groupRevision).toBe(GROUP_REVISION);
  });

  it('/sync: legacy-сборка не группируется — там «файл = документ»', async () => {
    const doc = (await syncDocs()).find((d) => d.id === legacyDocId)!;
    expect(doc).toHaveProperty('groupId');
    expect(doc.groupId).toBeNull();
    expect(doc.groupRevision).toBeNull();
  });

  it('/sync: документ без пакета отдаёт null, а не undefined', async () => {
    const doc = (await syncDocs()).find((d) => d.id === looseDocId)!;
    expect(doc).toHaveProperty('groupId');
    expect(doc.groupId).toBeNull();
    expect(doc.groupRevision).toBeNull();
  });

  it('detail-роут отдаёт те же поля: иначе reconcile не дотянет их до планшета', async () => {
    const waybill = await detailDoc(waybillId);
    expect(waybill.groupId).toBe(rootBundleId);
    expect(waybill.groupRevision).toBe(GROUP_REVISION);

    const legacy = await detailDoc(legacyDocId);
    expect(legacy).toHaveProperty('groupId');
    expect(legacy.groupId).toBeNull();
    expect(legacy.groupRevision).toBeNull();
  });
});
