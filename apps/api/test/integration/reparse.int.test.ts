/**
 * Повторное распознавание (кнопка «Распознать повторно»): что оно меняет и, что
 * важнее, чего НЕ меняет.
 *
 * Главный инвариант фичи — «повтор не ухудшает документ». Он держится на трёх
 * механизмах, и каждый проверяется здесь на живой БД, потому что все три —
 * про порядок записей и про гонки, а не про чистые функции:
 *
 *   1. fencing по поколению: задание прошлой попытки не пишет в документ,
 *      который с тех пор переразобрали;
 *   2. атомарная замена: шапка и позиции меняются одной транзакцией;
 *   3. откат: неудачный повтор возвращает документ ровно в прежний вид.
 *
 * Здесь же — выбор пути повтора (resolveReparsePlan): УПД, М-15, сегмент
 * комплекта и накладная пакетного пути должны получать РАЗНЫЕ задания.
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

// Каждый handleJob в конце публикует SSE-событие, а Redis в тестовой среде нет:
// ioredis честно отрабатывает свои ретраи (~2-3 с на вызов).
vi.setConfig({ testTimeout: 30_000 });

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
// Без TEST_DATABASE_URL набор пропускается целиком, но фабрика мока всё равно
// выполняется при импорте — поэтому пустышка вместо drizzle(null), иначе весь
// файл падает на этапе загрузки, а не скипается.
vi.mock('../../src/db/client.js', () => ({ db: sql ? drizzle(sql) : ({} as never) }));
vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  getObject: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4\n%%EOF\n')),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  presign: vi.fn().mockResolvedValue('https://s3.example/signed'),
}));

const parseUpdPdf = vi.fn();
vi.mock('../../src/domain/edo/upd-pdf.parser.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/edo/upd-pdf.parser.js',
  );
  return { ...actual, parseUpdPdf: (...args: unknown[]) => parseUpdPdf(...args) };
});
const parseUpdVision = vi.fn();
vi.mock('../../src/domain/edo/upd-vision.parser.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/edo/upd-vision.parser.js',
  );
  return { ...actual, parseUpdVision: (...args: unknown[]) => parseUpdVision(...args) };
});
const parseWaybillBatch = vi.fn();
vi.mock('../../src/domain/edo/waybill-batch.parser.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/edo/waybill-batch.parser.js',
  );
  return { ...actual, parseWaybillBatch: (...args: unknown[]) => parseWaybillBatch(...args) };
});
// Глушим только ДОСТАВКУ заданий: воркер при импорте поднимает consumer outbox
// раз в 15 с, а набор проверяет как раз содержимое outbox.
vi.mock('../../src/domain/jobs/job-outbox.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/jobs/job-outbox.js',
  );
  return { ...actual, processJobOutbox: vi.fn().mockResolvedValue({ dispatched: 0, failed: 0 }) };
});
vi.mock('../../src/domain/edo/upd-text-bundle.parser.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/edo/upd-text-bundle.parser.js',
  );
  return { ...actual, tryParseTextUpdBundle: vi.fn().mockResolvedValue(null) };
});

const { handleJob } = await import('../../src/worker.js');
const { resolveReparsePlan } = await import('../../src/domain/sourceDocuments/reparse-plan.js');
const { db: drizzleDb } = await import('../../src/db/client.js');

function parsedResult(over: {
  docNumber?: string | null;
  totalSum?: number | null;
  items?: { nameRaw: string; qty: number; unit: string; price: number; sum: number }[];
  confidence?: number;
}) {
  const items = over.items ?? [
    { nameRaw: 'Труба стальная', qty: 2, unit: 'шт', price: 100, sum: 200 },
  ];
  return {
    parsed: {
      docNumber: over.docNumber === undefined ? 'RP-100' : over.docNumber,
      docDate: '2026-07-10',
      totalSum: over.totalSum === undefined ? items.reduce((s, i) => s + i.sum, 0) : over.totalSum,
      vatSum: null,
      itemsCount: items.length,
      supplier: { inn: '7722466900', kpp: '772201001', name: 'ООО "Компенсатор"' },
      recipient: { inn: '7736255508', kpp: '773601001', name: 'ООО «СУ-10»' },
      consignee: null,
      items,
      confidence: over.confidence ?? 1,
    },
    textLength: 5000,
    llmProviderId: null,
  };
}

suite('повторное распознавание (реальный PostgreSQL)', () => {
  const db = sql!;
  const siteId = randomUUID();

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`RPS${Date.now() % 10000}`}, 'Повтор')`;
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db`DELETE FROM sites WHERE id = ${siteId}`;
    await db.end({ timeout: 5 });
  });

  async function cleanup(): Promise<void> {
    await db`DELETE FROM job_outbox WHERE payload->>'sourceDocumentId' IN (
      SELECT id::text FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM bundle_segments WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_document_items WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_document_attachments WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await db`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  }

  beforeEach(async () => {
    parseUpdPdf.mockReset();
    parseUpdVision.mockReset();
    parseWaybillBatch.mockReset();
    await cleanup();
  });

  /** Документ, уже прошедший разбор: с позициями, статусом и диагностикой. */
  async function seedParsedDoc(
    over: {
      kind?: 'upd' | 'transport_waybill' | 'os2_transfer';
      parseMode?: string | null;
      generation?: number;
      batchIndex?: number | null;
    } = {},
  ): Promise<string> {
    const bundleId = randomUUID();
    const docId = randomUUID();
    await db`INSERT INTO source_bundles (id, site_id, direction, status, bundle_hash, doc_count)
             VALUES (${bundleId}, ${siteId}, 'inbound', 'parsed', ${bundleId}, 1)`;
    await db`INSERT INTO source_documents
               (id, kind, direction, status, origin, site_id, bundle_id, doc_number, doc_date,
                total_sum, parse_mode, dispatch_generation, batch_index, validation,
                parse_error_code, processed_at)
             VALUES (${docId}, ${over.kind ?? 'upd'}, 'inbound', 'parsed', 'manual_pdf', ${siteId},
                     ${bundleId}, 'OLD-1', '2026-06-01', '200.00', ${over.parseMode ?? 'text'},
                     ${over.generation ?? 0}, ${over.batchIndex ?? null},
                     ${JSON.stringify({ hasMismatch: true, checks: [], checkedAt: '2026-06-01' })}::jsonb,
                     'validation_mismatch', now())`;
    await db`INSERT INTO source_document_attachments (source_document_id, s3_key, filename, mime_type, role)
             VALUES (${docId}, ${`test/${docId}/source.pdf`}, 'source.pdf', 'application/pdf', 'original')`;
    await db`INSERT INTO source_document_items (source_document_id, name_raw, qty, unit, line_no)
             VALUES (${docId}, 'Старая позиция', '1', 'шт', 1)`;
    return docId;
  }

  /** То, что делает маршрут /reparse: поколение +1 и снимок прежнего состояния. */
  async function requestReparse(docId: string): Promise<number> {
    const [row] = await db<
      {
        dispatch_generation: number;
        status: string;
        parse_error_code: string | null;
        validation: unknown;
        processed_at: string | null;
        second_pass: unknown;
      }[]
    >`SELECT dispatch_generation, status, parse_error_code, validation, processed_at, second_pass
        FROM source_documents WHERE id = ${docId}`;
    const generation = row!.dispatch_generation + 1;
    await db`UPDATE source_documents
                SET status = 'queued', dispatch_generation = ${generation}, queued_at = now(),
                    job_attempts = 0, second_pass = NULL,
                    reparse = ${JSON.stringify({
                      state: 'queued',
                      generation,
                      at: new Date().toISOString(),
                      by: null,
                      snapshot: {
                        status: row!.status,
                        parseErrorCode: row!.parse_error_code,
                        parseErrorDetails: null,
                        validation: row!.validation,
                        processedAt: row!.processed_at,
                        secondPass: row!.second_pass,
                      },
                    })}::jsonb
              WHERE id = ${docId}`;
    return generation;
  }

  const job = (docId: string, docGeneration?: number) =>
    ({
      id: 'j-reparse',
      data: {
        sourceDocumentId: docId,
        s3Key: `test/${docId}/source.pdf`,
        ...(docGeneration === undefined ? {} : { docGeneration }),
      },
    }) as never;

  /** Второй проход картинкой того же поколения. */
  const visionJob = (docId: string, docGeneration: number) =>
    ({
      id: 'j-reparse-vision',
      data: {
        sourceDocumentId: docId,
        s3Key: `test/${docId}/source.pdf`,
        pass: 'vision',
        docGeneration,
      },
    }) as never;

  async function docRow(docId: string) {
    const [r] = await db<
      {
        status: string;
        doc_number: string | null;
        parse_mode: string | null;
        parse_error_code: string | null;
        validation: { hasMismatch?: boolean } | null;
        dispatch_generation: number;
        reparse: { state?: string; reason?: string } | null;
      }[]
    >`SELECT status, doc_number, parse_mode, parse_error_code, validation, dispatch_generation, reparse
        FROM source_documents WHERE id = ${docId}`;
    return r!;
  }

  async function items(docId: string): Promise<string[]> {
    const rows = await db<{ name_raw: string }[]>`
      SELECT name_raw FROM source_document_items WHERE source_document_id = ${docId}
       ORDER BY line_no`;
    return rows.map((r) => r.name_raw);
  }

  describe('fencing по поколению', () => {
    it('задание прошлого поколения не трогает переразобранный документ', async () => {
      const docId = await seedParsedDoc();
      await requestReparse(docId); // поколение стало 1

      // Задание поколения 0 — то самое, что могло застрять в очереди до нажатия
      // кнопки. Оно обязано пройти мимо: документ уже принадлежит новой попытке.
      parseUpdPdf.mockResolvedValue(parsedResult({ docNumber: 'STALE' }));
      await handleJob(job(docId, 0));

      const r = await docRow(docId);
      expect(r.doc_number).toBe('OLD-1');
      expect(r.status).toBe('queued');
      expect(await items(docId)).toEqual(['Старая позиция']);
    });

    it('задание БЕЗ поля поколения ведёт себя как поколение 0', async () => {
      const docId = await seedParsedDoc();
      await requestReparse(docId);

      parseUpdPdf.mockResolvedValue(parsedResult({ docNumber: 'STALE' }));
      await handleJob(job(docId));

      expect((await docRow(docId)).doc_number).toBe('OLD-1');
    });

    it('документ без единого повтора разбирается как раньше', async () => {
      const docId = await seedParsedDoc();
      parseUpdPdf.mockResolvedValue(parsedResult({ docNumber: 'FRESH-1' }));
      await handleJob(job(docId));

      const r = await docRow(docId);
      expect(r.doc_number).toBe('FRESH-1');
      expect(r.parse_mode).toBe('text');
      expect(await items(docId)).toEqual(['Труба стальная']);
    });
  });

  describe('успешный повтор', () => {
    it('данные заменяются, диагностика прошлого разбора гаснет, попытка закрыта', async () => {
      const docId = await seedParsedDoc();
      const generation = await requestReparse(docId);

      parseUpdPdf.mockResolvedValue(parsedResult({ docNumber: 'NEW-7' }));
      await handleJob(job(docId, generation));

      const r = await docRow(docId);
      expect(r.doc_number).toBe('NEW-7');
      expect(r.status).toBe('parsed');
      expect(r.parse_error_code).toBeNull();
      expect(r.validation?.hasMismatch).toBe(false);
      expect(r.reparse?.state).toBe('succeeded');
      expect(await items(docId)).toEqual(['Труба стальная']);
    });

    it('исходный файл не трогается — его по-прежнему можно скачать', async () => {
      const docId = await seedParsedDoc();
      const generation = await requestReparse(docId);
      const before = await db`SELECT s3_key, filename, role FROM source_document_attachments
                                WHERE source_document_id = ${docId}`;

      parseUpdPdf.mockResolvedValue(parsedResult({ docNumber: 'NEW-8' }));
      await handleJob(job(docId, generation));

      const after = await db`SELECT s3_key, filename, role FROM source_document_attachments
                               WHERE source_document_id = ${docId}`;
      expect(after).toEqual(before);
    });
  });

  describe('откат неудачного повтора', () => {
    it('падение обоих проходов возвращает статус, диагностику и позиции', async () => {
      const docId = await seedParsedDoc();
      const generation = await requestReparse(docId);

      // Упавший текстовый разбор заказывает второй проход картинкой — повтору
      // это нужно не меньше, чем первой загрузке, поэтому документ ждёт в
      // очереди, а не откатывается сразу.
      parseUpdPdf.mockRejectedValue(new Error('модель недоступна'));
      await handleJob(job(docId, generation));
      expect((await docRow(docId)).status).toBe('queued');

      // А вот когда и картинка не прочиталась, шансов больше нет: документ
      // обязан вернуться в прежний вид, а не остаться «в очереди» навсегда.
      parseUpdVision.mockRejectedValue(new Error('картинка тоже не читается'));
      await handleJob(visionJob(docId, generation));

      const r = await docRow(docId);
      // Ровно то состояние, в котором документ был до нажатия кнопки.
      expect(r.status).toBe('parsed');
      expect(r.parse_error_code).toBe('validation_mismatch');
      expect(r.validation?.hasMismatch).toBe(true);
      expect(r.doc_number).toBe('OLD-1');
      expect(await items(docId)).toEqual(['Старая позиция']);
      expect(r.reparse?.state).toBe('failed');
    });

    it('повтор, упёршийся в дубликат, не оставляет новую шапку со старыми позициями', async () => {
      // Оригинал: тот же поставщик, номер и дата — по ним и ищется дубль.
      const originalId = await seedParsedDoc();
      parseUpdPdf.mockResolvedValue(parsedResult({ docNumber: 'DUP-9' }));
      await handleJob(job(originalId));
      expect((await docRow(originalId)).doc_number).toBe('DUP-9');

      const docId = await seedParsedDoc();
      const generation = await requestReparse(docId);
      parseUpdPdf.mockResolvedValue(parsedResult({ docNumber: 'DUP-9' }));
      await handleJob(job(docId, generation));

      const r = await docRow(docId);
      expect(r.status).toBe('parsed');
      expect(r.doc_number).toBe('OLD-1');
      expect(await items(docId)).toEqual(['Старая позиция']);
      expect(r.reparse?.reason).toBe('duplicate_detected');
    });
  });

  describe('повтор накладной пакетного пути', () => {
    /** Ответ parseWaybillBatch: N накладных из одного файла. */
    const waybills = (numbers: string[]) => ({
      parsed: {
        documents: numbers.map((docNumber, i) => ({
          form: 'tn_2116' as const,
          docNumber,
          docDate: '2026-07-10',
          shipper: null,
          consignee: null,
          items: [{ nameRaw: `Позиция ${i + 1}`, qty: 1, unit: 'шт' }],
          confidence: 0.9,
        })),
      },
      llmProviderId: null,
    });

    const waybillJob = (docId: string, docGeneration: number) =>
      ({
        id: 'j-waybill',
        data: { sourceDocumentId: docId, mode: 'waybill_single', docGeneration },
      }) as never;

    it('позиция в пакете выбирает нужный документ даже при неверном номере', async () => {
      // Ровно ради этого случая и заведён batch_index: в файле две накладные, а
      // номер у нашей распознан неверно — сопоставлять по нему нечего.
      const docId = await seedParsedDoc({
        kind: 'transport_waybill',
        parseMode: 'waybill_batch',
        batchIndex: 1,
      });
      const generation = await requestReparse(docId);
      parseWaybillBatch.mockResolvedValue(waybills(['ТН-1', 'ТН-2']));

      await handleJob(waybillJob(docId, generation));

      const r = await docRow(docId);
      expect(r.doc_number).toBe('ТН-2');
      expect(await items(docId)).toEqual(['Позиция 2']);
      expect(r.reparse?.state).toBe('succeeded');
    });

    it('несопоставимый результат откатывается, а не пишется наугад', async () => {
      // Исторические накладные (загруженные до появления batch_index) при
      // нескольких документах в файле сопоставить нечем — документ обязан
      // остаться прежним.
      const docId = await seedParsedDoc({
        kind: 'transport_waybill',
        parseMode: 'waybill_batch',
        batchIndex: null,
      });
      const generation = await requestReparse(docId);
      parseWaybillBatch.mockResolvedValue(waybills(['ТН-9', 'ТН-8']));

      await handleJob(waybillJob(docId, generation));

      const r = await docRow(docId);
      expect(r.doc_number).toBe('OLD-1');
      expect(await items(docId)).toEqual(['Старая позиция']);
      expect(r.reparse).toMatchObject({ state: 'failed', reason: 'ambiguous_source' });
    });
  });

  describe('выбор пути повтора', () => {
    it('обычный УПД → разбор файла целиком', async () => {
      const docId = await seedParsedDoc();
      const plan = await resolveReparsePlan(drizzleDb, await planInput(docId), 1);
      expect(plan).toMatchObject({
        kind: 'single',
        payload: { sourceDocumentId: docId, docGeneration: 1 },
      });
    });

    it('М-15 → тот же файл, но vision-промптом накладной', async () => {
      const docId = await seedParsedDoc({ kind: 'transport_waybill', parseMode: 'm15_vision' });
      const plan = await resolveReparsePlan(drizzleDb, await planInput(docId), 1);
      expect(plan).toMatchObject({ kind: 'm15', payload: { docKind: 'm15', docGeneration: 1 } });
    });

    it('накладная пакетного пути → пакетный разбор её вложений', async () => {
      const docId = await seedParsedDoc({
        kind: 'transport_waybill',
        parseMode: 'waybill_batch',
        batchIndex: 0,
      });
      const plan = await resolveReparsePlan(drizzleDb, await planInput(docId), 1);
      expect(plan).toMatchObject({
        kind: 'waybill',
        payload: { mode: 'waybill_single', docGeneration: 1 },
      });
    });

    it('логический УПД из комплекта → сегментное задание по страницам манифеста', async () => {
      const docId = await seedParsedDoc();
      const [doc] = await db<{ bundle_id: string }[]>`
        SELECT bundle_id FROM source_documents WHERE id = ${docId}`;
      const segmentId = randomUUID();
      await db`UPDATE source_bundles SET active_upload_generation = 0, status = 'parsed'
                WHERE id = ${doc!.bundle_id}`;
      await db`INSERT INTO bundle_segments
                 (id, bundle_id, generation, segment_index, source_document_id, page_refs, confidence)
               VALUES (${segmentId}, ${doc!.bundle_id}, 0, 0, ${docId},
                       ${JSON.stringify([{ itemId: randomUUID(), page: 1 }])}::jsonb, 'normal')`;

      const plan = await resolveReparsePlan(drizzleDb, await planInput(docId), 1);
      expect(plan).toMatchObject({
        kind: 'segment',
        // reparse:true ослабляет fencing сборки: комплект давно опубликован, но
        // страницы этого документа манифест по-прежнему описывает.
        payload: { segmentId, reparse: true, docGeneration: 1 },
      });
    });

    it('идущая пересборка комплекта блокирует повтор', async () => {
      const docId = await seedParsedDoc();
      const [doc] = await db<{ bundle_id: string }[]>`
        SELECT bundle_id FROM source_documents WHERE id = ${docId}`;
      await db`UPDATE source_bundles SET active_upload_generation = 0, status = 'processing'
                WHERE id = ${doc!.bundle_id}`;
      await db`INSERT INTO bundle_segments
                 (id, bundle_id, generation, segment_index, source_document_id, page_refs, confidence)
               VALUES (${randomUUID()}, ${doc!.bundle_id}, 0, 0, ${docId},
                       ${JSON.stringify([{ itemId: randomUUID(), page: 1 }])}::jsonb, 'normal')`;

      expect(await resolveReparsePlan(drizzleDb, await planInput(docId), 1)).toEqual({
        blocked: 'assembly_busy',
      });
    });

    it('ключ задания несёт поколение: повтор не сталкивается с прошлой попыткой', async () => {
      const docId = await seedParsedDoc();
      const first = await resolveReparsePlan(drizzleDb, await planInput(docId), 1);
      const second = await resolveReparsePlan(drizzleDb, await planInput(docId), 2);
      expect('dedupeKey' in first && 'dedupeKey' in second && first.dedupeKey !== second.dedupeKey).toBe(
        true,
      );
    });
  });

  /** Колонки документа, которых достаточно планировщику. */
  async function planInput(docId: string) {
    const [r] = await db<
      { id: string; kind: string; parse_mode: string | null; dispatch_generation: number }[]
    >`SELECT id, kind, parse_mode, dispatch_generation FROM source_documents WHERE id = ${docId}`;
    return {
      id: r!.id,
      kind: r!.kind,
      parseMode: r!.parse_mode,
      dispatchGeneration: r!.dispatch_generation,
    };
  }
});
