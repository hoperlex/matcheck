/**
 * Дополнительные документы поставки: приём во вторую зону, выдача файлов и
 * права на ссылку (реальный PostgreSQL).
 *
 * Проверяется весь путь, кроме самого разбора: файл принимается с режимом
 * `store_only`, разбор помечает строку `skipped` (здесь он эмулируется UPDATE —
 * поведение воркера покрыто router-provenance), а карточка документа и раздел
 * комплектов отдают файл со ссылкой.
 *
 * Запуск — как у остальных int-наборов; без TEST_DATABASE_URL пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../../src/plugins/auth.js';

const mocks = vi.hoisted(() => ({
  putObject: vi.fn(),
  presign: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  putObject: mocks.putObject,
  presign: mocks.presign,
}));
vi.mock('../../src/domain/storage/s3.path.js', () => ({
  buildS3Key: (o: { entityId: string; filename: string }) => `test/${o.entityId}/${o.filename}`,
}));

const { sourceDocumentRoutes } = await import('../../src/routes/source-documents.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const BOUNDARY = '----matcheckExtraFiles';

function multipartBody(
  fields: Record<string, string>,
  files: Array<{ field: string; filename: string; content: Buffer }>,
): { body: Buffer; headers: Record<string, string> } {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${f.field}"; ` +
          `filename="${f.filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      f.content,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return {
    body: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

const pdf = (marker: string) =>
  Buffer.from(`%PDF-1.4\n%${marker}\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n`);

suite('дополнительные документы поставки (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  const siteId = randomUUID();
  const otherSiteId = randomUUID();
  const userId = randomUUID();
  const manager: AuthUser = { id: userId, role: 'manager', siteId: null } as unknown as AuthUser;
  // Инспектор чужого объекта: файл документа он видеть не должен.
  const foreignInspector: AuthUser = {
    id: randomUUID(),
    role: 'inspector_kpp',
    siteId: otherSiteId,
  } as unknown as AuthUser;
  let currentUser: AuthUser = manager;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
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

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'EXF'}, 'Extra files')`;
    await sql`INSERT INTO sites (id, code, name) VALUES (${otherSiteId}, ${'EXO'}, 'Other')`;
    await sql`INSERT INTO users (id, email, password_hash, role)
      VALUES (${userId}, ${`exf-${userId}@test`}, 'x', 'manager')`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM source_documents WHERE site_id IN (${siteId}, ${otherSiteId})`;
    await sql`DELETE FROM source_bundles WHERE site_id IN (${siteId}, ${otherSiteId})`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql`DELETE FROM sites WHERE id IN (${siteId}, ${otherSiteId})`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    currentUser = manager;
    mocks.putObject.mockReset().mockResolvedValue(undefined);
    mocks.presign.mockReset().mockResolvedValue('https://s3.example/signed');
    mocks.queueAdd.mockReset().mockResolvedValue(undefined);
    await sql`DELETE FROM source_documents WHERE site_id IN (${siteId}, ${otherSiteId})`;
    await sql`DELETE FROM source_bundles WHERE site_id IN (${siteId}, ${otherSiteId})`;
  });

  function upload(
    files: Array<{ field: string; filename: string; content: Buffer }>,
    fields: Record<string, string> = { direction: 'inbound', siteId },
  ) {
    const { body, headers } = multipartBody(fields, files);
    return app.inject({
      method: 'POST',
      url: '/api/v1/source-documents/upload-documents',
      headers,
      payload: body,
    });
  }

  const registry = (bundleId: string) => sql<
    { id: string; source_filename: string; processing_mode: string; status: string }[]
  >`SELECT id, source_filename, processing_mode, status FROM bundle_import_items
      WHERE bundle_id = ${bundleId} ORDER BY source_filename`;

  /** Итог разбора: файлы второй зоны сохранены, документов не создано. */
  async function markAllSkipped(bundleId: string) {
    await sql`UPDATE bundle_import_items SET status = 'skipped' WHERE bundle_id = ${bundleId}`;
    await sql`UPDATE source_bundles SET status = 'parsed' WHERE id = ${bundleId}`;
    // Служебная запись после разбора удаляется — воспроизводим и это.
    await sql`DELETE FROM source_documents WHERE bundle_id = ${bundleId} AND is_technical = true`;
  }

  it('приём различает зоны: files → auto, extraFiles → store_only', async () => {
    const res = await upload([
      { field: 'files', filename: 'upd.pdf', content: pdf('1') },
      { field: 'extraFiles', filename: 'cert.pdf', content: pdf('2') },
    ]);
    expect(res.statusCode).toBe(201);
    const { bundleId } = res.json() as { bundleId: string };

    expect((await registry(bundleId)).map((r) => [r.source_filename, r.processing_mode, r.status]))
      .toEqual([
        ['cert.pdf', 'store_only', 'accepted'],
        ['upd.pdf', 'auto', 'accepted'],
      ]);
  });

  it('один и тот же файл в обеих зонах принимается один раз — как store_only', async () => {
    const same = pdf('same');
    const res = await upload([
      { field: 'files', filename: 'cert.pdf', content: same },
      { field: 'extraFiles', filename: 'cert.pdf', content: same },
    ]);
    expect(res.statusCode).toBe(201);
    const { bundleId } = res.json() as { bundleId: string };

    const rows = await registry(bundleId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.processing_mode).toBe('store_only');
  });

  it('повтор той же раскладки не заливает пачку заново', async () => {
    const first = await upload([{ field: 'extraFiles', filename: 'cert.pdf', content: pdf('c') }]);
    const { bundleId } = first.json() as { bundleId: string };
    await markAllSkipped(bundleId);

    const again = await upload([{ field: 'extraFiles', filename: 'cert.pdf', content: pdf('c') }]);
    // Документов у такой пачки нет вовсе, и без учёта строк реестра она
    // считалась бы брошенной и лилась бы заново при каждой отправке.
    expect(again.json()).toMatchObject({ bundleId, alreadyExists: true });
  });

  it('тот же файл, переложенный в зону распознавания, разбирается заново', async () => {
    const first = await upload([{ field: 'extraFiles', filename: 'upd.pdf', content: pdf('u') }]);
    const { bundleId } = first.json() as { bundleId: string };
    await markAllSkipped(bundleId);

    const again = await upload([{ field: 'files', filename: 'upd.pdf', content: pdf('u') }]);
    const second = again.json() as { bundleId: string; alreadyExists: boolean };
    // Содержимое то же, но раскладка по зонам другая — это законно другой
    // пакет, иначе исправить ошибочную зону было бы нечем.
    expect(second.alreadyExists).toBe(false);
    expect(second.bundleId).not.toBe(bundleId);
    expect((await registry(second.bundleId))[0]!.processing_mode).toBe('auto');
  });

  it('карточка документа отдаёт дополнительные файлы и ссылку на них', async () => {
    const res = await upload([
      { field: 'files', filename: 'upd.pdf', content: pdf('1') },
      { field: 'extraFiles', filename: 'cert.pdf', content: pdf('2') },
    ]);
    const { bundleId } = res.json() as { bundleId: string };
    await sql`UPDATE bundle_import_items SET status = 'skipped'
               WHERE bundle_id = ${bundleId} AND processing_mode = 'store_only'`;
    // Разбор: из первого файла вышел документ, служебной записи больше нет.
    const [doc] = await sql<{ id: string }[]>`UPDATE source_documents
               SET is_technical = false WHERE bundle_id = ${bundleId} RETURNING id`;
    const docId = doc!.id;

    const detail = await app.inject({ method: 'GET', url: `/api/v1/source-documents/${docId}` });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as { extraFiles: Array<{ id: string; filename: string }> };
    expect(body.extraFiles.map((f) => f.filename)).toEqual(['cert.pdf']);

    const link = await app.inject({
      method: 'GET',
      url: `/api/v1/source-documents/${docId}/extra/${body.extraFiles[0]!.id}/url`,
    });
    expect(link.statusCode).toBe(200);
    expect(link.json()).toMatchObject({ url: 'https://s3.example/signed', filename: 'cert.pdf' });
  });

  it('чужой файл и файл не в статусе skipped ссылки не дают', async () => {
    const res = await upload([
      { field: 'files', filename: 'upd.pdf', content: pdf('1') },
      { field: 'extraFiles', filename: 'cert.pdf', content: pdf('2') },
    ]);
    const { bundleId } = res.json() as { bundleId: string };
    const [doc] = await sql<{ id: string }[]>`UPDATE source_documents
               SET is_technical = false WHERE bundle_id = ${bundleId} RETURNING id`;
    const docId = doc!.id;
    const rows = await registry(bundleId);
    const cert = rows.find((r) => r.source_filename === 'cert.pdf')!;

    // Строка ещё в accepted: разбор не дошёл, отдавать файл рано.
    const early = await app.inject({
      method: 'GET',
      url: `/api/v1/source-documents/${docId}/extra/${cert.id}/url`,
    });
    expect(early.statusCode).toBe(404);

    // Чужой itemId — тоже 404, даже когда сам документ виден.
    await sql`UPDATE bundle_import_items SET status = 'skipped' WHERE id = ${cert.id}`;
    const alien = await app.inject({
      method: 'GET',
      url: `/api/v1/source-documents/${docId}/extra/${randomUUID()}/url`,
    });
    expect(alien.statusCode).toBe(404);

    // Инспектор чужого объекта не видит ни документ, ни его файлы.
    currentUser = foreignInspector;
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/v1/source-documents/${docId}/extra/${cert.id}/url`,
    });
    expect(foreign.statusCode).toBe(404);
  });

  /** Разобранный пакет: документ из первого файла, cert.pdf — во второй зоне. */
  async function prepareDocWithExtra(): Promise<{ docId: string; certId: string }> {
    const res = await upload([
      { field: 'files', filename: 'upd.pdf', content: pdf('1') },
      { field: 'extraFiles', filename: 'cert.pdf', content: pdf('2') },
    ]);
    const { bundleId } = res.json() as { bundleId: string };
    await sql`UPDATE bundle_import_items SET status = 'skipped'
               WHERE bundle_id = ${bundleId} AND processing_mode = 'store_only'`;
    const [doc] = await sql<{ id: string }[]>`UPDATE source_documents
               SET is_technical = false WHERE bundle_id = ${bundleId} RETURNING id`;
    const cert = (await registry(bundleId)).find((r) => r.source_filename === 'cert.pdf')!;
    return { docId: doc!.id, certId: cert.id };
  }

  const rawUrl = (docId: string, itemId: string) =>
    `/api/v1/source-documents/${docId}/extra/${itemId}/raw`;

  describe('скачивание дополнительного файла (raw)', () => {
    afterEach(() => {
      // Иначе мок утечёт в соседние наборы: fetch тут глобальный.
      vi.unstubAllGlobals();
    });

    it('отдаёт файл вложением: тело, тип и имя', async () => {
      const { docId, certId } = await prepareDocWithExtra();
      const payload = pdf('2');
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(payload, {
          status: 200,
          headers: {
            'content-length': String(payload.length),
            'content-type': 'application/pdf',
          },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const res = await app.inject({ method: 'GET', url: rawUrl(docId, certId) });

      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(payload)).toBe(true);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-length']).toBe(String(payload.length));
      expect(res.headers['content-disposition']).toBe(
        "attachment; filename*=UTF-8''cert.pdf",
      );
      expect(fetchMock).toHaveBeenCalledWith('https://s3.example/signed');
    });

    it('чужой itemId и чужой объект — 404, до S3 дело не доходит', async () => {
      const { docId, certId } = await prepareDocWithExtra();
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const alien = await app.inject({ method: 'GET', url: rawUrl(docId, randomUUID()) });
      expect(alien.statusCode).toBe(404);

      currentUser = foreignInspector;
      const foreign = await app.inject({ method: 'GET', url: rawUrl(docId, certId) });
      expect(foreign.statusCode).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('файл не в статусе skipped не отдаётся', async () => {
      const { docId, certId } = await prepareDocWithExtra();
      await sql`UPDATE bundle_import_items SET status = 'accepted' WHERE id = ${certId}`;
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const res = await app.inject({ method: 'GET', url: rawUrl(docId, certId) });
      expect(res.statusCode).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('отказ presign — 404 presign_failed, запроса в S3 нет', async () => {
      const { docId, certId } = await prepareDocWithExtra();
      mocks.presign.mockRejectedValueOnce(new Error('signer down'));
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const res = await app.inject({ method: 'GET', url: rawUrl(docId, certId) });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'presign_failed' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('S3 недоступен, ответил не-2xx или пустым телом — 502', async () => {
      const { docId, certId } = await prepareDocWithExtra();

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
      const dead = await app.inject({ method: 'GET', url: rawUrl(docId, certId) });
      expect(dead.statusCode).toBe(502);
      expect(dead.json()).toMatchObject({ error: 's3_unavailable' });

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('denied', { status: 403 })),
      );
      const denied = await app.inject({ method: 'GET', url: rawUrl(docId, certId) });
      expect(denied.statusCode).toBe(502);

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
      const empty = await app.inject({ method: 'GET', url: rawUrl(docId, certId) });
      expect(empty.statusCode).toBe(502);
    });
  });

  it('комплект без документов виден в отдельном разделе и отдаёт файлы', async () => {
    const res = await upload([{ field: 'extraFiles', filename: 'cert.pdf', content: pdf('c') }]);
    const { bundleId } = res.json() as { bundleId: string };
    await markAllSkipped(bundleId);

    const list = await app.inject({ method: 'GET', url: '/api/v1/source-bundles/extra-only' });
    expect(list.statusCode).toBe(200);
    const body = list.json() as {
      items: Array<{ bundleId: string; files: Array<{ id: string; filename: string }> }>;
    };
    const entry = body.items.find((b) => b.bundleId === bundleId);
    expect(entry?.files.map((f) => f.filename)).toEqual(['cert.pdf']);

    const link = await app.inject({
      method: 'GET',
      url: `/api/v1/source-bundles/${bundleId}/extra/${entry!.files[0]!.id}/url`,
    });
    expect(link.statusCode).toBe(200);
    expect(link.json()).toMatchObject({ filename: 'cert.pdf' });
  });

  it('журнал импорта считает сохранённые без распознавания', async () => {
    const res = await upload([
      { field: 'files', filename: 'upd.pdf', content: pdf('1') },
      { field: 'extraFiles', filename: 'cert.pdf', content: pdf('2') },
    ]);
    const { bundleId } = res.json() as { bundleId: string };
    await sql`UPDATE bundle_import_items SET status = 'skipped'
               WHERE bundle_id = ${bundleId} AND processing_mode = 'store_only'`;
    await sql`UPDATE bundle_import_items SET status = 'created'
               WHERE bundle_id = ${bundleId} AND processing_mode = 'auto'`;

    const result = await app.inject({
      method: 'GET',
      url: `/api/v1/source-documents/import-result/${bundleId}`,
    });
    expect(result.statusCode).toBe(200);
    expect((result.json() as { summary: unknown }).summary).toMatchObject({
      created: 1,
      skipped: 1,
      failed: 0,
    });
  });
});
