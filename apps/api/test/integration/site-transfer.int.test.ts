/**
 * Перенос объекта: поставка с портала переезжает МАШИНОЙ, а планшет прежнего
 * объекта узнаёт об этом.
 *
 * Почему набор интеграционный. Проверяются ровно те вещи, которых не видно в
 * коде: что переехали все строки дерева пакетов, что дельта /sync прежнего
 * объекта отдала tombstone (а не промолчала, как раньше), что канонический ключ
 * пакета пересчитан и столкновение с чужим комплектом стало отказом, а не 500.
 *
 * Опорный случай — «карточка со скриншота»: менеджер увидел, что поставщик
 * выбрал не тот объект, и правит поле «Объект» в реквизитах одного документа.
 * До этой работы уезжал он один: пакет и соседи оставались на прежнем объекте,
 * а карточка машины жила у прежнего инспектора вечно.
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
vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  presign: vi.fn(),
  getObject: vi.fn(),
  deleteObject: vi.fn(),
}));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('перенос объекта у поставки (реальный PostgreSQL)', { timeout: 40_000 }, () => {
  let sql: ReturnType<typeof postgres>;
  const siteA = randomUUID();
  const siteB = randomUUID();
  const contractorId = randomUUID();
  const manager = { id: randomUUID(), role: 'manager', siteId: null } as unknown as AuthUser;

  const hash = (p: string) => `${p}${randomUUID().replace(/-/g, '')}`.slice(0, 64);

  /**
   * Приложение с нужным положением рубильника.
   *
   * Модули переимпортируются: loadEnv кеширует разбор окружения при первом
   * обращении, а нам нужны оба режима в одном наборе — правило видимости
   * (GROUPS_ROLLOUT) и есть то, от чего перенос обязан НЕ зависеть.
   */
  async function buildApp(rollout: '0' | '1', user: AuthUser): Promise<FastifyInstance> {
    process.env.GROUPS_ROLLOUT = rollout;
    vi.resetModules();
    const { sourceDocumentRoutes } = await import('../../src/routes/source-documents.js');
    const { syncRoutes } = await import('../../src/routes/sync.js');
    const { deliveryRoutes } = await import('../../src/routes/deliveries.js');

    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    app.decorate('db', drizzle(sql, { schema, casing: 'snake_case' }) as never);
    app.decorate('queues', { updParse: { add: vi.fn() }, s3Cleanup: { add: vi.fn() } } as never);
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
    await app.register(syncRoutes);
    await app.register(deliveryRoutes);
    await app.ready();
    return app;
  }

  function inspectorOf(siteId: string): AuthUser {
    return {
      id: randomUUID(),
      role: 'inspector_kpp',
      siteId,
      contractorCustomerId: null,
      sessionId: randomUUID(),
    } as unknown as AuthUser;
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
            expectedDate: '2026-08-26',
            contentHash: opts.id.replace(/-/g, ''),
          })
        : opts.idempotencyKey;
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, idempotency_key, direction, site_id, status, kind,
         assembly_version, active_upload_generation, parent_bundle_id, expected_date)
      VALUES (${opts.id}, ${key ? bundleIdentityHashOf(key) : hash('st')}, ${key},
              'inbound', ${opts.siteId}, 'parsed', 'mixed', 'legacy', 0,
              ${opts.parent ?? null}, '2026-08-26')`;
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
    number?: string;
  }): Promise<void> {
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum, bundle_id, expected_date, contractor_id)
      VALUES (${opts.id}, 'upd', ${opts.technical ?? false}, 'inbound', 'manual_pdf',
              'parsed', ${opts.siteId}, now(), ${opts.number ?? `ST-${opts.id.slice(0, 6)}`},
              now(), 100, ${opts.bundleId}, '2026-08-26', ${contractorId})`;
    // Позиция обязательна: сохранение карточки пересчитывает исход разбора по
    // правилу «номер + материалы», и документ без строк ушёл бы в partial_parse,
    // то есть перестал бы быть видимым — тест ловил бы не то.
    await sql`INSERT INTO source_document_items
        (source_document_id, name_raw, qty, unit, price, sum, line_no)
      VALUES (${opts.id}, 'Труба', 1, 'шт', 100, 100, 1)`;
  }

  /**
   * Машина с портала: корневой пакет (два документа плюс служебная запись) и
   * дочерний пакет накладной со своим документом.
   */
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

  async function docRow(id: string) {
    const [r] = await sql<
      { site_id: string | null; version: number; updated_at: Date }[]
    >`SELECT site_id, version, updated_at FROM source_documents WHERE id = ${id}`;
    return r!;
  }

  async function bundleRow(id: string) {
    const [r] = await sql<
      { site_id: string | null; idempotency_key: string | null; bundle_hash: string }[]
    >`SELECT site_id, idempotency_key, bundle_hash FROM source_bundles WHERE id = ${id}`;
    return r!;
  }

  async function events(docId: string) {
    return await sql<
      { visibility: string; site_id: string | null; reason: string | null }[]
    >`SELECT visibility, site_id, reason FROM source_document_visibility_events
       WHERE source_document_id = ${docId} ORDER BY created_at, id`;
  }

  async function patchSite(app: FastifyInstance, docId: string, siteId: string | null) {
    return await app.inject({
      method: 'PATCH',
      url: `/api/v1/source-documents/${docId}`,
      payload: { siteId },
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
    // Документы без объекта и без пакета — отдельным проходом по подрядчику.
    await sql`DELETE FROM source_documents WHERE contractor_id = ${contractorId}`;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 6 });
    await sql`INSERT INTO sites (id, code, name) VALUES (${siteA}, ${`STA${Date.now() % 10000}`}, 'Объект A')`;
    await sql`INSERT INTO sites (id, code, name) VALUES (${siteB}, ${`STB${Date.now() % 10000}`}, 'Объект B')`;
    await sql`INSERT INTO counterparties (id, inn, name, is_contractor)
              VALUES (${contractorId}, ${`74${String(Date.now()).slice(-8)}`}, 'Подрядчик переноса', true)`;
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup();
    await sql`DELETE FROM counterparties WHERE id = ${contractorId}`;
    await sql`DELETE FROM sites WHERE id IN (${siteA}, ${siteB})`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(cleanup);

  it('переезжает вся машина: документы, служебная запись и оба пакета', async () => {
    const app = await buildApp('1', manager);
    try {
      const m = await seedMachine(siteA);
      const before = await docRow(m.docIds[1]!);

      const res = await patchSite(app, m.docIds[0]!, siteB);
      expect(res.statusCode).toBe(200);

      for (const id of m.docIds) {
        const row = await docRow(id);
        expect(row.site_id).toBe(siteB);
      }
      // Соседу по машине подняли version и updated_at — иначе новый объект не
      // получил бы его ни дельтой (по updated_at), ни сверкой (по version).
      const after = await docRow(m.docIds[1]!);
      expect(after.version).toBeGreaterThan(before.version);
      expect(new Date(after.updated_at).getTime()).toBeGreaterThan(
        new Date(before.updated_at).getTime(),
      );
      // Служебная запись тоже на новом объекте: из неё растут заглушки.
      expect((await docRow(m.technicalId)).site_id).toBe(siteB);
      expect((await bundleRow(m.rootId)).site_id).toBe(siteB);
      expect((await bundleRow(m.childId)).site_id).toBe(siteB);
    } finally {
      await app.close();
    }
  });

  it('канонический ключ корня пересчитан под новый объект', async () => {
    const app = await buildApp('1', manager);
    try {
      const m = await seedMachine(siteA);
      const before = await bundleRow(m.rootId);

      expect((await patchSite(app, m.docIds[0]!, siteB)).statusCode).toBe(200);

      const after = await bundleRow(m.rootId);
      expect(after.idempotency_key).toBe(before.idempotency_key!.replace(siteA, siteB));
      expect(after.bundle_hash).toBe(bundleIdentityHashOf(after.idempotency_key!));
      // Дочерний пакет ключа не имеет — его хеш детерминирован от корня и
      // поколения, объекта в нём нет.
      expect((await bundleRow(m.childId)).idempotency_key).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('на целевом объекте такой же комплект уже загружен — отказ, ничего не перенесено', async () => {
    const app = await buildApp('1', manager);
    try {
      const m = await seedMachine(siteA);
      // Тот же контент на объекте B: ключ отличается только объектом, и после
      // пересчёта наш корень столкнулся бы с ним.
      const rival = randomUUID();
      const rootKey = (await bundleRow(m.rootId)).idempotency_key!;
      await seedBundle({
        id: rival,
        siteId: siteB,
        portal: true,
        idempotencyKey: rootKey.replace(siteA, siteB),
      });

      const res = await patchSite(app, m.docIds[0]!, siteB);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'bundle_exists_on_site' });
      // Транзакция откатилась целиком: ни документы, ни пакет не сдвинулись.
      expect((await docRow(m.docIds[0]!)).site_id).toBe(siteA);
      expect((await bundleRow(m.rootId)).site_id).toBe(siteA);
    } finally {
      await app.close();
    }
  });

  it('по машине уже оформлена приёмка — перенос отклонён', async () => {
    const app = await buildApp('1', manager);
    try {
      const m = await seedMachine(siteA);
      const deliveryId = randomUUID();
      await sql`INSERT INTO deliveries (id, site_id, status_id)
                VALUES (${deliveryId}, ${siteA},
                        (SELECT id FROM statuses WHERE entity_type='delivery' AND code='not_filled'))`;
      // Привязан СОСЕД, а переносим другой документ: занята машина целиком.
      await sql`INSERT INTO delivery_sources (delivery_id, source_document_id)
                VALUES (${deliveryId}, ${m.docIds[1]!})`;

      const res = await patchSite(app, m.docIds[0]!, siteB);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'machine_has_operation' });
      expect((await docRow(m.docIds[0]!)).site_id).toBe(siteA);
    } finally {
      await app.close();
    }
  });

  it('приёмку на прежнем объекте после переноса создать нельзя', async () => {
    const app = await buildApp('1', manager);
    try {
      const m = await seedMachine(siteA);
      expect((await patchSite(app, m.docIds[0]!, siteB)).statusCode).toBe(200);

      const deliveryId = randomUUID();
      await sql`INSERT INTO deliveries (id, site_id, status_id)
                VALUES (${deliveryId}, ${siteA},
                        (SELECT id FROM statuses WHERE entity_type='delivery' AND code='not_filled'))`;
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/deliveries/${deliveryId}/link-source`,
        payload: { sourceDocumentId: m.docIds[0]! },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'source_document_foreign_site' });
    } finally {
      await app.close();
    }
  });

  for (const rollout of ['1', '0'] as const) {
    it(`планшет прежнего объекта получает tombstone, новый — документы (GROUPS_ROLLOUT=${rollout})`, async () => {
      const since = new Date(Date.now() - 60_000).toISOString();
      const appManager = await buildApp(rollout, manager);
      let m: Awaited<ReturnType<typeof seedMachine>>;
      try {
        m = await seedMachine(siteA);
        expect((await patchSite(appManager, m.docIds[0]!, siteB)).statusCode).toBe(200);
      } finally {
        await appManager.close();
      }

      const appA = await buildApp(rollout, inspectorOf(siteA));
      try {
        const res = await appA.inject({ method: 'GET', url: `/api/v1/sync?since=${since}` });
        expect(res.statusCode).toBe(200);
        const body = res.json() as {
          sourceDocuments: { id: string }[];
          deletedIds: { sourceDocuments: string[] };
        };
        expect(body.sourceDocuments.map((d) => d.id)).not.toContain(m.docIds[0]);
        // Ровно та строка, которой раньше не было: без неё карточка машины
        // оставалась у инспектора прежнего объекта навсегда.
        for (const id of m.docIds) {
          expect(body.deletedIds.sourceDocuments).toContain(id);
        }
      } finally {
        await appA.close();
      }

      const appB = await buildApp(rollout, inspectorOf(siteB));
      try {
        const res = await appB.inject({ method: 'GET', url: `/api/v1/sync?since=${since}` });
        const body = res.json() as {
          sourceDocuments: { id: string }[];
          deletedIds: { sourceDocuments: string[] };
        };
        const ids = body.sourceDocuments.map((d) => d.id);
        for (const id of m.docIds) {
          expect(ids).toContain(id);
          expect(body.deletedIds.sourceDocuments).not.toContain(id);
        }
      } finally {
        await appB.close();
      }
    });
  }

  it('непортальный пакет: переезжает один документ, соседа и пакет не трогаем', async () => {
    const app = await buildApp('1', manager);
    try {
      // Почта или ручная загрузка: пачка файлов не означает один рейс.
      const bundleId = randomUUID();
      const mine = randomUUID();
      const neighbour = randomUUID();
      await seedBundle({ id: bundleId, siteId: siteA, portal: false });
      await seedDoc({ id: mine, bundleId, siteId: siteA });
      await seedDoc({ id: neighbour, bundleId, siteId: siteA });

      expect((await patchSite(app, mine, siteB)).statusCode).toBe(200);

      expect((await docRow(mine)).site_id).toBe(siteB);
      expect((await docRow(neighbour)).site_id).toBe(siteA);
      expect((await bundleRow(bundleId)).site_id).toBe(siteA);
      // Метка скрытия адресована ПРЕЖНЕМУ объекту документа, а не объекту
      // пакета: иначе следующий же `visible` затёр бы её.
      const log = await events(mine);
      expect(log[0]).toMatchObject({ visibility: 'hidden', site_id: siteA });
      expect(log.at(-1)).toMatchObject({ visibility: 'visible', site_id: siteB });
      expect(await events(neighbour)).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('документ без пакета переносится сам и получает метку', async () => {
    const app = await buildApp('1', manager);
    try {
      const loneId = randomUUID();
      await seedDoc({ id: loneId, bundleId: null, siteId: siteA });

      expect((await patchSite(app, loneId, siteB)).statusCode).toBe(200);

      expect((await docRow(loneId)).site_id).toBe(siteB);
      const log = await events(loneId);
      expect(log[0]).toMatchObject({ visibility: 'hidden', site_id: siteA });
    } finally {
      await app.close();
    }
  });

  it('объект машины после переноса виден из дочернего пакета', async () => {
    // То, чем пользуется воркер в момент вставки: он читает пакет ДО транзакции,
    // и без этого чтения заглушка легла бы на прежний объект.
    const app = await buildApp('1', manager);
    try {
      const m = await seedMachine(siteA);
      expect((await patchSite(app, m.docIds[0]!, siteB)).statusCode).toBe(200);

      const { resolveMachineSiteId } =
        await import('../../src/domain/sourceDocuments/site-transfer.js');
      const db = drizzle(sql, { schema, casing: 'snake_case' }) as never;
      expect(await resolveMachineSiteId(db, m.childId)).toBe(siteB);
      expect(await resolveMachineSiteId(db, m.rootId)).toBe(siteB);
    } finally {
      await app.close();
    }
  });
});
