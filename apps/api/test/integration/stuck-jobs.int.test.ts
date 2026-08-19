/**
 * Health-aware recovery незавершённого распознавания.
 *
 * Outbox закрывает разрыв «БД записала — Redis не принял», watchdog дополнительно
 * сверяет BullMQ и восстанавливает потерянную/просроченную работу. Живое задание
 * не трогается, unknown не угадывается, а recovery создаёт новое поколение и
 * новый jobId.
 *
 * Главное, что здесь проверяется, — повторный watchdog не плодит задания,
 * поколения растут атомарно, а исчерпание бюджета даёт видимый терминальный
 * исход вместо вечного queued/processing.
 *
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { createHash, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client.js';

// Проверка «у каждого принятого файла есть документ» ходит в S3 за наличием
// объекта. Без мока набор зависел бы от сети и реального бакета.
const s3 = vi.hoisted(() => ({ headObject: vi.fn().mockResolvedValue(true) }));
vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  headObject: s3.headObject,
  presign: vi.fn().mockResolvedValue('https://s3.example/signed'),
  putObject: vi.fn().mockResolvedValue(undefined),
  getObject: vi.fn(),
}));
import {
  assemblyDispatchKeyOf,
  bundleDispatchKeyOf,
  dispatchKeyOf,
  segmentDispatchKeyOf,
} from '../../src/domain/jobs/job-outbox.js';
import {
  repairStuckJobs,
  STUCK_AFTER_MINUTES,
  type RecoveryMode,
} from '../../src/domain/jobs/stuck-jobs.js';

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
    ours.push(...[0, 1, 2, 3].map((generation) => dispatchKeyOf(id, generation)));
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
    ours.push(bundleDispatchKeyOf(id, 0), bundleDispatchKeyOf(id, 1));
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

  // mode: 'on' — эти тесты проверяют сам механизм восстановления. Рубильник
  // (по умолчанию 'off') проверяется отдельными тестами ниже.
  const repair = (mode: RecoveryMode = 'on') =>
    repairStuckJobs({
      db,
      queue: QUEUE,
      queueClient: { getJob: async () => null },
      mode,
    });

  it('документ, зависший без задания, ставится в очередь заново', async () => {
    const id = await queuedDocument(STUCK_AFTER_MINUTES + 10);

    const res = await repair();

    expect(res.documents).toBeGreaterThanOrEqual(1);
    const jobs = await outboxFor(dispatchKeyOf(id, 1));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ sourceDocumentId: id });
  });

  it("mode='off' не трогает ничего — рубильник выключен по умолчанию", async () => {
    // Выкат кода и включение механизма — разные события: между ними обязан
    // пройти деплой всех воркеров, иначе старый воркер, не знающий про
    // поколения, запишет результат поверх восстановленного.
    const id = await queuedDocument(STUCK_AFTER_MINUTES + 10);

    const res = await repair('off');

    expect(res.documents).toBe(0);
    expect(res.wouldRecover).toBe(0);
    expect(await outboxFor(dispatchKeyOf(id, 1))).toHaveLength(0);
    const [doc] = await sql<{ status: string; dispatch_generation: number }[]>`
      SELECT status, dispatch_generation FROM source_documents WHERE id = ${id}`;
    expect(doc).toMatchObject({ status: 'queued', dispatch_generation: 0 });
  });

  it("mode='dry_run' считает и показывает, но не переставляет", async () => {
    const id = await queuedDocument(STUCK_AFTER_MINUTES + 10);

    const res = await repair('dry_run');

    expect(res.wouldRecover).toBeGreaterThanOrEqual(1);
    expect(res.documents).toBe(0);
    // Ни задания, ни нового поколения: список в логе — единственный результат.
    expect(await outboxFor(dispatchKeyOf(id, 1))).toHaveLength(0);
    const [doc] = await sql<{ status: string; dispatch_generation: number }[]>`
      SELECT status, dispatch_generation FROM source_documents WHERE id = ${id}`;
    expect(doc).toMatchObject({ status: 'queued', dispatch_generation: 0 });
  });

  it('зависшая М-15 восстанавливается СВОИМ путём, а не как УПД', async () => {
    // Раньше repair всегда ставил «обычное» задание по s3Key: накладная уходила
    // на УПД-промпт — другой промпт, другой результат. Режим прошлого разбора
    // теперь хранится в parse_mode, и задание строится по нему.
    const id = await queuedDocument(STUCK_AFTER_MINUTES + 10);
    await sql`UPDATE source_documents
                 SET kind = 'transport_waybill', parse_mode = 'm15_vision' WHERE id = ${id}`;

    await repair();

    const jobs = await outboxFor(dispatchKeyOf(id, 1));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ sourceDocumentId: id, docKind: 'm15' });
  });

  it('после ручного повтора задание восстанавливается ключом НОВОГО поколения', async () => {
    // Ключ поколения 0 уже отработал, и BullMQ держит завершённые задания сутки:
    // восстановление старым ключом молча не создало бы задания вовсе.
    const id = await queuedDocument(STUCK_AFTER_MINUTES + 10);
    await sql`UPDATE source_documents SET dispatch_generation = 2 WHERE id = ${id}`;
    ours.push(dispatchKeyOf(id, 2));

    await repair();

    expect(await outboxFor(dispatchKeyOf(id))).toHaveLength(0);
    const jobs = await outboxFor(dispatchKeyOf(id, 3));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ sourceDocumentId: id, docGeneration: 3 });
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
    expect(await outboxFor(dispatchKeyOf(id, 1))).toHaveLength(1);
  });
  it('parked outbox проходит controlled rearm новым поколением', async () => {
    const id = await queuedDocument(STUCK_AFTER_MINUTES + 10);
    const oldJobId = dispatchKeyOf(id, 0);
    await sql`INSERT INTO job_outbox
        (queue, job_name, payload, dedupe_key, attempts, parked_at, last_error)
      VALUES (${QUEUE}, 'parse', ${JSON.stringify({ sourceDocumentId: id })}::jsonb, ${oldJobId},
        12, now(), 'redis unavailable')`;

    await repair();

    const [oldAttempt] = await sql<{ parked_at: Date; superseded_at: Date | null }[]>`
      SELECT parked_at, superseded_at FROM job_outbox WHERE dedupe_key = ${oldJobId}`;
    expect(oldAttempt!.parked_at).toBeTruthy();
    expect(oldAttempt!.superseded_at).toBeTruthy();
    expect(await outboxFor(dispatchKeyOf(id, 1))).toHaveLength(1);
  });

  it('jobId документа совпадает с ключом нового outbox-поколения', async () => {
    const id = await queuedDocument(STUCK_AFTER_MINUTES + 10);

    await repair();

    const [row] = await sql<{ job_id: string }[]>`
      SELECT job_id FROM source_documents WHERE id = ${id}`;
    const [job] = await sql<{ dedupe_key: string }[]>`
      SELECT dedupe_key FROM job_outbox WHERE dedupe_key = ${dispatchKeyOf(id, 1)}`;
    expect(job!.dedupe_key).toBe(row!.job_id);
  });

  it('пакет без начатого разбора ставится заново', async () => {
    const id = await queuedBundle(STUCK_AFTER_MINUTES + 10);

    const res = await repair();

    expect(res.bundles).toBeGreaterThanOrEqual(1);
    const jobs = await outboxFor(bundleDispatchKeyOf(id, 1));
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

    const jobs = await outboxFor(bundleDispatchKeyOf(id, 1));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ bundleId: id, bundleGeneration: 1 });
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
    expect(res).toEqual({
      terminalizedDocuments: 0,
      wouldRecover: 0,
      documents: 0,
      bundles: 0,
      segments: 0,
      finalizedItems: 0,
      stubbedFiles: 0,
      finalizedBundles: 0,
      restartedBundles: 0,
    });
  });

  it('принятый файл без документа получает заглушку', async () => {
    // Router мог не довести файл до документа (сертификат, сбой скачивания,
    // упавший дочерний пакет). Файл лежит в S3, а менеджер видит «ничего не
    // пришло» — repair это и чинит.
    const bundleId = randomUUID();
    const hash = createHash('sha256').update(bundleId).digest('hex');
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, kind, direction, site_id, status, active_upload_generation, updated_at)
      VALUES (${bundleId}, ${hash}, 'mixed', 'inbound', ${siteId}, 'parsed', 0,
              now() - ${ageMinutes(STUCK_AFTER_MINUTES + 10)}::interval)`;
    await sql`INSERT INTO bundle_import_items
        (bundle_id, source_filename, input_s3_key, mime_type, size_bytes, upload_generation,
         processing_mode, status, updated_at)
      VALUES (${bundleId}, 'cert.pdf', ${`upload/${bundleId}/cert.pdf`}, 'application/pdf', 10, 0,
              'store_only', 'skipped', now() - ${ageMinutes(STUCK_AFTER_MINUTES + 10)}::interval)`;

    const res = await repair();
    expect(res.stubbedFiles).toBe(1);

    const docs = await sql<{ status: string; parse_error_code: string; is_technical: boolean }[]>`
      SELECT status, parse_error_code, is_technical FROM source_documents
       WHERE bundle_id = ${bundleId}`;
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      status: 'archived',
      parse_error_code: 'supplementary',
      is_technical: false,
    });

    // Второй прогон не должен плодить документы на тот же файл.
    expect((await repair()).stubbedFiles).toBe(0);
    expect(await sql`SELECT id FROM source_documents WHERE bundle_id = ${bundleId}`).toHaveLength(
      1,
    );
  });

  it('файла нет в хранилище — документ не заводим', async () => {
    // Документ без файла выглядит рабочим, но не открывается: это хуже, чем
    // честная пометка «исходник недоступен».
    s3.headObject.mockResolvedValueOnce(false);
    const bundleId = randomUUID();
    const hash = createHash('sha256').update(bundleId).digest('hex');
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, kind, direction, site_id, status, active_upload_generation, updated_at)
      VALUES (${bundleId}, ${hash}, 'mixed', 'inbound', ${siteId}, 'parsed', 0,
              now() - ${ageMinutes(STUCK_AFTER_MINUTES + 10)}::interval)`;
    await sql`INSERT INTO bundle_import_items
        (bundle_id, source_filename, input_s3_key, mime_type, size_bytes, upload_generation,
         processing_mode, status, updated_at)
      VALUES (${bundleId}, 'gone.pdf', ${`upload/${bundleId}/gone.pdf`}, 'application/pdf', 10, 0,
              'store_only', 'skipped', now() - ${ageMinutes(STUCK_AFTER_MINUTES + 10)}::interval)`;

    const res = await repair();
    expect(res.stubbedFiles).toBe(0);
    expect(await sql`SELECT id FROM source_documents WHERE bundle_id = ${bundleId}`).toHaveLength(
      0,
    );
  });

  // ─── Сборка логических УПД ────────────────────────────────────────────────
  //
  // Документ сегмента до публикации технический, а общая выборка технические
  // пропускает: без отдельной ветки зависший сегмент не восстановился бы
  // никогда, и комплект остался бы неопубликованным — то есть поставка просто
  // не появилась бы ни в «Документах», ни на планшете.

  /** Пакет со сборкой: корень, дочерний исполнитель и один сегмент. */
  async function assemblyWithSegment(age: number): Promise<{
    rootId: string;
    subId: string;
    segmentId: string;
    docId: string;
  }> {
    const rootId = randomUUID();
    const subId = randomUUID();
    const docId = randomUUID();
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, kind, direction, site_id, status, updated_at)
      VALUES (${rootId}, ${createHash('sha256').update(rootId).digest('hex')}, 'mixed',
        'inbound', ${siteId}, 'processing', now() - ${ageMinutes(age)}::interval)`;
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, kind, parent_bundle_id, direction, site_id, status, updated_at)
      VALUES (${subId}, ${createHash('sha256').update(subId).digest('hex')}, 'upd', ${rootId},
        'inbound', ${siteId}, 'processing', now() - ${ageMinutes(age)}::interval)`;
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, bundle_id, queued_at)
      VALUES (${docId}, 'upd', true, 'inbound', 'manual_pdf', 'queued', ${siteId}, ${subId},
        now() - ${ageMinutes(age)}::interval)`;
    await sql`INSERT INTO source_document_attachments
        (source_document_id, s3_key, filename, mime_type, size_bytes, role)
      VALUES (${docId}, ${`upload/${docId}.pdf`}, 'segment.pdf', 'application/pdf', 100, 'original')`;
    const [seg] = await sql<{ id: string }[]>`
      INSERT INTO bundle_segments (bundle_id, generation, segment_index, source_document_id, confidence)
      VALUES (${rootId}, 0, 0, ${docId}, 'normal')
      RETURNING id`;
    ours.push(
      segmentDispatchKeyOf(seg!.id, 0),
      segmentDispatchKeyOf(seg!.id, 1),
      assemblyDispatchKeyOf(subId, 0),
      assemblyDispatchKeyOf(subId, 1),
    );
    return { rootId, subId, segmentId: seg!.id, docId };
  }

  it('зависший сегмент восстанавливается своим заданием, а не одиночным', async () => {
    const { segmentId, docId } = await assemblyWithSegment(STUCK_AFTER_MINUTES + 10);

    const res = await repair();

    expect(res.segments).toBe(1);
    const jobs = await outboxFor(segmentDispatchKeyOf(segmentId, 1));
    expect(jobs).toHaveLength(1);
    // Payload адресует манифест: одиночное задание по s3Key распознало бы одну
    // страницу вместо всего логического УПД.
    expect(jobs[0]!.payload).toEqual({
      sourceDocumentId: docId,
      segmentId,
      generation: 0,
      segmentGeneration: 1,
      docGeneration: 1,
      bundleGeneration: 0,
    });
    expect(await outboxFor(dispatchKeyOf(docId))).toHaveLength(0);
  });

  it('пакет сегмента не переставляется тем же прогоном — иначе работа гаснет', async () => {
    // Сегмент и его дочерний пакет зависают ВМЕСТЕ: сборка встала целиком.
    // Восстановив оба сразу, сторож убивал бы собственную работу — задание
    // сегмента несёт поколение пакета на момент постановки, а recovery пакета
    // тут же делает его прошлым. Воркер такое задание отвергает
    // (worker.ts, loadSegmentContext), а assembly-job нового поколения сегмент
    // не подбирает: у него уже есть source_document_id.
    const { subId, segmentId, docId } = await assemblyWithSegment(STUCK_AFTER_MINUTES + 10);

    const res = await repair();

    expect(res.segments).toBe(1);
    // Главное: поколение пакета не двинулось, и задание сегмента переживёт fencing.
    const [sub] = await sql<{ dispatch_generation: number; recovery_attempts: number }[]>`
      SELECT dispatch_generation, recovery_attempts FROM source_bundles WHERE id = ${subId}`;
    expect(sub).toMatchObject({ dispatch_generation: 0, recovery_attempts: 0 });

    const jobs = await outboxFor(segmentDispatchKeyOf(segmentId, 1));
    expect(jobs[0]!.payload).toMatchObject({
      sourceDocumentId: docId,
      bundleGeneration: sub!.dispatch_generation,
    });
    // Второго задания — на пересборку того же пакета — быть не должно.
    expect(await outboxFor(assemblyDispatchKeyOf(subId, 1))).toHaveLength(0);
  });

  it('разобравшийся сегмент освобождает свой пакет — следующий прогон его берёт', async () => {
    // Отсрочка не отменяет восстановление пакета, а откладывает: как только
    // сегмент перестал ждать, пакет снова обычный кандидат.
    const { subId, segmentId } = await assemblyWithSegment(STUCK_AFTER_MINUTES + 10);
    await repair();

    // Сегмент отработал и больше не ждёт: его документ вышел из очереди.
    // Служебная запись при этом остаётся — сборка не опубликована, и пакет
    // по-прежнему обычный кандидат на восстановление.
    await sql`UPDATE source_documents SET status = 'parse_failed'
       WHERE id = (SELECT source_document_id FROM bundle_segments WHERE id = ${segmentId})`;

    const res = await repair();

    expect(res.segments).toBe(0);
    expect(res.bundles).toBe(1);
    const [sub] = await sql<{ dispatch_generation: number }[]>`
      SELECT dispatch_generation FROM source_bundles WHERE id = ${subId}`;
    expect(sub!.dispatch_generation).toBe(1);
  });

  it('dry_run обещает ровно то, что сделает on: один сегмент, не пару', async () => {
    // Иначе список в логе показывал бы пакет, которого включённый сторож не
    // тронет, — и решение о выкате принималось бы по выдуманным данным.
    await assemblyWithSegment(STUCK_AFTER_MINUTES + 10);

    const res = await repair('dry_run');

    expect(res.wouldRecover).toBe(1);
    expect(res.segments).toBe(0);
    expect(res.bundles).toBe(0);
  });

  it('опубликованный сегмент повторно не ставится', async () => {
    const { segmentId } = await assemblyWithSegment(STUCK_AFTER_MINUTES + 10);
    await sql`UPDATE bundle_segments SET published_at = now() WHERE id = ${segmentId}`;
    await sql`UPDATE source_documents SET is_technical = false, status = 'parsed',
        doc_number = 'УТ-9', doc_date = current_date, total_sum = 100
      WHERE id = (SELECT source_document_id FROM bundle_segments WHERE id = ${segmentId})`;

    const res = await repair();

    expect(res.segments).toBe(0);
    expect(await outboxFor(segmentDispatchKeyOf(segmentId, 0))).toHaveLength(0);
  });

  it('частично видимый пакет блокирует recovery сегмента, но файл получает терминал', async () => {
    const { rootId, segmentId, docId } = await assemblyWithSegment(STUCK_AFTER_MINUTES + 10);
    await sql`INSERT INTO source_documents
        (kind, is_technical, direction, origin, status, site_id, bundle_id,
         doc_number, doc_date, total_sum)
      VALUES ('upd', false, 'inbound', 'manual_pdf', 'parsed', ${siteId}, ${rootId},
        'VISIBLE-1', current_date, 100)`;

    const res = await repair();

    expect(res.segments).toBe(0);
    expect(res.terminalizedDocuments).toBe(1);
    const [terminal] = await sql<
      {
        status: string;
        is_technical: boolean;
        bundle_id: string | null;
        dispatch_generation: number;
      }[]
    >`
      SELECT status, is_technical, bundle_id, dispatch_generation
        FROM source_documents WHERE id = ${docId}`;
    expect(terminal).toMatchObject({
      status: 'needs_resolution',
      is_technical: false,
      bundle_id: null,
      dispatch_generation: 1,
    });
    expect(await outboxFor(segmentDispatchKeyOf(segmentId, 1))).toHaveLength(0);
  });

  it('зависший дочерний пакет сборки восстанавливается своим режимом', async () => {
    const { subId } = await assemblyWithSegment(STUCK_AFTER_MINUTES + 10);
    // Сборка не дошла до манифеста: пакет ждёт своего задания.
    await sql`DELETE FROM bundle_segments WHERE bundle_id IN
        (SELECT id FROM source_bundles WHERE site_id = ${siteId})`;
    await sql`UPDATE source_bundles SET status = 'queued' WHERE id = ${subId}`;

    await repair();

    const jobs = await outboxFor(assemblyDispatchKeyOf(subId, 1));
    expect(jobs).toHaveLength(1);
    // Без mode='upd_assembly' задание ушло бы в waybill-обработчик, который не
    // нашёл бы накладных и пометил пакет parse_failed.
    expect(jobs[0]!.payload).toMatchObject({ bundleId: subId, mode: 'upd_assembly' });
  });

  describe('пакет завис в processing', () => {
    /**
     * Пакет в `processing`. Router ставит этот статус на время сборки, и раньше
     * ветка отката оставляла его навсегда: основной repair смотрит только
     * `queued`. По бою так зависли 7 пакетов — ровно все откаты сборки.
     */
    async function processingBundle(
      age: number,
      opts: { withTech?: boolean; withReal?: boolean; generation?: number } = {},
    ): Promise<string> {
      const id = randomUUID();
      ours.push(bundleDispatchKeyOf(id, (opts.generation ?? 0) + 1));
      const hash = createHash('sha256').update(id).digest('hex');
      await sql`INSERT INTO source_bundles
          (id, bundle_hash, kind, direction, site_id, status, updated_at, dispatch_generation)
        VALUES (${id}, ${hash}, 'mixed', 'inbound', ${siteId}, 'processing',
          now() - ${ageMinutes(age)}::interval, ${opts.generation ?? 0})`;
      if (opts.withTech) {
        await sql`INSERT INTO source_documents
            (kind, is_technical, direction, origin, status, site_id, bundle_id, queued_at)
          VALUES ('transport_waybill', true, 'inbound', 'manual_pdf', 'queued', ${siteId},
            ${id}, now() - ${ageMinutes(age)}::interval)`;
      }
      if (opts.withReal) {
        await sql`INSERT INTO source_documents
            (kind, is_technical, direction, origin, status, site_id, bundle_id,
             doc_number, doc_date, total_sum)
          VALUES ('upd', false, 'inbound', 'manual_pdf', 'parsed', ${siteId}, ${id},
            'УТ-7', current_date, 500)`;
      }
      return id;
    }

    const bundleStatus = async (id: string): Promise<string> => {
      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM source_bundles WHERE id = ${id}`;
      return row!.status;
    };

    it('работа кончилась, документы есть → статус досинхронизирован', async () => {
      const id = await processingBundle(STUCK_AFTER_MINUTES + 10, { withReal: true });

      const res = await repair();

      expect(res.finalizedBundles).toBe(1);
      expect(await bundleStatus(id)).toBe('parsed');
    });

    it('документов не появилось → parse_failed, а не вечное «в обработке»', async () => {
      const id = await processingBundle(STUCK_AFTER_MINUTES + 10);

      await repair();

      expect(await bundleStatus(id)).toBe('parse_failed');
    });

    it('финализация не ставит заданий — двойное распознавание невозможно', async () => {
      const id = await processingBundle(STUCK_AFTER_MINUTES + 10, { withReal: true });
      const [before] = await sql<{ n: string }[]>`SELECT count(*) AS n FROM job_outbox`;

      await repair();

      const [after] = await sql<{ n: string }[]>`SELECT count(*) AS n FROM job_outbox`;
      expect(after!.n).toBe(before!.n);
      expect(await bundleStatus(id)).toBe('parsed');
    });

    it('свежий пакет не трогаем — разбор мог ещё идти', async () => {
      const id = await processingBundle(5, { withReal: true });

      await repair();

      expect(await bundleStatus(id)).toBe('processing');
    });

    it('жива техническая запись → router не доработал, пакет переставляем', async () => {
      // Подменять статус здесь нельзя: часть файлов пачки не обработана.
      const id = await processingBundle(STUCK_AFTER_MINUTES + 10, { withTech: true });

      const res = await repair();

      expect(res.bundles).toBe(1);
      expect(await bundleStatus(id)).toBe('queued');
      // Ключ нового поколения: старое задание могло остаться в BullMQ
      // завершённым, и постановка под тем же id молча не создала бы ничего.
      const jobs = await outboxFor(bundleDispatchKeyOf(id, 1));
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.payload).toEqual({ bundleId: id, mode: 'router', bundleGeneration: 1 });
    });

    it('исчерпав recovery-бюджет, пакет получает видимый терминальный исход', async () => {
      const id = await processingBundle(STUCK_AFTER_MINUTES + 10, { withTech: true });
      await sql`UPDATE source_bundles SET recovery_attempts = 2 WHERE id = ${id}`;

      const res = await repair();

      expect(res.terminalizedDocuments).toBe(1);
      expect(await bundleStatus(id)).toBe('parse_failed');
    });
  });
});
