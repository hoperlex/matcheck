/**
 * Excel, непонятный структурному парсеру, — к модели, а не в заглушку.
 *
 * Книга в чужом шаблоне (ТТН «Стис», накладные «ЭКОДОМ») получала на входе
 * сигнал `excel:not-upd` и становилась заглушкой «не распознано», не увидев
 * модели: за неделю так потеряно 5 книг из 28. При этом vision ту же ТТН
 * читает верно — значит приговор должен выносить не структурный парсер.
 *
 * Здесь проверяются обе стороны рубильника: выключенный EXCEL_VISION_ROUTING
 * оставляет ровно прежнее поведение, включённый отдаёт книгу классификатору
 * изображения и при товарном вердикте направляет её в общий разбор.
 *
 * Запуск: см. заголовок test/integration/router-provenance.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { createHash, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const sql = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 4 }) : null;

vi.mock('../../src/instrument.js', () => ({}));
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
vi.mock('../../src/db/client.js', () => ({ db: sql ? drizzle(sql) : ({} as never) }));
vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  getObject: vi.fn().mockResolvedValue(Buffer.from('PK')),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  presign: vi.fn().mockResolvedValue('https://s3.example/signed'),
}));

// Классификатор отвечает так же, как на боевой книге «Стис»: тип не подтверждён
// регулярками, но за файл стоит спросить модель.
const classifyFile = vi.fn();
vi.mock('../../src/domain/edo/document-router.js', () => ({
  classifyFile: (...args: unknown[]) => classifyFile(...args),
}));

const classifyImageKind = vi.fn();
vi.mock('../../src/domain/edo/vision-classifier.js', () => ({
  classifyImageKind: (...args: unknown[]) => classifyImageKind(...args),
}));

const convertExcelToPdf = vi.fn();
vi.mock('../../src/domain/edo/excel-to-png.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/edo/excel-to-png.js',
  );
  return { ...actual, convertExcelToPdf: (...args: unknown[]) => convertExcelToPdf(...args) };
});

let excelRouting = false;
vi.mock('../../src/lib/env.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/lib/env.js');
  const realLoad = actual.loadEnv as () => Record<string, unknown>;
  return { ...actual, loadEnv: () => ({ ...realLoad(), EXCEL_VISION_ROUTING: excelRouting }) };
});

const { handleDocumentRouterJob } = await import('../../src/worker.js');

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

suite('router: Excel вне шаблонов УПД', () => {
  const db = sql!;
  const siteId = randomUUID();

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name)
             VALUES (${siteId}, ${`EXV${Date.now() % 10000}`}, 'Excel vision')`;
  });

  async function cleanup(): Promise<void> {
    const docs = await db<{ id: string }[]>`
      SELECT id FROM source_documents WHERE site_id = ${siteId}`;
    const bundles = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE site_id = ${siteId}`;
    const keys = [
      ...docs.map((d) => `doc~${d.id}~parse~0`),
      ...bundles.map((b) => `bundle~${b.id}~parse~0`),
    ];
    if (keys.length > 0) await db`DELETE FROM job_outbox WHERE dedupe_key = ANY(${keys})`;
    await db`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await db`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  }

  afterAll(async () => {
    await cleanup();
    await db`DELETE FROM sites WHERE id = ${siteId}`;
    await db.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await cleanup();
    excelRouting = false;
    classifyImageKind.mockReset();
    convertExcelToPdf.mockReset().mockResolvedValue(Buffer.from('%PDF'));
    classifyFile.mockReset().mockResolvedValue({
      detectedKind: 'unknown',
      confidence: 0,
      needsVision: true,
      parserUsed: 'none',
      signals: ['excel:not-upd'],
    });
  });

  /** Пакет с одной книгой — состояние сразу после загрузки. */
  async function bundleWithWorkbook(): Promise<string> {
    const hash = createHash('sha256').update(randomUUID()).digest('hex');
    const [bundle] = await db<{ id: string }[]>`
      INSERT INTO source_bundles (bundle_hash, kind, direction, site_id, status, origin)
      VALUES (${hash}, 'mixed', 'inbound', ${siteId}, 'queued', 'manual_pdf')
      RETURNING id`;
    const [tech] = await db<{ id: string }[]>`
      INSERT INTO source_documents
        (kind, is_technical, direction, origin, status, site_id, bundle_id, queued_at)
      VALUES ('transport_waybill', true, 'inbound', 'manual_pdf', 'queued',
        ${siteId}, ${bundle!.id}, now())
      RETURNING id`;
    await db`INSERT INTO source_document_attachments
        (source_document_id, s3_key, filename, mime_type, size_bytes, role)
      VALUES (${tech!.id}, ${`upload/${bundle!.id}/ttn.xlsx`},
        'Товарно-транспортная накладная (Стис) № 1200-3843.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 1000, 'original')`;
    return bundle!.id;
  }

  const realDocs = () => db<{ id: string; status: string; parse_error_code: string | null }[]>`
    SELECT id, status, parse_error_code FROM source_documents
     WHERE site_id = ${siteId} AND is_technical = false ORDER BY created_at`;

  it('флаг выключен — книга становится заглушкой, модель не зовём', async () => {
    const bundleId = await bundleWithWorkbook();

    await handleDocumentRouterJob(bundleId, log);

    expect(convertExcelToPdf).not.toHaveBeenCalled();
    expect(classifyImageKind).not.toHaveBeenCalled();
    const docs = await realDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      status: 'needs_resolution',
      parse_error_code: 'unrecognized_type',
    });
  });

  it('флаг включён и модель узнала накладную — книга идёт в разбор', async () => {
    excelRouting = true;
    classifyImageKind.mockResolvedValue({ kind: 'transport_waybill', confidence: 0.95 });
    const bundleId = await bundleWithWorkbook();

    await handleDocumentRouterJob(bundleId, log);

    // Книгу отрендерили и показали модели как PDF — иначе классификатору её не
    // передать.
    expect(convertExcelToPdf).toHaveBeenCalledTimes(1);
    expect(classifyImageKind).toHaveBeenCalledTimes(1);
    expect(classifyImageKind.mock.calls[0]?.[1]).toBe('application/pdf');

    const docs = await realDocs();
    expect(docs).toHaveLength(1);
    // Заглушкой не стала: документ поставлен в очередь на разбор. В waybill-путь
    // накладную не отправляем — Excel принимает только УПД-путь.
    expect(docs[0]?.parse_error_code).not.toBe('unrecognized_type');
    expect(docs[0]?.status).toBe('queued');
  });

  it('флаг включён, но модель не уверена — прежняя заглушка', async () => {
    excelRouting = true;
    classifyImageKind.mockResolvedValue({ kind: 'upd', confidence: 0.4 });
    const bundleId = await bundleWithWorkbook();

    await handleDocumentRouterJob(bundleId, log);

    expect(classifyImageKind).toHaveBeenCalledTimes(1);
    const docs = await realDocs();
    expect(docs[0]).toMatchObject({
      status: 'needs_resolution',
      parse_error_code: 'unrecognized_type',
    });
  });
});
