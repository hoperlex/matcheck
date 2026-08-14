/**
 * Characterization-тесты боевого пути `POST /source-documents/upload-documents`.
 *
 * Задача набора — ЗАФИКСИРОВАТЬ наблюдаемое поведение до того, как модель
 * пакетов переедет на `idempotency_key` и job-outbox. Тесты описывают то, как
 * код ведёт себя СЕЙЧАС, включая места, которые план признаёт дефектными
 * (идемпотентность по одному лишь `bundle_hash`, без учёта объекта). Если
 * рефакторинг меняет что-то из зафиксированного — это должно быть осознанным
 * решением, а не побочным эффектом.
 *
 * S3 и очередь замоканы: проверяется маршрут, а не инфраструктура.
 *
 * Запуск:
 *   docker run -d --name matcheck-test-pg -e POSTGRES_USER=postgres \
 *     -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=matcheck_test \
 *     -p 5444:5432 postgres:16-alpine
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test \
 *     npx tsx scripts/migrate.ts
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test \
 *     npx vitest run test/integration
 *
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

const BOUNDARY = '----matcheckCharacterization';

/** Сборка multipart-тела вручную: пакета form-data в зависимостях нет. */
function multipartBody(
  fields: Record<string, string>,
  files: Array<{ field: string; filename: string; contentType: string; content: Buffer }>,
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
          `filename="${f.filename}"\r\nContent-Type: ${f.contentType}\r\n\r\n`,
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

/** Минимальный валидный PDF-буфер: маршрут смотрит на mime и расширение. */
function pdf(marker: string): Buffer {
  return Buffer.from(`%PDF-1.4\n%${marker}\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n`);
}

suite('upload-documents — фиксация текущего поведения (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  const siteId = randomUUID();
  const userId = randomUUID();
  const manager: AuthUser = {
    id: userId,
    role: 'manager',
    siteId: null,
  } as unknown as AuthUser;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // Лимиты те же, что в server.ts: маршрут переопределяет files на уровне
    // вызова mp.files(), и это часть фиксируемого поведения.
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    app.decorate('db', drizzle(sql) as never);
    app.decorate('queues', { updParse: { add: mocks.queueAdd } } as never);
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

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'CHR'}, 'Characterization')`;
    await sql`INSERT INTO users (id, email, password_hash, role)
      VALUES (${userId}, ${`chr-${userId}@test`}, 'x', 'manager')`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    mocks.putObject.mockReset().mockResolvedValue(undefined);
    mocks.queueAdd.mockReset().mockResolvedValue(undefined);
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  });

  function upload(
    files: Array<{ field: string; filename: string; contentType: string; content: Buffer }>,
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

  const onePdf = (marker = 'a', filename = 'upd.pdf') => [
    { field: 'files', filename, contentType: 'application/pdf', content: pdf(marker) },
  ];

  it('без файлов → 400 no_files', async () => {
    const res = await upload([]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'no_files' });
  });

  it('неподдерживаемый тип отбрасывается молча → 400 no_files', async () => {
    const res = await upload([
      { field: 'files', filename: 'note.txt', contentType: 'text/plain', content: Buffer.from('x') },
    ]);
    // Не 415 и не сообщение про формат: файл просто не попадает в набор.
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'no_files' });
  });

  it('файл нулевой длины не считается файлом → 400 no_files', async () => {
    const res = await upload([
      {
        field: 'files',
        filename: 'empty.pdf',
        contentType: 'application/pdf',
        content: Buffer.alloc(0),
      },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'no_files' });
  });

  it('невалидные поля → 400 bad_request (siteId обязателен)', async () => {
    const res = await upload(onePdf(), { direction: 'inbound' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'bad_request' });
  });

  it('успешная загрузка → 201, технический документ, attachment и job router', async () => {
    const res = await upload(onePdf('ok'));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ status: 'queued', alreadyExists: false });

    const [bundle] = await sql<{ id: string; status: string; kind: string }[]>`
      SELECT id, status, kind FROM source_bundles WHERE id = ${body.bundleId}`;
    expect(bundle).toMatchObject({ status: 'queued', kind: 'mixed' });

    const [tech] = await sql<{ id: string; kind: string; origin: string; status: string }[]>`
      SELECT id, kind, origin, status FROM source_documents WHERE bundle_id = ${body.bundleId}`;
    // Технический документ пакета: именно он уезжает в /sync без фильтра —
    // дефект 5 плана.
    expect(tech).toMatchObject({
      kind: 'transport_waybill',
      origin: 'manual_pdf',
      status: 'queued',
    });

    const attachments = await sql`
      SELECT id FROM source_document_attachments WHERE source_document_id = ${tech.id}`;
    expect(attachments).toHaveLength(1);

    expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
    expect(mocks.queueAdd).toHaveBeenCalledWith('parse', {
      bundleId: body.bundleId,
      mode: 'router',
    });
  });

  it('повтор того же набора → alreadyExists, новый job НЕ ставится', async () => {
    const first = await upload(onePdf('dup'));
    expect(first.statusCode).toBe(201);
    mocks.queueAdd.mockClear();

    const second = await upload(onePdf('dup'));
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      bundleId: first.json().bundleId,
      alreadyExists: true,
    });
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it('порядок файлов не влияет на идемпотентность пакета', async () => {
    const a = { field: 'files', filename: 'a.pdf', contentType: 'application/pdf', content: pdf('a') };
    const b = { field: 'files', filename: 'b.pdf', contentType: 'application/pdf', content: pdf('b') };

    const straight = await upload([a, b]);
    expect(straight.statusCode).toBe(201);

    // Оба файла обязаны попасть в пакет: маршрут переопределяет глобальный
    // лимит `files: 1` вызовом mp.files({ limits: { files: 20 } }). Без этой
    // проверки тест про порядок прошёл бы тривиально на одном файле.
    const [techStraight] = await sql<{ id: string }[]>`
      SELECT id FROM source_documents WHERE bundle_id = ${straight.json().bundleId}`;
    const attachments = await sql`
      SELECT id FROM source_document_attachments WHERE source_document_id = ${techStraight.id}`;
    expect(attachments).toHaveLength(2);

    const reversed = await upload([b, a]);

    // Хеш пакета считается по ОТСОРТИРОВАННЫМ хешам файлов.
    expect(reversed.json()).toMatchObject({
      bundleId: straight.json().bundleId,
      alreadyExists: true,
    });
  });

  it('осиротевший пакет перезапускается на том же bundle', async () => {
    const first = await upload(onePdf('orphan'));
    const bundleId = first.json().bundleId;
    // Документы пакета удалены, сам пакет остался — состояние после ручной
    // чистки или сбоя воркера.
    await sql`DELETE FROM source_documents WHERE bundle_id = ${bundleId}`;
    mocks.queueAdd.mockClear();

    const again = await upload(onePdf('orphan'));
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ bundleId, alreadyExists: false });
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1);

    const [tech] = await sql<{ id: string }[]>`
      SELECT id FROM source_documents WHERE bundle_id = ${bundleId}`;
    expect(tech).toBeTruthy();
  });

  it('падение S3 → 503 и пакет в parse_failed с s3_unavailable', async () => {
    mocks.putObject.mockRejectedValue(new Error('S3 down'));

    const res = await upload(onePdf('s3fail'));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 's3_unavailable' });

    const [bundle] = await sql<
      { status: string; parse_error_code: string; parse_error_message: string }[]
    >`SELECT status, parse_error_code, parse_error_message
        FROM source_bundles WHERE site_id = ${siteId}`;
    // Пакет остаётся в БД — именно он потом опознаётся как «осиротевший».
    expect(bundle).toMatchObject({
      status: 'parse_failed',
      parse_error_code: 'internal_error',
      parse_error_message: 's3_unavailable',
    });
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it('после сбоя S3 та же пачка грузится заново целиком', async () => {
    // Приём атомарен: частично залитую пачку мы не сохраняем. Это и делает
    // повтор рабочим — bundleAlreadyProcessed считает пакет отработанным при
    // наличии ЛЮБОГО документа, поэтому «спасённый» одиночный файл запер бы
    // остальные навсегда: повторная загрузка вернула бы «уже загружено».
    mocks.putObject.mockRejectedValueOnce(new Error('S3 down'));
    const failed = await upload(onePdf('retry'));
    expect(failed.statusCode).toBe(503);

    mocks.putObject.mockResolvedValue(undefined);
    const again = await upload(onePdf('retry'));
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ alreadyExists: false });
    // Задание поставлено — то есть файл действительно пошёл в разбор.
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
  });
});
