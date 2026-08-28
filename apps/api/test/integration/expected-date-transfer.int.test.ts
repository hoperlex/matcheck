/**
 * Дата поставки: правка в карточке переносит её МАШИНОЙ, как и объект.
 *
 * Почему набор интеграционный. Проверяется ровно то, чего не видно в коде: что
 * дату получили все строки дерева пакетов (включая служебную запись и сами
 * пакеты — из них растут заглушки и дозагрузки), что канонический ключ корня
 * пересчитан по компоненту даты, что снятие даты помечает скрытыми ВСЕ
 * документы машины, а не один правленый.
 *
 * Опорный случай: поставщик указал вчерашний день, менеджер правит «Дату
 * поставки» у одной строки. До этой работы менялась ровно она: соседи ехали на
 * планшет со старой датой, пакет хранил исходную, и следующая дозагрузка
 * возвращала её обратно.
 *
 * Запуск: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test
 * Без переменной набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';
import {
  idempotencyKeyOf,
  bundleIdentityHashOf,
} from '../../src/domain/sourceDocuments/bundle-key.js';

vi.mock('../../src/instrument.js', () => ({}));
const s3 = vi.hoisted(() => ({ headObject: vi.fn(async () => true) }));
vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  presign: vi.fn(),
  getObject: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  headObject: s3.headObject,
}));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const DAY_0 = '2026-08-26';
const DAY_1 = '2026-08-27';

suite('дата поставки у поставки с портала (реальный PostgreSQL)', { timeout: 40_000 }, () => {
  let sql: ReturnType<typeof postgres>;
  const siteA = randomUUID();
  const siteB = randomUUID();
  const contractorId = randomUUID();
  const manager = { id: randomUUID(), role: 'manager', siteId: null } as unknown as AuthUser;

  const hash = (p: string) => `${p}${randomUUID().replace(/-/g, '')}`.slice(0, 64);

  async function buildApp(): Promise<FastifyInstance> {
    // Рубильник включён: метки видимости и ревизия машины пишутся под ним, а
    // именно они уносят снятую дату на планшет.
    process.env.GROUPS_ROLLOUT = '1';
    vi.resetModules();
    const { sourceDocumentRoutes } = await import('../../src/routes/source-documents.js');

    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    app.decorate('db', drizzle(sql, { schema, casing: 'snake_case' }) as never);
    app.decorate('queues', { updParse: { add: vi.fn() }, s3Cleanup: { add: vi.fn() } } as never);
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
    return app;
  }

  /** Пакет. Публичный канал ставится только на корень — как в бою. */
  async function seedBundle(opts: {
    id: string;
    siteId: string;
    parent?: string | null;
    portal?: boolean;
    idempotencyKey?: string | null;
  }): Promise<void> {
    const key =
      opts.idempotencyKey === undefined
        ? idempotencyKeyOf({
            siteId: opts.siteId,
            direction: 'inbound',
            expectedDate: DAY_0,
            contentHash: opts.id.replace(/-/g, ''),
          })
        : opts.idempotencyKey;
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, idempotency_key, direction, site_id, status, kind,
         assembly_version, active_upload_generation, parent_bundle_id, expected_date)
      VALUES (${opts.id}, ${key ? bundleIdentityHashOf(key) : hash('ed')}, ${key},
              'inbound', ${opts.siteId}, 'parsed', 'mixed', 'legacy', 0,
              ${opts.parent ?? null}, ${DAY_0})`;
    if (opts.portal && !opts.parent) {
      await sql`INSERT INTO ingest_events (bundle_id, channel, public_ticket)
                VALUES (${opts.id}, 'public', ${randomUUID().slice(0, 20)})`;
    }
  }

  /** Обработанный документ: реквизиты полные, значит на планшет он едет. */
  async function seedDoc(opts: {
    id: string;
    bundleId: string | null;
    siteId: string;
    technical?: boolean;
  }): Promise<void> {
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum, bundle_id, expected_date, contractor_id)
      VALUES (${opts.id}, 'upd', ${opts.technical ?? false}, 'inbound', 'manual_pdf',
              'parsed', ${opts.siteId}, now(), ${`ED-${opts.id.slice(0, 6)}`},
              now(), 100, ${opts.bundleId}, ${DAY_0}, ${contractorId})`;
    // Позиция обязательна: сохранение карточки пересчитывает исход разбора по
    // правилу «номер + материалы», и документ без строк ушёл бы в partial_parse.
    await sql`INSERT INTO source_document_items
        (source_document_id, name_raw, qty, unit, price, sum, line_no)
      VALUES (${opts.id}, 'Труба', 1, 'шт', 100, 100, 1)`;
  }

  /** Машина с портала: корень (два документа + служебная запись) и дочерний пакет. */
  async function seedMachine(siteId: string): Promise<{
    rootId: string;
    childId: string;
    docIds: string[];
    technicalId: string;
  }> {
    const rootId = randomUUID();
    const childId = randomUUID();
    const docIds = [randomUUID(), randomUUID(), randomUUID()];
    const technicalId = randomUUID();
    await seedBundle({ id: rootId, siteId, portal: true });
    await seedBundle({ id: childId, siteId, parent: rootId, idempotencyKey: null });
    await seedDoc({ id: docIds[0]!, bundleId: rootId, siteId });
    await seedDoc({ id: docIds[1]!, bundleId: rootId, siteId });
    await seedDoc({ id: docIds[2]!, bundleId: childId, siteId });
    await seedDoc({ id: technicalId, bundleId: rootId, siteId, technical: true });
    return { rootId, childId, docIds, technicalId };
  }

  /**
   * Дата читается СТРОКОЙ: expected_date лежит в timestamp без таймзоны, и
   * сравнение через JS-Date зависело бы от TZ процесса — ровно та ошибка,
   * которую эта работа и убирает.
   */
  async function docRow(id: string) {
    const [r] = await sql<
      { date_key: string | null; version: number; updated_key: string; site_id: string | null }[]
    >`SELECT to_char(expected_date, 'YYYY-MM-DD') AS date_key,
             version,
             to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS.US') AS updated_key,
             site_id
        FROM source_documents WHERE id = ${id}`;
    return r!;
  }

  async function bundleRow(id: string) {
    const [r] = await sql<
      {
        date_key: string | null;
        idempotency_key: string | null;
        bundle_hash: string;
        site_id: string | null;
      }[]
    >`SELECT to_char(expected_date, 'YYYY-MM-DD') AS date_key, idempotency_key, bundle_hash, site_id
        FROM source_bundles WHERE id = ${id}`;
    return r!;
  }

  async function events(docId: string) {
    return await sql<
      { visibility: string; site_id: string | null; group_id: string | null }[]
    >`SELECT visibility, site_id, group_id FROM source_document_visibility_events
       WHERE source_document_id = ${docId} ORDER BY created_at, id`;
  }

  async function patchDoc(app: FastifyInstance, docId: string, payload: Record<string, unknown>) {
    return await app.inject({
      method: 'PATCH',
      url: `/api/v1/source-documents/${docId}`,
      payload,
    });
  }

  async function cleanup(): Promise<void> {
    for (const site of [siteA, siteB]) {
      await sql`DELETE FROM delivery_sources WHERE source_document_id IN (
        SELECT id FROM source_documents WHERE site_id = ${site})`;
      await sql`DELETE FROM deliveries WHERE site_id = ${site}`;
      await sql`DELETE FROM source_document_visibility_events WHERE site_id = ${site}`;
      await sql`DELETE FROM source_document_items WHERE source_document_id IN (
        SELECT id FROM source_documents WHERE site_id = ${site})`;
      await sql`DELETE FROM source_documents WHERE site_id = ${site}`;
      await sql`DELETE FROM ingest_events WHERE bundle_id IN (
        SELECT id FROM source_bundles WHERE site_id = ${site})`;
      await sql`DELETE FROM source_bundles WHERE site_id = ${site} AND parent_bundle_id IS NOT NULL`;
      await sql`DELETE FROM source_bundles WHERE site_id = ${site}`;
    }
    await sql`DELETE FROM source_documents WHERE contractor_id = ${contractorId}`;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 6 });
    await sql`INSERT INTO sites (id, code, name) VALUES (${siteA}, ${`EDA${Date.now() % 10000}`}, 'Объект A')`;
    await sql`INSERT INTO sites (id, code, name) VALUES (${siteB}, ${`EDB${Date.now() % 10000}`}, 'Объект B')`;
    await sql`INSERT INTO counterparties (id, inn, name, is_contractor)
              VALUES (${contractorId}, ${`75${String(Date.now()).slice(-8)}`}, 'Подрядчик даты', true)`;
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup();
    await sql`DELETE FROM counterparties WHERE id = ${contractorId}`;
    await sql`DELETE FROM sites WHERE id IN (${siteA}, ${siteB})`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(cleanup);

  it('дату получают все документы машины, служебная запись и оба пакета', async () => {
    const app = await buildApp();
    try {
      const m = await seedMachine(siteA);

      const res = await patchDoc(app, m.docIds[0]!, { expectedDate: DAY_1 });
      expect(res.statusCode).toBe(200);

      for (const id of m.docIds) expect((await docRow(id)).date_key).toBe(DAY_1);
      // Служебная запись — источник объекта и даты для заглушек и сегментов.
      expect((await docRow(m.technicalId)).date_key).toBe(DAY_1);
      // Пакеты: из них дату наследует всё, что появится в машине позже.
      expect((await bundleRow(m.rootId)).date_key).toBe(DAY_1);
      expect((await bundleRow(m.childId)).date_key).toBe(DAY_1);
    } finally {
      await app.close();
    }
  });

  it('канонический ключ корня пересчитан по компоненту даты', async () => {
    const app = await buildApp();
    try {
      const m = await seedMachine(siteA);
      const before = await bundleRow(m.rootId);

      expect((await patchDoc(app, m.docIds[0]!, { expectedDate: DAY_1 })).statusCode).toBe(200);

      const after = await bundleRow(m.rootId);
      expect(after.idempotency_key).toBe(before.idempotency_key!.replace(DAY_0, DAY_1));
      expect(after.bundle_hash).toBe(bundleIdentityHashOf(after.idempotency_key!));
    } finally {
      await app.close();
    }
  });

  it('объект и дата одним сохранением дают один согласованный ключ', async () => {
    const app = await buildApp();
    try {
      const m = await seedMachine(siteA);

      const res = await patchDoc(app, m.docIds[0]!, { siteId: siteB, expectedDate: DAY_1 });
      expect(res.statusCode).toBe(200);

      const root = await bundleRow(m.rootId);
      expect(root.site_id).toBe(siteB);
      expect(root.date_key).toBe(DAY_1);
      // Ключ несёт ОБА новых компонента: пересчёт один на оба переноса.
      expect(root.idempotency_key).toBe(
        idempotencyKeyOf({
          siteId: siteB,
          direction: 'inbound',
          expectedDate: DAY_1,
          contentHash: m.rootId.replace(/-/g, ''),
        }),
      );
      expect(root.bundle_hash).toBe(bundleIdentityHashOf(root.idempotency_key!));
      for (const id of m.docIds) {
        const row = await docRow(id);
        expect(row.site_id).toBe(siteB);
        expect(row.date_key).toBe(DAY_1);
      }
    } finally {
      await app.close();
    }
  });

  it('прежняя дата — no-op: ни строк, ни ключа', async () => {
    // Проверяется САМА операция, а не сохранение карточки: форма кладёт в тело
    // ещё и позиции, а их замена законно поднимает ревизию всей машины.
    const app = await buildApp();
    try {
      const m = await seedMachine(siteA);
      const before = await Promise.all([...m.docIds, m.technicalId].map(docRow));
      const rootBefore = await bundleRow(m.rootId);

      const { lockMachine, resyncMachineBundleKeys } = await import(
        '../../src/domain/sourceDocuments/machine-lock.js'
      );
      const { transferExpectedDate } = await import(
        '../../src/domain/sourceDocuments/expected-date-transfer.js'
      );
      const db = drizzle(sql, { schema, casing: 'snake_case' });
      const outcome = await db.transaction(async (tx) => {
        const lock = await lockMachine(tx as never, m.docIds[0]!);
        const t = await transferExpectedDate(tx as never, lock!, DAY_0);
        await resyncMachineBundleKeys(tx as never, lock!, {
          ...(t.changed ? { expectedDate: t.toDateKey } : {}),
        });
        return t;
      });

      expect(outcome).toEqual({ changed: false });
      const after = await Promise.all([...m.docIds, m.technicalId].map(docRow));
      for (const [i, row] of after.entries()) {
        expect(row.version).toBe(before[i]!.version);
        expect(row.updated_key).toBe(before[i]!.updated_key);
        expect(row.date_key).toBe(DAY_0);
      }
      expect((await bundleRow(m.rootId)).idempotency_key).toBe(rootBefore.idempotency_key);
    } finally {
      await app.close();
    }
  });

  it('непортальный пакет: дата у одного документа, сосед и пакет не тронуты', async () => {
    const app = await buildApp();
    try {
      // Почта или ручная загрузка: пачка файлов не означает один рейс.
      const bundleId = randomUUID();
      const mine = randomUUID();
      const neighbour = randomUUID();
      await seedBundle({ id: bundleId, siteId: siteA, portal: false });
      await seedDoc({ id: mine, bundleId, siteId: siteA });
      await seedDoc({ id: neighbour, bundleId, siteId: siteA });

      expect((await patchDoc(app, mine, { expectedDate: DAY_1 })).statusCode).toBe(200);

      expect((await docRow(mine)).date_key).toBe(DAY_1);
      expect((await docRow(neighbour)).date_key).toBe(DAY_0);
      expect((await bundleRow(bundleId)).date_key).toBe(DAY_0);
    } finally {
      await app.close();
    }
  });

  it('снятая дата гасит машину целиком — метка есть у каждого документа', async () => {
    const app = await buildApp();
    try {
      const m = await seedMachine(siteA);

      expect((await patchDoc(app, m.docIds[0]!, { expectedDate: null })).statusCode).toBe(200);

      for (const id of m.docIds) expect((await docRow(id)).date_key).toBeNull();
      expect((await bundleRow(m.rootId)).date_key).toBeNull();
      // Без метки у СОСЕДЕЙ они гаснут молча: дельта их больше не привозит, а
      // сверка лишнее не удаляет — карточка залипла бы на планшете навсегда.
      for (const id of m.docIds) {
        const log = await events(id);
        expect(log.at(-1)).toMatchObject({ visibility: 'hidden', site_id: siteA });
        expect(log.at(-1)!.group_id).toBe(m.rootId);
      }
    } finally {
      await app.close();
    }
  });

  it('новые документы машины берут дату из БД, а не из строки пакета в памяти', async () => {
    // Ровно та гонка, ради которой правило и заводилось: воркер читает пакет ДО
    // транзакции, менеджер в этот момент правит дату, задание доходит до
    // вставки уже после коммита. Снимок пакета здесь намеренно старый.
    const app = await buildApp();
    try {
      const m = await seedMachine(siteA);
      const staleBundle = (await sql`SELECT * FROM source_bundles WHERE id = ${m.rootId}`)[0];
      expect((await patchDoc(app, m.docIds[0]!, { expectedDate: DAY_1 })).statusCode).toBe(200);

      const s3Key = `test/${m.rootId}/scan.pdf`;
      await sql`INSERT INTO bundle_import_items
          (bundle_id, source_filename, input_s3_key, mime_type, size_bytes,
           upload_generation, processing_mode, status)
        VALUES (${m.rootId}, 'scan.pdf', ${s3Key}, 'application/pdf', 100, 0, 'auto', 'skipped')`;

      const { ensureDocumentForRegistryRow, selectRowsWithoutDocument, stubReasonForRow } =
        await import('../../src/domain/sourceDocuments/stub-documents.js');
      const db = drizzle(sql, { schema, casing: 'snake_case' });
      const rows = await selectRowsWithoutDocument(db as never, { bundleId: m.rootId });
      expect(rows).toHaveLength(1);
      const res = await ensureDocumentForRegistryRow({
        db: db as never,
        row: rows[0]!,
        bundle: staleBundle as never,
        reason: stubReasonForRow(rows[0]!),
      });
      expect(res.action).toBe('created');

      expect((await docRow(res.documentId!)).date_key).toBe(DAY_1);
    } finally {
      await sql`DELETE FROM bundle_import_items WHERE bundle_id IN (
        SELECT id FROM source_bundles WHERE site_id = ${siteA})`;
      await app.close();
    }
  });

  it('дата машины видна из дочернего пакета, а снятая не воскресает', async () => {
    // То, чем пользуется воркер в момент вставки. Второй случай важнее: пустая
    // дата — это НАМЕРЕННО снятая дата, и coalesce с датой дочернего пакета
    // вернул бы машину во «вчера».
    const app = await buildApp();
    try {
      const m = await seedMachine(siteA);
      expect((await patchDoc(app, m.docIds[0]!, { expectedDate: DAY_1 })).statusCode).toBe(200);

      const { resolveMachineExpectedDate } = await import(
        '../../src/domain/sourceDocuments/expected-date-transfer.js'
      );
      const db = drizzle(sql, { schema, casing: 'snake_case' }) as never;
      const asKey = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
      expect(asKey(await resolveMachineExpectedDate(db, m.childId))).toBe(DAY_1);
      expect(asKey(await resolveMachineExpectedDate(db, m.rootId))).toBe(DAY_1);

      expect((await patchDoc(app, m.docIds[0]!, { expectedDate: null })).statusCode).toBe(200);
      // Дочернему пакету дату возвращаем руками — так выглядела бы строка,
      // пережившая частичное обновление: значение корня обязано победить.
      await sql`UPDATE source_bundles SET expected_date = ${DAY_0} WHERE id = ${m.childId}`;
      expect(await resolveMachineExpectedDate(db, m.childId)).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('по машине оформлена приёмка: дату менять можно, объект — нельзя', async () => {
    const app = await buildApp();
    try {
      const m = await seedMachine(siteA);
      const deliveryId = randomUUID();
      await sql`INSERT INTO deliveries (id, site_id, status_id)
                VALUES (${deliveryId}, ${siteA},
                        (SELECT id FROM statuses WHERE entity_type='delivery' AND code='not_filled'))`;
      await sql`INSERT INTO delivery_sources (delivery_id, source_document_id)
                VALUES (${deliveryId}, ${m.docIds[1]!})`;

      // Дата в приёмке не хранится вовсе (там только arrived_at с планшета),
      // поэтому запрещать её правку было бы новым ограничением на пустом месте.
      expect((await patchDoc(app, m.docIds[0]!, { expectedDate: DAY_1 })).statusCode).toBe(200);
      for (const id of m.docIds) expect((await docRow(id)).date_key).toBe(DAY_1);

      const res = await patchDoc(app, m.docIds[0]!, { siteId: siteB });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'machine_has_operation' });
    } finally {
      await app.close();
    }
  });
});
