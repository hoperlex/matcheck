/**
 * Экспедиторская расписка в пакетном разборе накладных.
 *
 * Расписку модель не знает: промпт накладных по инструкции её игнорирует, и
 * пустой ответ уводил файл в общий УПД-разбор — ложный «УПД, распознано
 * частично» с поставщиком-экспедитором (26-02261022358 от 05.11.2026). Теперь
 * её разбирает код по текстовому слою и заводит «Накладную», которая едет
 * инспектору на планшет.
 *
 * Здесь проверяется вся цепочка на настоящем PDF с текстовым слоем: модель не
 * вызывается, документ `parsed` со сторонами и одной позицией, проходит
 * предикат планшета; не-расписка идёт прежним путём; повтор разбора — тем же
 * кодом, без модели.
 *
 * Запуск: см. заголовок test/integration/upload-documents-characterization.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTextPdfPages } from '../helpers/make-pdf.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

vi.setConfig({ testTimeout: 30_000 });

const sql = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 4 }) : null;

const RECEIPT_PDF = makeTextPdfPages([
  [
    'Экспедиторская расписка',
    '№26-02261022358 от 05.11.2026 г.',
    'Отправитель ЗАО "ПРИБОР"',
    'ИНН/КПП: 2200000091/-',
    'Получатель ООО "СТРОЙКА"',
    'ИНН/КПП: 7700000092/-',
    'всего 6 534 2,18',
  ],
]);
const NOT_RECEIPT_PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
let storedFile: Buffer = RECEIPT_PDF;

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
  getObject: vi.fn(async () => storedFile),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  presign: vi.fn().mockResolvedValue('https://s3.example/signed'),
}));
// Провайдер не openrouter: рендер PDF в PNG для разбора по тексту не нужен.
vi.mock('../../src/domain/llm/registry.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/domain/llm/registry.js');
  return { ...actual, getDefaultProviderKind: vi.fn().mockResolvedValue('google_ai_studio') };
});
const parseWaybillBatch = vi.fn();
vi.mock('../../src/domain/edo/waybill-batch.parser.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/edo/waybill-batch.parser.js',
  );
  return { ...actual, parseWaybillBatch: (...args: unknown[]) => parseWaybillBatch(...args) };
});
vi.mock('../../src/domain/jobs/job-outbox.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/jobs/job-outbox.js',
  );
  return { ...actual, processJobOutbox: vi.fn().mockResolvedValue({ dispatched: 0, failed: 0 }) };
});

const { handleJob } = await import('../../src/worker.js');
const { mobileVisibleSourceDocumentSql } = await import(
  '../../src/domain/sourceDocuments/mobile-visibility.js'
);
const { sourceDocuments } = await import('../../src/db/schema.js');

suite('экспедиторская расписка → накладная для планшета', () => {
  const db = sql!;
  const siteId = randomUUID();
  const supplierId = randomUUID();

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name, is_active)
             VALUES (${siteId}, ${'ER'}, 'Объект расписки', true)`;
    await db`INSERT INTO suppliers (id, inn, name)
             VALUES (${supplierId}, '2200000091', 'ЗАО «ПРИБОР»')`;
  });

  afterAll(async () => {
    // Ветка «не расписка» уходит прежним путём в общий разбор и ставит задание.
    // Оставленное в общей БД, оно ломает соседний набор, который считает
    // задания очереди без оглядки на свой пакет (router-provenance).
    await db`DELETE FROM job_outbox
              WHERE payload->>'sourceDocumentId' IN (
                SELECT id::text FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM sites WHERE id = ${siteId}`;
    await db`DELETE FROM suppliers WHERE id = ${supplierId}`;
    await db`DELETE FROM counterparties WHERE inn = '7700000092'`;
    await db.end({ timeout: 5 });
  });

  beforeEach(() => {
    parseWaybillBatch.mockReset();
    parseWaybillBatch.mockResolvedValue({ parsed: { documents: [] }, llmProviderId: null });
    storedFile = RECEIPT_PDF;
  });

  /** Пакет накладных с техзаписью и оригиналом — как его заводит router. */
  async function makeBundle(): Promise<{ bundleId: string; docId: string }> {
    const bundleId = randomUUID();
    const docId = randomUUID();
    await db`INSERT INTO source_bundles
        (id, site_id, expected_date, direction, status, bundle_hash, dispatch_generation)
      VALUES (${bundleId}, ${siteId}, '2026-11-11', 'inbound', 'queued', ${bundleId}, 0)`;
    await db`INSERT INTO source_documents
        (id, kind, is_technical, direction, status, origin, site_id, bundle_id, queued_at)
      VALUES (${docId}, 'transport_waybill', true, 'inbound', 'queued', 'manual_pdf',
              ${siteId}, ${bundleId}, now())`;
    await db`INSERT INTO source_document_attachments
        (source_document_id, s3_key, filename, mime_type, role)
      VALUES (${docId}, ${`test/${docId}/er.pdf`}, '26-02261022358 Накладная.pdf',
              'application/pdf', 'original')`;
    return { bundleId, docId };
  }

  type DocRow = {
    id: string;
    kind: string;
    status: string;
    doc_number: string | null;
    waybill_prompt_kind: string | null;
    llm_provider_id: string | null;
    supplier_directory_id: string | null;
    supplier_inn_raw: string | null;
    consignee_inn_raw: string | null;
    site_id: string | null;
    expected_date: Date | null;
  };
  const docsOf = (bundleId: string) =>
    db<DocRow[]>`
      SELECT id, kind, status, doc_number, waybill_prompt_kind, llm_provider_id,
             supplier_directory_id, supplier_inn_raw, consignee_inn_raw, site_id, expected_date
        FROM source_documents
       WHERE bundle_id = ${bundleId} AND is_technical = false`;
  const itemsOf = (docId: string) =>
    db<{ name_raw: string; qty: string; unit: string; material_id: string | null }[]>`
      SELECT name_raw, qty, unit, material_id FROM source_document_items
       WHERE source_document_id = ${docId} ORDER BY line_no`;

  it('расписка → «Накладная» parsed без модели и видна на планшете', async () => {
    const { bundleId } = await makeBundle();

    await handleJob({ id: 'er1', data: { bundleId, bundleGeneration: 0 } } as never);

    expect(parseWaybillBatch).not.toHaveBeenCalled();
    const docs = await docsOf(bundleId);
    expect(docs).toHaveLength(1);
    const doc = docs[0]!;
    expect(doc).toMatchObject({
      kind: 'transport_waybill',
      status: 'parsed',
      doc_number: '26-02261022358',
      waybill_prompt_kind: 'forwarding_receipt',
      llm_provider_id: null,
      // Поставщик — отправитель, найденный в справочнике по ИНН, а не экспедитор.
      supplier_directory_id: supplierId,
      supplier_inn_raw: '2200000091',
      consignee_inn_raw: '7700000092',
      site_id: siteId,
    });
    expect(doc.expected_date).not.toBeNull();

    // Одна позиция «груз — N мест»; в справочник материалов она не заводится.
    expect(await itemsOf(doc.id)).toEqual([
      { name_raw: 'Груз по экспедиторской расписке (534 кг, 2,18 м³)', qty: '6.0000', unit: 'мест', material_id: null },
    ]);

    // Ради этого всё и делалось: документ проходит предикат выдачи планшету.
    const visible = await drizzle(db)
      .select({ id: sourceDocuments.id })
      .from(sourceDocuments)
      .where(and(eq(sourceDocuments.id, doc.id), mobileVisibleSourceDocumentSql()));
    expect(visible).toHaveLength(1);
  });

  it('не расписка — путь прежний: вызывается модель', async () => {
    const { bundleId } = await makeBundle();
    storedFile = NOT_RECEIPT_PDF;

    await handleJob({ id: 'er2', data: { bundleId, bundleGeneration: 0 } } as never);

    expect(parseWaybillBatch).toHaveBeenCalledTimes(1);
  });

  it('повтор разбора расписки идёт тем же кодом, без модели', async () => {
    const docId = randomUUID();
    await db`INSERT INTO source_documents
        (id, kind, is_technical, direction, status, origin, site_id, doc_number, doc_date,
         parse_mode, batch_index, waybill_prompt_kind, dispatch_generation, queued_at, reparse)
      VALUES (${docId}, 'transport_waybill', false, 'inbound', 'queued', 'manual_pdf',
              ${siteId}, '26-02261022358', '2026-11-05', 'waybill_batch', 0, 'forwarding_receipt',
              0, now(),
              ${JSON.stringify({ generation: 0, state: 'queued', snapshot: { status: 'parsed' } })}::jsonb)`;
    await db`INSERT INTO source_document_attachments
        (source_document_id, s3_key, filename, mime_type, role)
      VALUES (${docId}, ${`test/${docId}/er.pdf`}, 'er.pdf', 'application/pdf', 'original')`;

    await handleJob({
      id: 'er3',
      data: { mode: 'waybill_single', sourceDocumentId: docId, docGeneration: 0 },
    } as never);

    expect(parseWaybillBatch).not.toHaveBeenCalled();
    const [row] = await db<{ status: string; reparse: { state: string } }[]>`
      SELECT status, reparse FROM source_documents WHERE id = ${docId}`;
    expect(row).toMatchObject({ status: 'parsed' });
    expect(row?.reparse?.state).toBe('succeeded');
    expect(await itemsOf(docId)).toEqual([
      { name_raw: 'Груз по экспедиторской расписке (534 кг, 2,18 м³)', qty: '6.0000', unit: 'мест', material_id: null },
    ]);
  });
});
