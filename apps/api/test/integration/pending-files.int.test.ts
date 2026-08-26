/**
 * Принятый файл виден в «Документах» сразу, а не по итогам разбора.
 *
 * Между приёмом и появлением документа лежит разбор: обычно секунды, при
 * забитой очереди — часы. Всё это время список документов молчал, и менеджер не
 * мог отличить «поставщик не присылал» от «прислал, но мы ещё не разобрали».
 * Единственным местом, где файл был виден, оставалась вкладка «Без документов»
 * — то есть разбор инцидента, а не нормальная работа.
 *
 * Что здесь проверяется и не проверяется больше нигде:
 *   * файл активного поколения БЕЗ документа приходит в pendingFiles;
 *   * файл, по которому документ появился, оттуда исчезает — иначе одна и та же
 *     поставка показывалась бы дважды;
 *   * недозагруженный файл (нет ключа S3) помечен отдельно: ссылки на него нет
 *     и быть не может;
 *   * строки прошлых поколений и закрытые вручную не показываются;
 *   * portalGroupId связывает документы и файлы одной машины ДО публикации —
 *     планшетный groupId в этот момент ещё пуст.
 *
 * Запуск — как у остальных int-наборов; без TEST_DATABASE_URL пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../../src/plugins/auth.js';

const mocks = vi.hoisted(() => ({
  putObject: vi.fn(),
  presign: vi.fn(),
  queueAdd: vi.fn(),
  s3CleanupAdd: vi.fn(),
}));

vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  putObject: mocks.putObject,
  presign: mocks.presign,
}));

const { sourceDocumentRoutes } = await import('../../src/routes/source-documents.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('принятые файлы в списке документов (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;

  const siteId = randomUUID();
  const userId = randomUUID();
  const manager: AuthUser = { id: userId, role: 'manager', siteId: null } as unknown as AuthUser;
  const inspector: AuthUser = {
    id: randomUUID(),
    role: 'inspector_kpp',
    siteId,
  } as unknown as AuthUser;
  let currentUser: AuthUser = manager;

  const hash = (s: string) => `${s}${randomUUID().replace(/-/g, '')}`.slice(0, 64);

  async function bundle(id: string, opts: { publicChannel?: boolean } = {}) {
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, direction, site_id, status, kind, active_upload_generation)
      VALUES (${id}, ${hash('pf')}, 'inbound', ${siteId}, 'processing', 'mixed', 0)`;
    if (opts.publicChannel !== false) {
      await sql`INSERT INTO ingest_events (bundle_id, channel, public_ticket)
                VALUES (${id}, 'public', ${randomUUID().slice(0, 20)})`;
    }
  }

  async function registryRow(
    bundleId: string,
    opts: {
      filename: string;
      s3Key?: string | null;
      order: number;
      status?: string;
      generation?: number;
      resolved?: boolean;
      sha?: string | null;
      /** Кем разобран файл: 'updAssembly' — признак сборки логических УПД. */
      parserUsed?: string | null;
      subBundleId?: string | null;
      effectiveStatus?: string | null;
      createdDocumentIds?: string[];
    },
  ) {
    await sql`INSERT INTO bundle_import_items
        (bundle_id, source_filename, input_s3_key, content_sha256, upload_generation,
         input_order, status, resolved_at, parser_used, sub_bundle_id, effective_status,
         created_document_ids)
      VALUES (${bundleId}, ${opts.filename},
              ${opts.s3Key === undefined ? `s3/${opts.filename}` : opts.s3Key},
              ${opts.sha ?? 'f'.repeat(64)},
              ${opts.generation ?? 0}, ${opts.order},
              ${opts.status ?? 'accepted'},
              ${opts.resolved ? sql`now()` : null},
              ${opts.parserUsed ?? null},
              ${opts.subBundleId ?? null},
              ${opts.effectiveStatus ?? null},
              ${JSON.stringify(opts.createdDocumentIds ?? [])}::jsonb)`;
  }

  /** Живой документ по файлу — то, что закрывает строку реестра. */
  async function documentFor(bundleId: string, s3Key: string) {
    const id = randomUUID();
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum, bundle_id)
      VALUES (${id}, 'upd', false, 'inbound', 'manual_pdf', 'parsed', ${siteId}, now(),
              'ПФ-1', now(), 100, ${bundleId})`;
    await sql`INSERT INTO source_document_attachments (source_document_id, s3_key, filename, role)
              VALUES (${id}, ${s3Key}, 'doc.pdf', 'original')`;
    return id;
  }

  async function list() {
    // Фильтр по объекту обязателен: в тестовой базе живут документы соседних
    // наборов, а список отдаёт всё подряд. Фильтр по объекту — единственный,
    // который применим и к документам, и к принятым файлам.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/source-documents?limit=50&siteIds=${siteId}`,
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      items: Array<{ id: string; portalGroupId: string | null }>;
      total: number;
      pendingFiles?: Array<{
        key: string;
        filename: string;
        state: string;
        portalGroupId: string | null;
      }>;
      pendingTotal?: number;
    };
  }

  /** Та же выдача, но с явным окном страницы. */
  async function page(limit: number, offset: number) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/source-documents?limit=${limit}&offset=${offset}&siteIds=${siteId}`,
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      items: Array<{ id: string }>;
      total: number;
      pendingFiles?: Array<{ key: string }>;
      pendingTotal?: number;
    };
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql) as never);
    app.decorate('queues', {
      updParse: { add: mocks.queueAdd },
      s3Cleanup: { add: mocks.s3CleanupAdd },
    } as never);
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

    await sql`INSERT INTO sites (id, code, name)
              VALUES (${siteId}, ${`PF${Date.now() % 10000}`}, 'Ожидающие файлы')`;
    await sql`INSERT INTO users (id, email, password_hash, role)
              VALUES (${userId}, ${`pf-${userId}@test`}, 'x', 'manager')`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM source_document_attachments WHERE source_document_id IN
                (SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM bundle_import_items WHERE bundle_id IN
                (SELECT id FROM source_bundles WHERE site_id = ${siteId})`;
    await sql`DELETE FROM ingest_events WHERE bundle_id IN
                (SELECT id FROM source_bundles WHERE site_id = ${siteId})`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    currentUser = manager;
    mocks.s3CleanupAdd.mockReset();
    await sql`DELETE FROM source_document_attachments WHERE source_document_id IN
                (SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM bundle_import_items WHERE bundle_id IN
                (SELECT id FROM source_bundles WHERE site_id = ${siteId})`;
    await sql`DELETE FROM ingest_events WHERE bundle_id IN
                (SELECT id FROM source_bundles WHERE site_id = ${siteId})`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  });

  it('десять принятых файлов видны все до единого', async () => {
    const b = randomUUID();
    await bundle(b);
    for (let i = 0; i < 10; i++) {
      await registryRow(b, { filename: `IMG_${i}.jpg`, order: i });
    }

    const body = await list();
    // Документов ещё нет — но ни один файл не потерялся.
    expect(body.items.length).toBe(0);
    expect(body.pendingFiles?.length).toBe(10);
    expect(body.pendingTotal).toBe(10);
    expect(body.pendingFiles?.every((f) => f.state === 'awaiting_processing')).toBe(true);
    // Ключ строки отделён от ключей документов: список рисует их вместе.
    expect(body.pendingFiles?.every((f) => f.key.startsWith('registry:'))).toBe(true);
  });

  it('файл с появившимся документом уходит из ожидающих', async () => {
    const b = randomUUID();
    await bundle(b);
    await registryRow(b, { filename: 'a.pdf', order: 0, s3Key: 's3/a.pdf' });
    await registryRow(b, { filename: 'b.pdf', order: 1, s3Key: 's3/b.pdf' });

    await documentFor(b, 's3/a.pdf');

    const body = await list();
    expect(body.items.length).toBe(1);
    // Иначе поставка показывалась бы дважды: строкой файла и строкой документа.
    expect(body.pendingFiles?.map((f) => f.filename)).toEqual(['b.pdf']);
  });

  it('файл, не дошедший до хранилища, помечен отдельно', async () => {
    const b = randomUUID();
    await bundle(b);
    await registryRow(b, { filename: 'lost.pdf', order: 0, s3Key: null, status: 'failed' });

    const body = await list();
    expect(body.pendingFiles?.length).toBe(1);
    // Не «ждёт разбора»: разбирать нечего, объекта в хранилище нет.
    expect(body.pendingFiles?.[0]).toMatchObject({
      filename: 'lost.pdf',
      state: 'not_stored',
    });
  });

  it('строки прошлого поколения и закрытые вручную не показываются', async () => {
    const b = randomUUID();
    await bundle(b);
    // Брошенная попытка загрузки: поколение пакета уже 0, а строка от -1.
    await registryRow(b, { filename: 'old.pdf', order: 0, generation: 1 });
    await registryRow(b, { filename: 'resolved.pdf', order: 1, resolved: true });
    await registryRow(b, { filename: 'cert.pdf', order: 2, status: 'skipped' });
    await registryRow(b, { filename: 'live.pdf', order: 3 });

    const body = await list();
    expect(body.pendingFiles?.map((f) => f.filename)).toEqual(['live.pdf']);
  });

  it('машина видна менеджеру до публикации: portalGroupId у документа и у файла один', async () => {
    const b = randomUUID();
    await bundle(b);
    await registryRow(b, { filename: 'first.pdf', order: 0, s3Key: 's3/first.pdf' });
    await registryRow(b, { filename: 'second.pdf', order: 1 });
    await documentFor(b, 's3/first.pdf');

    const body = await list();
    // Пакет не собран и не опубликован: планшетный groupId пуст, а машина на
    // портале уже видна — иначе менеджер не поймёт, что строки приехали вместе.
    expect(body.items[0]?.portalGroupId).toBe(b);
    expect(body.pendingFiles?.[0]?.portalGroupId).toBe(b);
  });

  it('у непортального пакета машины нет', async () => {
    const b = randomUUID();
    await bundle(b, { publicChannel: false });
    await registryRow(b, { filename: 'mail.pdf', order: 0, s3Key: 's3/mail.pdf' });
    await documentFor(b, 's3/mail.pdf');

    const body = await list();
    expect(body.items[0]?.portalGroupId).toBeNull();
  });

  it('инспектору ожидающие файлы не отдаются', async () => {
    const b = randomUUID();
    await bundle(b);
    await registryRow(b, { filename: 'hidden.pdf', order: 0 });

    currentUser = inspector;
    const body = await list();
    // Разбор принятых файлов — работа менеджера; инспектор видит документы.
    expect(body.pendingFiles).toBeUndefined();
  });
  /**
   * Дочерний пакет: сюда уезжает накладная или сборка логических УПД, и
   * документ рождается уже в нём.
   */
  async function subBundle(parentId: string, opts: { status?: string; kind?: string } = {}) {
    const id = randomUUID();
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, direction, site_id, status, kind, parent_bundle_id,
         active_upload_generation)
      VALUES (${id}, ${hash('sub')}, 'inbound', ${siteId}, ${opts.status ?? 'parsed'},
              ${opts.kind ?? 'waybill'}, ${parentId}, 0)`;
    return id;
  }

  const registryStateOf = (bundleId: string) =>
    sql<{ resolved_at: Date | null; reason: string | null }[]>`
      SELECT resolved_at, reason FROM bundle_import_items WHERE bundle_id = ${bundleId}`;

  const removeDoc = async (id: string) => {
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/source-documents/${id}` });
    expect(res.statusCode).toBe(200);
  };

  it('удалённый документ не возвращает файл строкой «в очереди»', async () => {
    // Инцидент с ТТН 16531: накладную развернули в ДОЧЕРНИЙ пакет, документ
    // создался там, и с родительской строкой реестра его не связывает ни
    // stub_document_id, ни created_document_ids — только общий файл.
    const b = randomUUID();
    await bundle(b);
    await registryRow(b, { filename: 'ТТН 16531.pdf', order: 0, s3Key: 's3/ttn-16531.pdf' });
    const sub = await subBundle(b);
    const docId = await documentFor(sub, 's3/ttn-16531.pdf');

    // Пока документ жив, файл ожидающим не считается.
    expect((await list()).pendingFiles ?? []).toHaveLength(0);

    await removeDoc(docId);

    const body = await list();
    expect(body.items).toHaveLength(0);
    expect(body.pendingFiles ?? []).toHaveLength(0);
    const [row] = await registryStateOf(b);
    expect(row!.resolved_at).not.toBeNull();
    expect(row!.reason).toBe('документ по файлу удалён');
  });

  it('строка закрывается только когда по файлу не осталось ни одного документа', async () => {
    // Один PDF даёт несколько документов (пачка накладных, страницы одной УПД),
    // и S3-объект у них общий. Удаление первого не должно закрывать строку:
    // файл по-прежнему представлен документом.
    const b = randomUUID();
    await bundle(b);
    await registryRow(b, { filename: 'batch.pdf', order: 0, s3Key: 's3/batch.pdf' });
    const first = await documentFor(b, 's3/batch.pdf');
    const second = await documentFor(b, 's3/batch.pdf');

    await removeDoc(first);
    expect((await registryStateOf(b))[0]!.resolved_at).toBeNull();
    expect((await list()).pendingFiles ?? []).toHaveLength(0);

    await removeDoc(second);
    expect((await registryStateOf(b))[0]!.resolved_at).not.toBeNull();
    // И файл всё равно не всплыл: закрытая строка ожидающей не считается.
    expect((await list()).pendingFiles ?? []).toHaveLength(0);
  });

  it('файлы и документы делят одно окно страницы — ничего не теряется и не двоится', async () => {
    // Раньше файлы приходили СВЕРХ лимита: на странице оказывалось больше строк,
    // чем помещается, и таблица срезала ровно столько документов, сколько
    // пришло файлов, — увидеть их было негде.
    const b = randomUUID();
    await bundle(b);
    for (let i = 0; i < 3; i++) {
      await registryRow(b, { filename: `WND_${i}.jpg`, order: i });
    }
    const docIds = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const docBundle = randomUUID();
      await bundle(docBundle);
      docIds.add(await documentFor(docBundle, `s3/wnd-${i}.pdf`));
    }

    // Страница на 2 строки: файлы занимают первые полторы страницы, дальше
    // начинаются документы.
    const p1 = await page(2, 0);
    const p2 = await page(2, 2);
    const p3 = await page(2, 4);
    const p4 = await page(2, 6);

    // На каждой странице ровно столько строк, сколько просили.
    expect((p1.pendingFiles?.length ?? 0) + p1.items.length).toBe(2);
    expect((p2.pendingFiles?.length ?? 0) + p2.items.length).toBe(2);
    expect((p3.pendingFiles?.length ?? 0) + p3.items.length).toBe(2);

    // Файлы кончились на второй странице, документы продолжились с той же.
    expect(p1.pendingFiles?.length).toBe(2);
    expect(p2.pendingFiles?.length).toBe(1);
    expect(p3.pendingFiles?.length ?? 0).toBe(0);

    // Счётчики описывают весь список, а не текущую страницу.
    expect(p1.pendingTotal).toBe(3);
    expect(p1.total).toBe(4);

    // Ни один файл и ни один документ не пропал и не показан дважды.
    const files = [p1, p2, p3, p4].flatMap((p) => p.pendingFiles?.map((f) => f.key) ?? []);
    const docs = [p1, p2, p3, p4].flatMap((p) => p.items.map((i) => i.id));
    expect(new Set(files).size).toBe(3);
    expect(new Set(docs).size).toBe(4);
    expect(docs.filter((id) => docIds.has(id)).length).toBe(4);
  });

  it('соседние файлы того же пакета остаются ожидающими', async () => {
    // Проверка на то, что закрытие идёт по файлу, а не по пакету: иначе один
    // удалённый документ погасил бы весь реестр загрузки.
    const b = randomUUID();
    await bundle(b);
    await registryRow(b, { filename: 'first.pdf', order: 0, s3Key: 's3/first.pdf' });
    await registryRow(b, { filename: 'second.pdf', order: 1, s3Key: 's3/second.pdf' });
    const docId = await documentFor(b, 's3/first.pdf');

    await removeDoc(docId);

    const body = await list();
    expect(body.pendingFiles?.map((f) => f.filename)).toEqual(['second.pdf']);
    const rows = await sql<{ source_filename: string; resolved_at: Date | null }[]>`
      SELECT source_filename, resolved_at FROM bundle_import_items
       WHERE bundle_id = ${b} ORDER BY source_filename`;
    expect(rows.map((r) => [r.source_filename, r.resolved_at === null])).toEqual([
      ['first.pdf', false],
      ['second.pdf', true],
    ]);
  });

  // ─── Комплект, собранный в один логический УПД ────────────────────────────
  //
  // Сборка склеивает НЕСКОЛЬКО входных файлов в ОДИН документ, а вложение
  // остаётся только у одного из них. Сопоставление строки реестра с документом
  // по ключу S3 для остальных файлов не срабатывает, и они висели «в очереди»
  // вечно, хотя работа по ним закончена. Здесь закреплено, где проходит
  // граница: закончилась сборка или ещё идёт.

  it('комплект сборки уходит из ожидающих целиком, а не только первый файл', async () => {
    const b = randomUUID();
    await bundle(b);
    const sub = await subBundle(b, { status: 'parsed', kind: 'upd' });
    // Документ сборки несёт вложение ТОЛЬКО первого файла комплекта.
    const docId = await documentFor(sub, 's3/page-1.jpg');
    for (const [order, filename] of ['page-1.jpg', 'page-2.jpg'].entries()) {
      await registryRow(b, {
        filename,
        order,
        s3Key: `s3/${filename}`,
        status: 'created',
        parserUsed: 'updAssembly',
        subBundleId: sub,
        effectiveStatus: 'created',
        createdDocumentIds: [docId],
      });
    }

    const body = await list();
    expect(body.items.length).toBe(1);
    // Второй файл комплекта не должен изображать «в очереди»: он разобран.
    expect(body.pendingFiles ?? []).toHaveLength(0);
    expect(body.pendingTotal).toBe(0);
  });

  it('пока сборка идёт, файлы комплекта остаются ожидающими', async () => {
    const b = randomUUID();
    await bundle(b);
    const sub = await subBundle(b, { status: 'processing', kind: 'upd' });
    for (const [order, filename] of ['page-1.jpg', 'page-2.jpg'].entries()) {
      await registryRow(b, {
        filename,
        order,
        s3Key: `s3/${filename}`,
        status: 'created',
        parserUsed: 'updAssembly',
        subBundleId: sub,
        // Работа не закончена: исход строки ещё не проставлен, документа нет.
        effectiveStatus: null,
        createdDocumentIds: [],
      });
    }

    const body = await list();
    // Иначе менеджер не увидит ни файла, ни документа — файл пропадёт из виду.
    expect(body.pendingFiles?.map((f) => f.filename)).toEqual(['page-2.jpg', 'page-1.jpg']);
  });

  it('документ сборки удалён — файл снова виден', async () => {
    const b = randomUUID();
    await bundle(b);
    const sub = await subBundle(b, { status: 'parsed', kind: 'upd' });
    await registryRow(b, {
      filename: 'page-1.jpg',
      order: 0,
      s3Key: 's3/page-1.jpg',
      status: 'created',
      parserUsed: 'updAssembly',
      subBundleId: sub,
      effectiveStatus: 'created',
      // Идентификатор остался в массиве, а документа уже нет.
      createdDocumentIds: [randomUUID()],
    });

    const body = await list();
    expect(body.pendingFiles?.map((f) => f.filename)).toEqual(['page-1.jpg']);
  });

  it('мусор в created_document_ids не роняет список документов', async () => {
    // Приведение к uuid стоит в выборке списка и в предикате мобильной
    // видимости: одно нечисловое значение, попавшее в массив мимо router,
    // уронило бы не строку, а весь список и синхронизацию целиком.
    const b = randomUUID();
    await bundle(b);
    const sub = await subBundle(b, { status: 'parsed', kind: 'upd' });
    await sql`INSERT INTO bundle_import_items
        (bundle_id, source_filename, input_s3_key, content_sha256, upload_generation,
         input_order, status, parser_used, sub_bundle_id, effective_status,
         created_document_ids)
      VALUES (${b}, 'broken.jpg', ${'s3/broken.jpg'}, ${'f'.repeat(64)}, 0, 0, 'created',
              'updAssembly', ${sub}, 'created', ${'["не-uuid", "1"]'}::jsonb)`;

    const body = await list();
    // Запрос отработал, а сам файл остался видимым: доказательства обслуженности нет.
    expect(body.pendingFiles?.map((f) => f.filename)).toEqual(['broken.jpg']);
  });

  it('накладная с дочерним пакетом обслуженной сборкой не считается', async () => {
    // sub_bundle_id заполняется и у накладных — одного его мало, иначе
    // потерянная накладная тихо исчезнет из списка.
    const b = randomUUID();
    await bundle(b);
    const sub = await subBundle(b, { status: 'parsed', kind: 'upd' });
    const otherDoc = await documentFor(sub, 's3/other-key.pdf');
    await registryRow(b, {
      filename: 'waybill.pdf',
      order: 0,
      s3Key: 's3/waybill.pdf',
      status: 'created',
      parserUsed: 'parseWaybillBatch',
      subBundleId: sub,
      effectiveStatus: 'created',
      createdDocumentIds: [otherDoc],
    });

    const body = await list();
    expect(body.pendingFiles?.map((f) => f.filename)).toEqual(['waybill.pdf']);
  });
});
