/**
 * Публичная загрузка документов поставщиком: POST /api/v1/public/upload-documents.
 *
 * Вход открыт всему интернету, поэтому проверяется не только счастливый путь,
 * но и то, чего наружу уходить НЕ должно, и то, что происходит при повторах,
 * гонках и мусорных файлах.
 *
 * S3 замокан, очередь — нет: публичный путь пишет задание в job_outbox в одной
 * транзакции с пакетом, и именно эту строку тест и проверяет.
 *
 * Запуск: см. заголовок upload-documents-characterization.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

// Фича по умолчанию выключена — включаем до загрузки роутов (env кэшируется).
process.env.PUBLIC_UPLOAD_ENABLED = 'true';

const { publicUploadRoutes } = await import('../../src/routes/public-upload.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const BOUNDARY = '----matcheckPublicUpload';

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

function pdf(marker: string): Buffer {
  return Buffer.from(`%PDF-1.4\n%${marker}\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n`);
}

suite('публичная загрузка документов (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  const siteId = randomUUID();
  const otherSiteId = randomUUID();
  const inactiveSiteId = randomUUID();

  const FIELDS = {
    siteId,
    expectedDate: '2026-08-10',
    submitterName: 'ООО «Ромашка»',
    submitterPhone: '+7 900 000-00-00',
  };

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    app.decorate('db', drizzle(sql) as never);
    app.decorate('queues', { updParse: { add: mocks.queueAdd } } as never);
    // Лимитеры в этом наборе не проверяются (нужен Redis) — заглушка
    // повторяет контракт createRateLimit: «разрешено».
    app.decorate('createRateLimit', () => async () => ({ isAllowed: true, key: 'test' }) as never);
    await app.register(publicUploadRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'PUB'}, 'Публичный объект')`;
    await sql`INSERT INTO sites (id, code, name) VALUES (${otherSiteId}, ${'PUB2'}, 'Другой объект')`;
    await sql`INSERT INTO sites (id, code, name, is_active)
      VALUES (${inactiveSiteId}, ${'PUB3'}, 'Закрытый объект', false)`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await cleanup();
    await sql`DELETE FROM sites WHERE id in (${siteId}, ${otherSiteId}, ${inactiveSiteId})`;
    await sql.end({ timeout: 5 });
  });

  async function cleanup() {
    await sql`DELETE FROM source_documents WHERE site_id in (${siteId}, ${otherSiteId})`;
    await sql`DELETE FROM job_outbox
      WHERE payload->>'bundleId' in (
        SELECT id::text FROM source_bundles WHERE site_id in (${siteId}, ${otherSiteId})
      )`;
    await sql`DELETE FROM source_bundles WHERE site_id in (${siteId}, ${otherSiteId})`;
  }

  /**
   * События только СВОИХ пакетов.
   *
   * Тестовые файлы делят одну базу и идут параллельно, поэтому глобальный
   * count по ingest_events считал бы и чужие вставки — тест «зелёный в
   * одиночку, красный в наборе».
   */
  async function ownEventCount(): Promise<number> {
    const [row] = await sql<{ count: string }[]>`
      SELECT count(*) FROM ingest_events ie
       WHERE ie.bundle_id in (
         SELECT id FROM source_bundles WHERE site_id in (${siteId}, ${otherSiteId})
       )`;
    return Number(row!.count);
  }

  beforeEach(async () => {
    mocks.putObject.mockReset().mockResolvedValue(undefined);
    mocks.queueAdd.mockReset().mockResolvedValue(undefined);
    await cleanup();
  });

  function upload(
    files: Array<{ field: string; filename: string; contentType: string; content: Buffer }>,
    fields: Record<string, string> = FIELDS,
  ) {
    const { body, headers } = multipartBody(fields, files);
    return app.inject({
      method: 'POST',
      url: '/api/v1/public/upload-documents',
      headers,
      payload: body,
    });
  }

  const onePdf = (marker = 'a', filename = 'upd.pdf') => [
    { field: 'files', filename, contentType: 'application/pdf', content: pdf(marker) },
  ];

  it('принимает документы: тикет наружу, bundleId — нет', async () => {
    const res = await upload(onePdf('happy'));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ filesAccepted: 1, filesRejected: [] });
    expect(typeof body.ticket).toBe('string');
    expect(body.ticket.length).toBeGreaterThan(10);
    // Внутренние идентификаторы наружу не уходят.
    expect(body.bundleId).toBeUndefined();

    const [bundle] = await sql<
      { id: string; status: string; direction: string; content_hash: string; idempotency_key: string }[]
    >`SELECT id, status, direction, content_hash, idempotency_key
        FROM source_bundles WHERE site_id = ${siteId}`;
    expect(bundle).toBeTruthy();
    // Публичная загрузка — всегда приёмка.
    expect(bundle!.direction).toBe('inbound');
    // Scoped-ключ заполняется: на нём держится идемпотентность.
    expect(bundle!.content_hash).toBeTruthy();
    expect(bundle!.idempotency_key).toBeTruthy();

    const [tech] = await sql<{ id: string; is_technical: boolean }[]>`
      SELECT id, is_technical FROM source_documents WHERE bundle_id = ${bundle!.id}`;
    expect(tech?.is_technical).toBe(true);

    const [ev] = await sql<
      {
        channel: string;
        public_ticket: string;
        submitter_name: string;
        submitter_phone: string;
        submission_manifest: Array<{ filename: string; accepted: boolean }>;
      }[]
    >`SELECT channel, public_ticket, submitter_name, submitter_phone, submission_manifest
        FROM ingest_events WHERE bundle_id = ${bundle!.id}`;
    expect(ev).toMatchObject({
      channel: 'public',
      public_ticket: body.ticket,
      submitter_name: 'ООО «Ромашка»',
      submitter_phone: '+7 900 000-00-00',
    });
    expect(ev!.submission_manifest).toEqual([{ filename: 'upd.pdf', accepted: true }]);

    // Задание пишется в outbox в одной транзакции с пакетом, а не в Redis:
    // недоступность очереди не оставит поставщика с «принято» без разбора.
    const [job] = await sql<{ dedupe_key: string; payload: Record<string, unknown> }[]>`
      SELECT dedupe_key, payload FROM job_outbox
       WHERE payload->>'bundleId' = ${bundle!.id}`;
    expect(job?.dedupe_key).toBe(`bundle~${bundle!.id}~parse~0`);
    expect(job?.payload).toMatchObject({ bundleId: bundle!.id, mode: 'router' });
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it('часть файлов отбракована — годные всё равно приняты', async () => {
    const res = await upload([
      ...onePdf('mix'),
      { field: 'files', filename: 'заметка.txt', contentType: 'text/plain', content: Buffer.from('hi') },
    ]);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.filesAccepted).toBe(1);
    expect(body.filesRejected).toEqual([{ filename: 'заметка.txt', reason: 'unsupported_type' }]);

    // В манифесте — судьба обоих файлов: поставщик увидит, что именно не взяли.
    const [ev] = await sql<{ submission_manifest: Array<{ filename: string; accepted: boolean }> }[]>`
      SELECT ie.submission_manifest FROM ingest_events ie
        JOIN source_bundles b ON b.id = ie.bundle_id
       WHERE b.site_id = ${siteId}`;
    expect(ev!.submission_manifest).toHaveLength(2);
  });

  it('все файлы отбракованы → 400, ничего не создано', async () => {
    const res = await upload([
      { field: 'files', filename: 'a.txt', contentType: 'text/plain', content: Buffer.from('x') },
    ]);
    expect(res.statusCode).toBe(400);
    const [{ count }] = await sql<{ count: string }[]>`SELECT count(*) FROM source_bundles WHERE site_id = ${siteId}`;
    expect(Number(count)).toBe(0);
  });

  it('honeypot: отвечаем как при успехе, но ничего не пишем', async () => {
    const res = await upload(onePdf('bot'), { ...FIELDS, website: 'http://spam.example' });
    expect(res.statusCode).toBe(201);
    expect(res.json().ticket).toBeTruthy();

    const [{ count }] = await sql<{ count: string }[]>`SELECT count(*) FROM source_bundles WHERE site_id = ${siteId}`;
    expect(Number(count)).toBe(0);
    expect(mocks.putObject).not.toHaveBeenCalled();
  });

  it('несуществующая календарная дата отклоняется', async () => {
    const res = await upload(onePdf('date'), { ...FIELDS, expectedDate: '2026-02-30' });
    expect(res.statusCode).toBe(400);
  });

  it('имя из пробелов не проходит', async () => {
    const res = await upload(onePdf('name'), { ...FIELDS, submitterName: '    ' });
    expect(res.statusCode).toBe(400);
  });

  it('без даты поставки не принимаем', async () => {
    const { siteId: s, submitterName, submitterPhone } = FIELDS;
    const res = await upload(onePdf('nodate'), { siteId: s, submitterName, submitterPhone });
    expect(res.statusCode).toBe(400);
  });

  it('неизвестный объект → 400, а не 500 от внешнего ключа', async () => {
    const res = await upload(onePdf('nosite'), { ...FIELDS, siteId: randomUUID() });
    expect(res.statusCode).toBe(400);
  });

  it('неактивный объект не принимается', async () => {
    const res = await upload(onePdf('inactive'), { ...FIELDS, siteId: inactiveSiteId });
    expect(res.statusCode).toBe(400);
  });

  it('повтор того же комплекта: тот же пакет, НОВОЕ событие с новым тикетом', async () => {
    const first = await upload(onePdf('repeat'));
    expect(first.statusCode).toBe(201);
    mocks.putObject.mockClear();
    const second = await upload(onePdf('repeat'));
    expect(second.statusCode).toBe(201);

    expect(second.json().ticket).not.toBe(first.json().ticket);
    const [{ count: bundles }] = await sql<{ count: string }[]>`
      SELECT count(*) FROM source_bundles WHERE site_id = ${siteId}`;
    expect(Number(bundles)).toBe(1);
    expect(await ownEventCount()).toBe(2);
    // Повторная отправка не льёт файлы в S3 второй раз.
    expect(mocks.putObject).not.toHaveBeenCalled();
  });

  it('те же файлы на другой объект → 409 и НИ ОДНОГО нового события', async () => {
    await upload(onePdf('cross'));
    const eventsBefore = await ownEventCount();

    const res = await upload(onePdf('cross'), { ...FIELDS, siteId: otherSiteId });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('cross_scope');

    // ingest_events.bundle_id NOT NULL: привязать отклонённую попытку было бы
    // можно только к ЧУЖОМУ пакету — он бы получил тег «от поставщика» и
    // чужую анкету. Поэтому событие не пишется вовсе.
    expect(await ownEventCount()).toBe(eventsBefore);
  });

  it('пакет того же scope без idempotency_key переиспользуется, а не считается чужим', async () => {
    // Так выглядят все пакеты, загруженные до перевода writers на scoped-ключ.
    await upload(onePdf('legacy-key'));
    await sql`UPDATE source_bundles SET idempotency_key = NULL WHERE site_id = ${siteId}`;

    const res = await upload(onePdf('legacy-key'));
    expect(res.statusCode).toBe(201);

    const rows = await sql<{ idempotency_key: string | null }[]>`
      SELECT idempotency_key FROM source_bundles WHERE site_id = ${siteId}`;
    expect(rows).toHaveLength(1);
    // Ключ дозаполняется на месте.
    expect(rows[0]!.idempotency_key).toBeTruthy();
  });

  it('одновременные одинаковые отправки создают ОДИН пакет', async () => {
    const [a, b] = await Promise.all([upload(onePdf('race')), upload(onePdf('race'))]);
    expect([a.statusCode, b.statusCode].every((c) => c === 201)).toBe(true);

    const [{ count: bundles }] = await sql<{ count: string }[]>`
      SELECT count(*) FROM source_bundles WHERE site_id = ${siteId}`;
    expect(Number(bundles)).toBe(1);
    // Техническая запись пакета ровно одна: проигравший гонку не должен
    // ни залить файлы повторно, ни завести вторую служебную строку.
    const [{ count: docs }] = await sql<{ count: string }[]>`
      SELECT count(*) FROM source_documents WHERE site_id = ${siteId}`;
    expect(Number(docs)).toBe(1);
  });

  it('падение S3 → 503, успевшие ключи уходят в чистку', async () => {
    mocks.putObject
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('S3 down'));

    const res = await upload([...onePdf('s3a', 'a.pdf'), ...onePdf('s3b', 'b.pdf')]);
    expect(res.statusCode).toBe(503);

    const [bundle] = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM source_bundles WHERE site_id = ${siteId}`;
    expect(bundle?.status).toBe('parse_failed');
    // Раньше успевший объект оставался в бакете навсегда: записи о нём не
    // создавалось, а удалять было некому.
    const cleanupRows = await sql<{ s3_key: string }[]>`
      SELECT s3_key FROM s3_cleanup_outbox WHERE entity_id = ${bundle!.id}`;
    expect(cleanupRows.length).toBe(1);
    await sql`DELETE FROM s3_cleanup_outbox WHERE entity_id = ${bundle!.id}`;
  });

  it('статус по тикету не раскрывает внутренности', async () => {
    const created = await upload(onePdf('status'));
    const ticket = created.json().ticket as string;

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/upload-documents/${encodeURIComponent(ticket)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ticket, status: 'processing', filesTotal: 1, filesAccepted: 1 });
    expect(body.files).toEqual([{ filename: 'upd.pdf', accepted: true, reason: null }]);
    // Ни типа документа, ни парсера, ни созданных id.
    expect(JSON.stringify(body)).not.toMatch(/detectedKind|parserUsed|createdDocumentIds|bundle/i);
  });

  it('неизвестный тикет → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/upload-documents/aaaaaaaaaaaaaaaa',
    });
    expect(res.statusCode).toBe(404);
  });

  it('внутренний пакет по своему UUID недоступен', async () => {
    await upload(onePdf('internal'));
    const [bundle] = await sql<{ id: string }[]>`SELECT id FROM source_bundles WHERE site_id = ${siteId}`;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/upload-documents/${bundle!.id.slice(0, 32)}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('справочник объектов отдаёт только id и название активных', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/sites' });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    const ours = items.find((s) => s.id === siteId);
    expect(ours).toEqual({ id: siteId, name: 'Публичный объект' });
    // Внутренний код объекта, адрес и ФОТ-идентификатор наружу не уходят.
    expect(Object.keys(ours!)).toEqual(['id', 'name']);
    expect(items.some((s) => s.id === inactiveSiteId)).toBe(false);
  });
});
