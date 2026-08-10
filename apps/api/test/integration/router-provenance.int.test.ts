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
      ...docs.map((d) => `doc~${d.id}~parse~0`),
      ...bundles.map((b) => `bundle~${b.id}~parse~0`),
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
    // Служебной записи уже нет, но строки реестра от первого прогона живы:
    // повтор видит по ним, что файл уже разобран, и закрывает пакет как
    // разобранный. Раньше эти строки сносились перед каждым прогоном, и повтор
    // объявлял пакет parse_failed, а журнал импорта оставался пустым.
    expect(bundle!.status).toBe('parsed');
    const rows = await registryRows(bundleId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('created');
  });

  it('задание на распознавание пишется в БД, а не напрямую в Redis', async () => {
    // Ради этого и вводился outbox: недоступность Redis в момент создания
    // документа оставляла его в queued навсегда — повторная загрузка того же
    // комплекта возвращала «уже загружено» и нового задания не ставила.
    const bundleId = await bundleWithFile('mail');

    await handleDocumentRouterJob(bundleId, log);

    const [doc] = await realDocs();
    const [job] = await db<{ dedupe_key: string; payload: { sourceDocumentId: string } }[]>`
      SELECT dedupe_key, payload FROM job_outbox WHERE dedupe_key = ${`doc~${doc!.id}~parse~0`}`;
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
    expect(doc!.job_id).toBe(`doc~${id}~parse~0`);
    const jobs = await db`
      SELECT id FROM job_outbox WHERE dedupe_key = ${`doc~${id}~parse~0`}`;
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
      SELECT payload FROM job_outbox WHERE dedupe_key = ${`bundle~${sub!.id}~parse~0`}`;
    expect(subJob!.payload.bundleId).toBe(sub!.id);
    const [subTech] = await db<{ origin: string; is_technical: boolean }[]>`
      SELECT origin, is_technical FROM source_documents WHERE bundle_id = ${sub!.id}`;
    expect(subTech).toMatchObject({ origin: 'mail', is_technical: true });
  });

  // ─── Реестр входных файлов ────────────────────────────────────────────────
  //
  // До реестра перечень принятых файлов жил только в attachments служебной
  // записи, а она удаляется в конце разбора — вместе с attachments по каскаду.
  // Файл, упавший при обработке, не оставлял следов: пакет помечался parsed,
  // документа не было, и перезапускать было нечего.

  /** Пакет нового формата: строки реестра есть, служебной записи нет. */
  async function bundleWithRegistry(files: string[]): Promise<string> {
    const hash = createHash('sha256').update(randomUUID()).digest('hex');
    const [bundle] = await db<{ id: string }[]>`
      INSERT INTO source_bundles
        (bundle_hash, kind, direction, site_id, status, active_upload_generation)
      VALUES (${hash}, 'mixed', 'inbound', ${siteId}, 'queued', 0)
      RETURNING id`;
    for (const name of files) {
      await db`INSERT INTO bundle_import_items
          (bundle_id, source_filename, input_s3_key, mime_type, size_bytes,
           upload_generation, status)
        VALUES (${bundle!.id}, ${name}, ${`upload/${bundle!.id}/${name}`},
          'application/pdf', 1000, 0, 'accepted')`;
    }
    return bundle!.id;
  }

  const registryRows = (bundleId: string) => db<
    {
      source_filename: string;
      status: string;
      detected_kind: string | null;
      created_document_ids: string[];
    }[]
  >`SELECT source_filename, status, detected_kind, created_document_ids
      FROM bundle_import_items
      WHERE bundle_id = ${bundleId} ORDER BY source_filename`;

  it('пакет без служебной записи разбирается по реестру', async () => {
    const bundleId = await bundleWithRegistry(['a.pdf', 'b.pdf']);

    await handleDocumentRouterJob(bundleId, log);

    expect(await realDocs()).toHaveLength(2);
    const rows = await registryRows(bundleId);
    expect(rows.map((r) => r.status)).toEqual(['created', 'created']);
    // Строки те же самые, а не вторая пара: реестр обновляется на месте.
    expect(rows).toHaveLength(2);
  });

  it('повторный прогон не разбирает уже созданные файлы заново', async () => {
    const bundleId = await bundleWithRegistry(['a.pdf', 'b.pdf']);
    await handleDocumentRouterJob(bundleId, log);
    const first = await realDocs();
    expect(first).toHaveLength(2);

    await handleDocumentRouterJob(bundleId, log);

    // Раньше повтор либо дублировал документы, либо упирался в отсутствие
    // служебной записи и отдавал parse_failed. Теперь — идемпотентный успех.
    const second = await realDocs();
    expect(second.map((d) => d.id).sort()).toEqual(first.map((d) => d.id).sort());
    expect(await registryRows(bundleId)).toHaveLength(2);
    const [bundle] = await db<{ status: string; doc_count: number }[]>`
      SELECT status, doc_count FROM source_bundles WHERE id = ${bundleId}`;
    expect(bundle).toMatchObject({ status: 'parsed', doc_count: 2 });
  });

  it('сбой классификации сохраняет файл, а не прячет его', async () => {
    const bundleId = await bundleWithRegistry(['ok.pdf', 'bad.pdf']);
    classifyFile.mockImplementation((_buf: unknown, _mime: unknown, filename: string) => {
      if (filename === 'bad.pdf') throw new Error('классификация упала');
      return {
        detectedKind: 'upd',
        confidence: 0.95,
        needsVision: false,
        parserUsed: 'parseUpdPdf',
        signals: ['test'],
      };
    });

    await handleDocumentRouterJob(bundleId, log);

    // Строка упавшего файла ПЕРЕЖИВАЕТ разбор: исключение в классификации
    // приравнено к «тип не определён», и файл получает документ «не
    // распознано» под ручной разбор. С failed он пропал бы из виду совсем.
    const rows = await registryRows(bundleId);
    expect(rows).toHaveLength(2);
    const bad = rows.find((r) => r.source_filename === 'bad.pdf');
    expect(bad?.status).toBe('created');
    expect(bad?.detected_kind).toBe('unknown');
    expect(rows.find((r) => r.source_filename === 'ok.pdf')?.status).toBe('created');
    // Два документа: распознанный УПД и заглушка под ручной разбор.
    expect(await realDocs()).toHaveLength(2);
  });

  it('неопознанный файл становится документом «не распознано», а не исчезает', async () => {
    const bundleId = await bundleWithRegistry(['mystery.pdf']);
    classifyFile.mockResolvedValue({
      detectedKind: 'unknown',
      confidence: 0,
      needsVision: false,
      parserUsed: 'none',
      signals: ['text:ambiguous'],
    });

    await handleDocumentRouterJob(bundleId, log);

    // Файл пришёл из ОБЯЗАТЕЛЬНОЙ зоны формы: раньше он уходил в УПД-flow и
    // оседал пустым черновиком, потом — прятался в дополнительные файлы и
    // пропадал из «Документов». Теперь по нему есть строка, но пустая и с
    // явным кодом: распознавать больше нечем, разбирает человек.
    const docs = await realDocs();
    expect(docs).toHaveLength(1);
    const [doc] = await db<
      { status: string; parse_error_code: string | null; kind: string }[]
    >`SELECT status, parse_error_code, kind FROM source_documents WHERE id = ${docs[0]!.id}`;
    expect(doc).toMatchObject({
      status: 'needs_resolution',
      parse_error_code: 'unrecognized_type',
      kind: 'upd',
    });

    // Файл доступен из карточки — вложение прикреплено.
    const attachments = await db<{ s3_key: string }[]>`
      SELECT s3_key FROM source_document_attachments WHERE source_document_id = ${docs[0]!.id}`;
    expect(attachments).toHaveLength(1);

    // Задание в очередь НЕ ставится: и классификатор, и vision уже отказались,
    // повторять нечего.
    const jobs = await db<{ n: string }[]>`
      SELECT count(*)::text AS n FROM job_outbox
       WHERE dedupe_key = ${`doc~${docs[0]!.id}~parse~0`}`;
    expect(jobs[0]!.n).toBe('0');

    const rows = await registryRows(bundleId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'created', detected_kind: 'unknown' });
  });

  it('пакет не объявляется разобранным, пока есть строки «в процессе»', async () => {
    const bundleId = await bundleWithRegistry(['live.pdf']);
    // Строка без ключа S3: во входы разбора она не попадает вовсе (там нужен
    // ключ), и раньше оставалась в needs_review навсегда — файл не виден ни в
    // «Документах», ни среди дополнительных, а пакет числится разобранным.
    await db`INSERT INTO bundle_import_items
        (bundle_id, source_filename, input_s3_key, mime_type, size_bytes,
         upload_generation, status)
      VALUES (${bundleId}, 'ghost.pdf', NULL, 'application/pdf', 1000, 0, 'needs_review')`;

    await handleDocumentRouterJob(bundleId, log);

    const rows = await registryRows(bundleId);
    const ghost = rows.find((r) => r.source_filename === 'ghost.pdf');
    expect(ghost?.status).toBe('failed');
    const [bundle] = await db<{ status: string }[]>`
      SELECT status FROM source_bundles WHERE id = ${bundleId}`;
    expect(bundle!.status).toBe('parsed');
  });

  it('файл зоны «Дополнительные документы» не читается из S3 и не распознаётся', async () => {
    const bundleId = await bundleWithRegistry(['cert.pdf']);
    await db`UPDATE bundle_import_items SET processing_mode = 'store_only'
              WHERE bundle_id = ${bundleId}`;
    classifyFile.mockClear();

    await handleDocumentRouterJob(bundleId, log);

    // Ни классификации, ни документа, ни дочернего задания: человек уже сказал,
    // что распознавать файл не надо. Корневое router-задание при этом,
    // разумеется, отработало — иначе строка осталась бы в accepted.
    expect(classifyFile).not.toHaveBeenCalled();
    expect(await realDocs()).toHaveLength(0);
    const jobs = await db<{ n: string }[]>`
      SELECT count(*)::text AS n FROM job_outbox
       WHERE payload->>'sourceDocumentId' IS NOT NULL`;
    expect(jobs[0]!.n).toBe('0');
    const rows = await registryRows(bundleId);
    expect(rows[0]).toMatchObject({ status: 'skipped', detected_kind: null });
  });

  it('строки прошлого поколения загрузки в разбор не идут', async () => {
    const bundleId = await bundleWithRegistry(['live.pdf']);
    // Файл брошенной попытки: поколение меньше активного.
    await db`INSERT INTO bundle_import_items
        (bundle_id, source_filename, input_s3_key, mime_type, size_bytes,
         upload_generation, status)
      VALUES (${bundleId}, 'abandoned.pdf', ${`upload/${bundleId}/abandoned.pdf`},
        'application/pdf', 1000, -1, 'accepted')`;

    await handleDocumentRouterJob(bundleId, log);

    expect(await realDocs()).toHaveLength(1);
    const rows = await registryRows(bundleId);
    expect(rows.find((r) => r.source_filename === 'abandoned.pdf')?.status).toBe('accepted');
  });
});
