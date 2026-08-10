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
  rateLimit: vi.fn(),
}));

vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  putObject: mocks.putObject,
  presign: mocks.presign,
}));
vi.mock('../../src/domain/storage/s3.path.js', () => ({
  buildS3Key: (o: { entityId: string; filename: string }) => `test/${o.entityId}/${o.filename}`,
}));

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

/**
 * Ответ @fastify/rate-limit после обычного запроса — полный набор полей ветки
 * `isAllowed: false`, включая обязательный timeWindow. ttlInSeconds библиотека
 * считает как Math.ceil(ttl / 1000), поэтому пара согласована.
 */
const RATE_LIMIT_OK = {
  isAllowed: false,
  key: 'public-upload:global',
  max: 200,
  timeWindow: 3_600_000,
  remaining: 199,
  ttl: 3_600_000,
  ttlInSeconds: 3600,
  isExceeded: false,
  isBanned: false,
} as const;

suite('публичная загрузка документов (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  const siteId = randomUUID();
  const otherSiteId = randomUUID();
  const inactiveSiteId = randomUUID();

  const FIELDS = {
    siteId,
    expectedDate: '2026-08-10',
    comment: 'две машины, вторая после обеда',
  };

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    app.decorate('db', drizzle(sql) as never);
    app.decorate('queues', { updParse: { add: mocks.queueAdd } } as never);
    // Redis здесь нет, поэтому лимитер — заглушка. Она обязана выглядеть в
    // точности как ответ @fastify/rate-limit: `isAllowed: true` у библиотеки
    // означает «ключ в allowList», а вовсе не «пропущен», и вне allowList
    // приходит `isAllowed: false` + `isExceeded`. Мок, отвечавший
    // `{ isAllowed: true }`, описывал несуществующий контракт и прикрывал
    // проверку, которая отдавала 429 на каждую отправку.
    app.decorate('createRateLimit', () => mocks.rateLimit as never);
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
    // Сброс обязателен: кейс на превышение подменяет ответ разово, и без
    // reset «перегрузка» протекла бы в следующий тест набора.
    mocks.rateLimit.mockReset().mockResolvedValue(RATE_LIMIT_OK);
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
        submission_comment: string | null;
        submitter_ip: string | null;
        submission_manifest: Array<{ filename: string; accepted: boolean }>;
      }[]
    >`SELECT channel, public_ticket, submission_comment, submitter_ip, submission_manifest
        FROM ingest_events WHERE bundle_id = ${bundle!.id}`;
    expect(ev).toMatchObject({
      channel: 'public',
      public_ticket: body.ticket,
      submission_comment: 'две машины, вторая после обеда',
    });
    // ordinal + sha256 — то, чем запись манифеста сопоставляется со строкой
    // реестра при сверке «ни один принятый файл не потерян»: по одному имени
    // это невозможно (имена повторяются, дубли между зонами схлопываются).
    expect(ev!.submission_manifest).toEqual([
      {
        ordinal: 1,
        filename: 'upd.pdf',
        accepted: true,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);

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

  it('комментарий необязателен', async () => {
    const res = await upload(onePdf('nocomment'), { siteId, expectedDate: FIELDS.expectedDate });
    expect(res.statusCode).toBe(201);

    const [ev] = await sql<{ submission_comment: string | null }[]>`
      SELECT ie.submission_comment FROM ingest_events ie
        JOIN source_bundles b ON b.id = ie.bundle_id
       WHERE b.site_id = ${siteId}`;
    expect(ev!.submission_comment).toBeNull();
  });

  it('комментарий из одних пробелов сохраняется как NULL, а не пустой строкой', async () => {
    // Иначе в карточке документа у менеджера появится пустой тег.
    const res = await upload(onePdf('blank'), { ...FIELDS, comment: '     ' });
    expect(res.statusCode).toBe(201);

    const [ev] = await sql<{ submission_comment: string | null }[]>`
      SELECT ie.submission_comment FROM ingest_events ie
        JOIN source_bundles b ON b.id = ie.bundle_id
       WHERE b.site_id = ${siteId}`;
    expect(ev!.submission_comment).toBeNull();
  });

  it('слишком длинный комментарий отклоняется', async () => {
    const res = await upload(onePdf('long'), { ...FIELDS, comment: 'я'.repeat(501) });
    expect(res.statusCode).toBe(400);
  });

  it('без даты поставки не принимаем', async () => {
    const res = await upload(onePdf('nodate'), { siteId });
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

  it('разные поставки с разными файлами — два независимых пакета', async () => {
    // Обычный случай при отправке нескольких машин за один заход: у каждой
    // поставки свой объект, своя дата и свои документы.
    const first = await upload(onePdf('load-a', 'upd-a.pdf'));
    const second = await upload(onePdf('load-b', 'upd-b.pdf'), {
      ...FIELDS,
      siteId: otherSiteId,
      expectedDate: '2026-08-11',
    });
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(second.json().ticket).not.toBe(first.json().ticket);

    const bundles = await sql<{ site_id: string }[]>`
      SELECT site_id FROM source_bundles WHERE site_id in (${siteId}, ${otherSiteId})`;
    expect(bundles).toHaveLength(2);
    expect(await ownEventCount()).toBe(2);
  });

  it('одинаковый комплект на другой объект → 201 и отдельный пакет с пометкой', async () => {
    // Раньше это был отказ 409: bundle_hash хранил чистый хеш содержимого под
    // глобальным UNIQUE, поэтому та же пачка физически не могла существовать
    // на двух объектах. На проде из-за этого нельзя было загрузить документ,
    // который сам же и удалили. Поставщик такие отказы видеть не должен.
    const first = await upload(onePdf('cross'));
    expect(first.statusCode).toBe(201);

    const res = await upload(onePdf('cross'), { ...FIELDS, siteId: otherSiteId });
    expect(res.statusCode).toBe(201);
    expect(res.json().ticket).not.toBe(first.json().ticket);

    // Два пакета: одинаковое содержимое, разная идентичность.
    const bundles = await sql<{ id: string; bundle_hash: string; content_hash: string }[]>`
      SELECT id, bundle_hash, content_hash FROM source_bundles
      WHERE site_id in (${siteId}, ${otherSiteId}) ORDER BY created_at`;
    expect(bundles).toHaveLength(2);
    expect(bundles[0]!.content_hash).toBe(bundles[1]!.content_hash);
    expect(bundles[0]!.bundle_hash).not.toBe(bundles[1]!.bundle_hash);

    // Менеджеру остаётся след: у второго события ссылка на первый пакет.
    const [event] = await sql<{ cross_scope_of: string | null }[]>`
      SELECT cross_scope_of FROM ingest_events WHERE bundle_id = ${bundles[1]!.id}`;
    expect(event!.cross_scope_of).toBe(bundles[0]!.id);
  });

  it('тот же комплект на тот же объект, но другую дату → отдельный пакет', async () => {
    // Ровно тот сценарий, что воспроизвели на проде: документ загрузили,
    // удалили, а повторная загрузка на новую дату упиралась в 409.
    const first = await upload(onePdf('same-site-other-date'));
    expect(first.statusCode).toBe(201);

    const res = await upload(onePdf('same-site-other-date'), {
      ...FIELDS,
      expectedDate: '2026-08-12',
    });
    expect(res.statusCode).toBe(201);

    const bundles = await sql<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE site_id = ${siteId}`;
    expect(bundles).toHaveLength(2);
  });

  it('единственный документ удалён → тот же комплект грузится заново', async () => {
    await upload(onePdf('reupload-after-delete'));
    const [bundle] = await sql<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE site_id = ${siteId}`;
    // Пакет остаётся, документов в нём больше нет — так выглядит удаление
    // документа менеджером.
    await sql`DELETE FROM source_documents WHERE bundle_id = ${bundle!.id}`;
    // Пакет должен выйти из orphan-grace, иначе повтор считается параллельной
    // загрузкой и честно возвращает reused.
    await sql`UPDATE source_bundles SET updated_at = now() - interval '5 minutes'
      WHERE id = ${bundle!.id}`;

    const res = await upload(onePdf('reupload-after-delete'));
    expect(res.statusCode).toBe(201);

    // Пакет переиспользован (scope тот же), документ создан заново.
    const bundles = await sql<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE site_id = ${siteId}`;
    expect(bundles).toHaveLength(1);
    const [{ count: docs }] = await sql<{ count: string }[]>`
      SELECT count(*) FROM source_documents WHERE bundle_id = ${bundle!.id}`;
    expect(Number(docs)).toBe(1);
  });

  it('пакет накладных с тем же bundle_hash не подхватывается', async () => {
    // /upload-waybill пишет bundle_hash без idempotency_key — ровно как
    // legacy-пакеты единого входа. Без сужения по kind ручная загрузка
    // переиспользовала бы чужой пакет накладных.
    await upload(onePdf('waybill-lookalike'));
    const [bundle] = await sql<{ id: string; bundle_hash: string; content_hash: string }[]>`
      SELECT id, bundle_hash, content_hash FROM source_bundles WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_documents WHERE bundle_id = ${bundle!.id}`;
    // Превращаем его в «пакет накладных без ключей» с чистым хешем содержимого.
    await sql`UPDATE source_bundles
      SET kind = 'waybill', idempotency_key = NULL, content_hash = NULL,
          bundle_hash = ${bundle!.content_hash}, updated_at = now() - interval '5 minutes'
      WHERE id = ${bundle!.id}`;

    const res = await upload(onePdf('waybill-lookalike'));
    expect(res.statusCode).toBe(201);

    // Свой пакет, а не чужой: строк стало две.
    const bundles = await sql<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE site_id = ${siteId}`;
    expect(bundles).toHaveLength(2);
  });

  it('пакет ДО перехода на identity-хеш переиспользуется, а не считается чужим', async () => {
    // Так выглядят пакеты, загруженные до этой правки: ключа нет, content_hash
    // пуст, а bundle_hash хранит ЧИСТЫЙ хеш содержимого. Найти их можно только
    // по нему — отсюда отдельная ветка поиска.
    await upload(onePdf('legacy-key'));
    const [bundle] = await sql<{ id: string; content_hash: string }[]>`
      SELECT id, content_hash FROM source_bundles WHERE site_id = ${siteId}`;
    await sql`UPDATE source_bundles
      SET idempotency_key = NULL, content_hash = NULL, bundle_hash = ${bundle!.content_hash}
      WHERE id = ${bundle!.id}`;

    const res = await upload(onePdf('legacy-key'));
    expect(res.statusCode).toBe(201);

    const rows = await sql<{ idempotency_key: string | null }[]>`
      SELECT idempotency_key FROM source_bundles WHERE site_id = ${siteId}`;
    expect(rows).toHaveLength(1);
    // Ключ дозаполняется на месте.
    expect(rows[0]!.idempotency_key).toBeTruthy();
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

  it('глобальный потолок исчерпан → 429 без единой записи и без S3', async () => {
    mocks.rateLimit.mockResolvedValueOnce({ ...RATE_LIMIT_OK, remaining: 0, isExceeded: true });

    const before = await ownEventCount();
    const res = await upload(onePdf('overload'));
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: 'too_many_requests' });

    // Заголовки описывают ГЛОБАЛЬНЫЙ потолок. Per-IP хук успевает положить свои
    // (limit 20, остаток по адресу) до обработчика, и без перезаписи ответ
    // противоречил бы сам себе: retry-after час при reset десять минут.
    expect(res.headers['retry-after']).toBe('3600');
    expect(res.headers['x-ratelimit-limit']).toBe('200');
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
    expect(res.headers['x-ratelimit-reset']).toBe('3600');

    // Отказ до единой записи: ни файла в S3, ни пакета, ни события.
    expect(mocks.putObject).not.toHaveBeenCalled();
    const bundles = await sql<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE site_id = ${siteId}`;
    expect(bundles.length).toBe(0);
    expect(await ownEventCount()).toBe(before);
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
