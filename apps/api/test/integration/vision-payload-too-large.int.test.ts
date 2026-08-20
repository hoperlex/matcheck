/**
 * Одиночное фото, которое не влезает в запрос к модели: что записывает воркер.
 *
 * Инцидент 20.08: снимок документа с телефона перекодировался в PNG полного
 * разрешения, тело запроса раздувалось, OpenRouter отвечал 413. Ошибка не
 * транзиентная — ни три попытки BullMQ, ни поколения watchdog'а размер не
 * уменьшают, поэтому документ обязан получить терминальный статус СРАЗУ, а не
 * висеть «в очереди» часами.
 *
 * Здесь проверяется именно граница записи: статус, код и подробности причины.
 * Сама подгонка тела покрыта юнит-набором vision-payload-fit.test.ts.
 *
 * Запуск: см. заголовок test/integration/upload-documents-characterization.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const sql = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 4 }) : null;

// Воркер при импорте поднимает BullMQ и Sentry — подменяем всё, что лезет
// наружу. База настоящая: проверяются именно записи, которые он создаёт.
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
vi.mock('../../src/db/client.js', () => ({ db: sql ? drizzle(sql) : null }));
vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  getObject: vi.fn().mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  presign: vi.fn().mockResolvedValue('https://s3.example/signed'),
}));

const parseUpdVision = vi.fn();
vi.mock('../../src/domain/edo/upd-vision.parser.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, parseUpdVision: (...args: unknown[]) => parseUpdVision(...args) };
});

const { handleJob } = await import('../../src/worker.js');
const { VisionPayloadTooLargeError, VISION_REQUEST_MAX_BYTES } = await import(
  '../../src/domain/edo/upd-vision.parser.js'
);

suite('фото не влезает в запрос к модели (реальный PostgreSQL)', () => {
  const db = sql!;
  const siteId = randomUUID();

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name)
      VALUES (${siteId}, ${`PLD${Date.now() % 10000}`}, 'Слишком большой файл')`;
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db`DELETE FROM sites WHERE id = ${siteId}`;
    await db.end({ timeout: 5 });
  });

  async function cleanup(): Promise<void> {
    await db`DELETE FROM source_document_attachments WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await db`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  }

  beforeEach(async () => {
    parseUpdVision.mockReset();
    await cleanup();
  });

  /** Фотография УПД в очереди — как её создаёт загрузка. */
  async function seedPhoto(): Promise<string> {
    const bundleId = randomUUID();
    const docId = randomUUID();
    await db`INSERT INTO source_bundles (id, site_id, direction, status, bundle_hash, doc_count)
             VALUES (${bundleId}, ${siteId}, 'inbound', 'queued', ${bundleId}, 1)`;
    await db`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, bundle_id)
             VALUES (${docId}, 'upd', 'inbound', 'queued', 'manual_pdf', ${siteId}, ${bundleId})`;
    return docId;
  }

  const job = (docId: string) =>
    ({ id: 'j1', data: { sourceDocumentId: docId, s3Key: `test/${docId}/source.jpg` } }) as never;

  it('размер тела: документ падает сразу и с понятной причиной', async () => {
    const docId = await seedPhoto();
    parseUpdVision.mockRejectedValue(
      new VisionPayloadTooLargeError(21_000_000, VISION_REQUEST_MAX_BYTES),
    );

    // Ошибка не выходит наружу: пробрось её handleJob — BullMQ увёл бы задание
    // на три попытки с backoff'ом, а результат был бы тот же.
    await expect(handleJob(job(docId))).resolves.toBeUndefined();

    const [row] = await db<
      {
        status: string;
        parse_error_code: string | null;
        parse_error_details: {
          reason?: string;
          actualBytes?: number;
          limitBytes?: number;
          message?: string;
        } | null;
        processed_at: Date | null;
      }[]
    >`SELECT status, parse_error_code, parse_error_details, processed_at
        FROM source_documents WHERE id = ${docId}`;

    expect(row!.status).toBe('parse_failed');
    // Код из контрактного enum — его не расширяли; конкретика в details.
    expect(row!.parse_error_code).toBe('pdf_no_text');
    expect(row!.parse_error_details).toMatchObject({
      reason: 'vision_payload_too_large',
      actualBytes: 21_000_000,
      limitBytes: VISION_REQUEST_MAX_BYTES,
    });
    // Причина обязана быть человекочитаемой: её видит менеджер в карточке.
    expect(row!.parse_error_details!.message).toContain('слишком большой');
    expect(row!.processed_at).not.toBeNull();
  });

  it('соседняя ветка не перехватывает: у таймаута своя причина', async () => {
    // Регресс-страховка на случай, если ошибку размера когда-нибудь добавят
    // в ветку таймаута через `||`: reason разъедется с фактической причиной.
    const { VisionTimeoutError } = await import('../../src/domain/edo/upd-vision.parser.js');
    const docId = await seedPhoto();
    parseUpdVision.mockRejectedValue(new VisionTimeoutError(180_000));

    await handleJob(job(docId));

    const [row] = await db<
      { status: string; parse_error_details: { reason?: string; elapsedMs?: number } | null }[]
    >`SELECT status, parse_error_details FROM source_documents WHERE id = ${docId}`;
    expect(row!.status).toBe('parse_failed');
    expect(row!.parse_error_details).toMatchObject({ reason: 'vision_timeout', elapsedMs: 180_000 });
  });
});
