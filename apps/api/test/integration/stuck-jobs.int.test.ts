/**
 * Подбор записей, застрявших в `queued` без задания.
 *
 * Outbox закрывает разрыв «БД записала — Redis не принял», но не случай, когда
 * задание доставлено и потеряно вместе с воркером. Такая запись висит вечно:
 * повторная загрузка того же комплекта вернёт «уже загружено» и нового задания
 * не поставит.
 *
 * Главное, что здесь проверяется, — repair не создаёт двойного распознавания:
 * ключ задания совпадает с исходным, а пакет с уже разобранными документами не
 * берётся вовсе.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { createHash, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { dispatchKeyOf, bundleDispatchKeyOf } from '../../src/domain/jobs/job-outbox.js';
import { repairStuckJobs, STUCK_AFTER_MINUTES } from '../../src/domain/jobs/stuck-jobs.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const QUEUE = 'upd-parse';

suite('подбор зависших заданий (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  const siteId = randomUUID();
  /** Ключи, созданные этим набором: таблица outbox общая для параллельных наборов. */
  const ours: string[] = [];

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql) as unknown as Db;
    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`STK${Date.now() % 10000}`}, 'Зависшие')`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM job_outbox WHERE dedupe_key = ANY(${ours})`;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`DELETE FROM job_outbox WHERE dedupe_key = ANY(${ours})`;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  });

  const ageMinutes = (m: number) => `${m} minutes`;

  /** Документ в очереди с оригинальным файлом; age — сколько минут он ждёт. */
  async function queuedDocument(age: number, opts: { technical?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    ours.push(dispatchKeyOf(id));
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, queued_at, job_id)
      VALUES (${id}, 'upd', ${opts.technical ?? false}, 'inbound', 'manual_pdf', 'queued',
        ${siteId}, now() - ${ageMinutes(age)}::interval, ${dispatchKeyOf(id)})`;
    await sql`INSERT INTO source_document_attachments
        (source_document_id, s3_key, filename, mime_type, size_bytes, role)
      VALUES (${id}, ${`upload/${id}.pdf`}, 'doc.pdf', 'application/pdf', 100, 'original')`;
    return id;
  }

  /** Пакет в очереди; withTech — есть ли служебная запись, withReal — реальные документы. */
  async function queuedBundle(
    age: number,
    opts: { withTech?: boolean; withReal?: boolean; kind?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    ours.push(bundleDispatchKeyOf(id, 0));
    const hash = createHash('sha256').update(id).digest('hex');
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, kind, direction, site_id, status, updated_at)
      VALUES (${id}, ${hash}, ${opts.kind ?? 'mixed'}, 'inbound', ${siteId}, 'queued',
        now() - ${ageMinutes(age)}::interval)`;
    if (opts.withTech ?? true) {
      await sql`INSERT INTO source_documents
          (kind, is_technical, direction, origin, status, site_id, bundle_id, queued_at)
        VALUES ('transport_waybill', true, 'inbound', 'manual_pdf', 'queued', ${siteId},
          ${id}, now() - ${ageMinutes(age)}::interval)`;
    }
    if (opts.withReal) {
      // Разобранный УПД обязан иметь номер, дату и сумму (source_upd_required).
      await sql`INSERT INTO source_documents
          (kind, is_technical, direction, origin, status, site_id, bundle_id,
           doc_number, doc_date, total_sum)
        VALUES ('upd', false, 'inbound', 'manual_pdf', 'parsed', ${siteId}, ${id},
          'УТ-1', current_date, 1000)`;
    }
    return id;
  }

  const outboxFor = (key: string) =>
    sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM job_outbox WHERE dedupe_key = ${key}`;

  const repair = () => repairStuckJobs({ db, queue: QUEUE });

  it('документ, зависший без задания, ставится в очередь заново', async () => {
    const id = await queuedDocument(STUCK_AFTER_MINUTES + 10);

    const res = await repair();

    expect(res.documents).toBeGreaterThanOrEqual(1);
    const jobs = await outboxFor(dispatchKeyOf(id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ sourceDocumentId: id });
  });

  it('свежий документ не трогаем — он просто ждёт очереди', async () => {
    // При CONCURRENCY=1 ожидание в десятки минут штатно, торопиться нельзя.
    const id = await queuedDocument(5);

    await repair();

    expect(await outboxFor(dispatchKeyOf(id))).toHaveLength(0);
  });

  it('повторный прогон не плодит задания', async () => {
    const id = await queuedDocument(STUCK_AFTER_MINUTES + 10);

    await repair();
    await repair();

    // Ключ тот же, поэтому и строка outbox одна, и BullMQ второго job не создаст.
    expect(await outboxFor(dispatchKeyOf(id))).toHaveLength(1);
  });

  it('ключ совпадает с исходным — двойного распознавания не будет', async () => {
    const id = await queuedDocument(STUCK_AFTER_MINUTES + 10);

    await repair();

    const [row] = await sql<{ job_id: string }[]>`
      SELECT job_id FROM source_documents WHERE id = ${id}`;
    const [job] = await sql<{ dedupe_key: string }[]>`
      SELECT dedupe_key FROM job_outbox WHERE dedupe_key = ${dispatchKeyOf(id)}`;
    expect(job!.dedupe_key).toBe(row!.job_id);
  });

  it('пакет без начатого разбора ставится заново', async () => {
    const id = await queuedBundle(STUCK_AFTER_MINUTES + 10);

    const res = await repair();

    expect(res.bundles).toBeGreaterThanOrEqual(1);
    const jobs = await outboxFor(bundleDispatchKeyOf(id, 0));
    expect(jobs).toHaveLength(1);
    // mixed — это единый вход, ему нужен режим router.
    expect(jobs[0]!.payload).toMatchObject({ bundleId: id, mode: 'router' });
  });

  it('пакет с уже созданными документами НЕ повторяем', async () => {
    // Иначе получим вторые экземпляры разобранных документов — это хуже, чем
    // зависший пакет.
    const id = await queuedBundle(STUCK_AFTER_MINUTES + 10, { withReal: true });

    await repair();

    expect(await outboxFor(bundleDispatchKeyOf(id, 0))).toHaveLength(0);
  });

  it('пакет без служебной записи не повторяем — разбирать нечего', async () => {
    const id = await queuedBundle(STUCK_AFTER_MINUTES + 10, { withTech: false });

    await repair();

    expect(await outboxFor(bundleDispatchKeyOf(id, 0))).toHaveLength(0);
  });

  it('накладная идёт в waybill-ветку, без режима router', async () => {
    const id = await queuedBundle(STUCK_AFTER_MINUTES + 10, { kind: 'waybill' });

    await repair();

    const jobs = await outboxFor(bundleDispatchKeyOf(id, 0));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ bundleId: id });
  });

  it('служебная запись пакета отдельного задания не получает', async () => {
    // Её разбирает задание пакета; собственное задание распознавало бы
    // служебную запись как обычный документ.
    const id = await queuedDocument(STUCK_AFTER_MINUTES + 10, { technical: true });

    await repair();

    expect(await outboxFor(dispatchKeyOf(id))).toHaveLength(0);
  });

  it('документ без оригинального файла не воскрешаем', async () => {
    const id = randomUUID();
    ours.push(dispatchKeyOf(id));
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, queued_at)
      VALUES (${id}, 'upd', false, 'inbound', 'manual_pdf', 'queued', ${siteId},
        now() - ${ageMinutes(STUCK_AFTER_MINUTES + 10)}::interval)`;

    await repair();

    // Распознавать нечего — повторное задание ничего бы не изменило.
    expect(await outboxFor(dispatchKeyOf(id))).toHaveLength(0);
  });

  it('пустой прогон ничего не делает', async () => {
    const res = await repair();
    expect(res).toEqual({ documents: 0, bundles: 0 });
  });
});
