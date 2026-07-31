/**
 * Происхождение и связь документов, созданных единым входом «Загрузить документы».
 *
 * До этого набора router создавал документы без bundleId и с жёстким
 * origin='manual_pdf': от документа нельзя было дойти до загрузки, пакет
 * выглядел осиротевшим (в проде — 159 пакетов из 159), а письмо после разбора
 * переставало быть почтовым.
 *
 * Здесь проверяется главное следствие правки: связь появилась, но повтор
 * задания по-прежнему НЕ удваивает пачку — служебная запись ищется по флагу,
 * а не как «любой документ пакета».
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { createHash, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const sql = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 4 }) : null;

// Воркер при импорте поднимает BullMQ и Sentry — подменяем всё, что лезет
// наружу. База настоящая: проверяются именно записи, которые он создаёт.
vi.mock('../../src/instrument.js', () => ({}));
// close объявлен обычным методом, а не vi.fn(): обработчик SIGTERM зовёт на
// результате .catch(), а к этому моменту vitest уже сбросил мок-функции — и
// close вернул бы undefined.
vi.mock('bullmq', () => ({
  Queue: class {
    async add() {
      return { id: 'job-1' };
    }
    async close() {}
  },
  Worker: class {
    on() {}
    async close() {}
  },
}));
vi.mock('../../src/db/client.js', () => ({ db: drizzle(sql!) }));
vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  getObject: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4\n%%EOF\n')),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  presign: vi.fn().mockResolvedValue('https://s3.example/signed'),
}));

const classifyFile = vi.fn();
vi.mock('../../src/domain/edo/document-router.js', () => ({
  classifyFile: (...args: unknown[]) => classifyFile(...args),
}));

const { handleDocumentRouterJob, recoverStaleProcessing } = await import('../../src/worker.js');

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

suite('провенанс документов из единого входа (реальный PostgreSQL)', () => {
  const siteId = randomUUID();
  const db = sql!;

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`PRV${Date.now() % 10000}`}, 'Провенанс')`;
  });

  /**
   * Убирает за собой и записи, и их задания. Ключи считаем по своим сущностям:
   * таблица job_outbox общая для параллельных наборов, чистить её целиком
   * нельзя.
   */
  async function cleanup(): Promise<void> {
    const docs = await db<{ id: string }[]>`
      SELECT id FROM source_documents WHERE site_id = ${siteId}`;
    const bundles = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE site_id = ${siteId}`;
    const keys = [
      ...docs.map((d) => `doc:${d.id}:parse:0`),
      ...bundles.map((b) => `bundle:${b.id}:parse:0`),
    ];
    if (keys.length > 0) {
      await db`DELETE FROM job_outbox WHERE dedupe_key = ANY(${keys})`;
    }
    await db`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await db`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  }

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db`DELETE FROM sites WHERE id = ${siteId}`;
    await db.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await cleanup();
    classifyFile.mockReset().mockResolvedValue({
      detectedKind: 'upd',
      confidence: 0.95,
      needsVision: false,
      parserUsed: 'parseUpdPdf',
      signals: ['test'],
    });
  });

  /** Пакет со служебной записью и одним вложением — состояние сразу после загрузки. */
  async function bundleWithFile(origin: string | null): Promise<string> {
    const hash = createHash('sha256').update(randomUUID()).digest('hex');
    const [bundle] = await db<{ id: string }[]>`
      INSERT INTO source_bundles (bundle_hash, kind, direction, site_id, status, origin)
      VALUES (${hash}, 'mixed', 'inbound', ${siteId}, 'queued', ${origin})
      RETURNING id`;
    const [tech] = await db<{ id: string }[]>`
      INSERT INTO source_documents
        (kind, is_technical, direction, origin, status, site_id, bundle_id, queued_at)
      VALUES ('transport_waybill', true, 'inbound', ${origin ?? 'manual_pdf'}, 'queued',
        ${siteId}, ${bundle!.id}, now())
      RETURNING id`;
    await db`INSERT INTO source_document_attachments
        (source_document_id, s3_key, filename, mime_type, size_bytes, role)
      VALUES (${tech!.id}, ${`upload/${bundle!.id}/doc.pdf`}, 'doc.pdf', 'application/pdf', 1000, 'original')`;
    return bundle!.id;
  }

  /** Реальные документы объекта — служебные записи в выдачу не идут. */
  const realDocs = () => db<
    { id: string; origin: string; bundle_id: string | null; is_technical: boolean }[]
  >`SELECT id, origin, bundle_id, is_technical FROM source_documents
      WHERE site_id = ${siteId} AND is_technical = false ORDER BY created_at`;

  it('документ из письма остаётся почтовым и знает свой пакет', async () => {
    const bundleId = await bundleWithFile('mail');

    await handleDocumentRouterJob(bundleId, log);

    const docs = await realDocs();
    expect(docs).toHaveLength(1);
    // Раньше здесь было жёсткое manual_pdf — почтовый документ выглядел
    // загруженным вручную.
    expect(docs[0]).toMatchObject({ origin: 'mail', bundle_id: bundleId });
  });

  it('загруженный кнопкой документ остаётся manual_pdf', async () => {
    // Регресс ручного пути: у старых пакетов origin не заполнен.
    const bundleId = await bundleWithFile(null);

    await handleDocumentRouterJob(bundleId, log);

    const docs = await realDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ origin: 'manual_pdf', bundle_id: bundleId });
  });

  it('повтор задания не удваивает пачку', async () => {
    // Ключевая защита: реальные документы теперь тоже несут bundleId, поэтому
    // служебная запись ищется по флагу. Иначе повтор подхватил бы уже
    // созданный документ и разобрал его вложения второй раз.
    const bundleId = await bundleWithFile('mail');
    await handleDocumentRouterJob(bundleId, log);
    expect(await realDocs()).toHaveLength(1);

    await handleDocumentRouterJob(bundleId, log);

    expect(await realDocs()).toHaveLength(1);
    const [bundle] = await db<{ status: string; parse_error_code: string | null }[]>`
      SELECT status, parse_error_code FROM source_bundles WHERE id = ${bundleId}`;
    // Служебной записи уже нет — повтор честно сообщает, что разбирать нечего,
    // вместо тихого дублирования.
    expect(bundle!.status).toBe('parse_failed');
  });

  it('задание на распознавание пишется в БД, а не напрямую в Redis', async () => {
    // Ради этого и вводился outbox: недоступность Redis в момент создания
    // документа оставляла его в queued навсегда — повторная загрузка того же
    // комплекта возвращала «уже загружено» и нового задания не ставила.
    const bundleId = await bundleWithFile('mail');

    await handleDocumentRouterJob(bundleId, log);

    const [doc] = await realDocs();
    const [job] = await db<{ dedupe_key: string; payload: { sourceDocumentId: string } }[]>`
      SELECT dedupe_key, payload FROM job_outbox WHERE dedupe_key = ${`doc:${doc!.id}:parse:0`}`;
    expect(job).toBeTruthy();
    expect(job!.payload.sourceDocumentId).toBe(doc!.id);
    // Ключ задания сохранён в самом документе — по нему repair найдёт его
    // повторно и не создаст второго распознавания.
    const [row] = await db<{ job_id: string }[]>`
      SELECT job_id FROM source_documents WHERE id = ${doc!.id}`;
    expect(row!.job_id).toBe(job!.dedupe_key);
  });

  it('документ, зависший в processing, возвращается под тем же ключом задания', async () => {
    // Иначе он получил бы задание со случайным идентификатором, и подбор
    // зависших записей добавил бы второе — документ распознался бы дважды.
    const id = randomUUID();
    await db`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, updated_at)
      VALUES (${id}, 'upd', false, 'inbound', 'manual_pdf', 'processing', ${siteId},
        now() - interval '30 minutes')`;
    await db`INSERT INTO source_document_attachments
        (source_document_id, s3_key, filename, mime_type, size_bytes, role)
      VALUES (${id}, ${`upload/${id}.pdf`}, 'doc.pdf', 'application/pdf', 100, 'original')`;

    await recoverStaleProcessing();

    const [doc] = await db<{ status: string; job_id: string }[]>`
      SELECT status, job_id FROM source_documents WHERE id = ${id}`;
    expect(doc!.status).toBe('queued');
    expect(doc!.job_id).toBe(`doc:${id}:parse:0`);
    const jobs = await db`
      SELECT id FROM job_outbox WHERE dedupe_key = ${`doc:${id}:parse:0`}`;
    expect(jobs).toHaveLength(1);
  });

  it('накладная из письма наследует происхождение через дочерний пакет', async () => {
    classifyFile.mockResolvedValue({
      detectedKind: 'transport_waybill',
      confidence: 0.9,
      needsVision: false,
      parserUsed: 'parseWaybillBatch',
      signals: ['test'],
    });
    const bundleId = await bundleWithFile('mail');

    await handleDocumentRouterJob(bundleId, log);

    // Накладная разворачивается в дочерний пакет — он тоже должен быть почтовым.
    const [sub] = await db<{ id: string; origin: string | null; parent_bundle_id: string }[]>`
      SELECT id, origin, parent_bundle_id FROM source_bundles
      WHERE site_id = ${siteId} AND id <> ${bundleId}`;
    expect(sub).toMatchObject({ origin: 'mail', parent_bundle_id: bundleId });
    // Задание дочернего пакета тоже идёт через outbox.
    const [subJob] = await db<{ payload: { bundleId: string } }[]>`
      SELECT payload FROM job_outbox WHERE dedupe_key = ${`bundle:${sub!.id}:parse:0`}`;
    expect(subJob!.payload.bundleId).toBe(sub!.id);
    const [subTech] = await db<{ origin: string; is_technical: boolean }[]>`
      SELECT origin, is_technical FROM source_documents WHERE bundle_id = ${sub!.id}`;
    expect(subTech).toMatchObject({ origin: 'mail', is_technical: true });
  });
});
