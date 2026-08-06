/**
 * Границы сохранения сторон документа: что реально оказывается в БД после
 * разбора.
 *
 * Парсеры проверяются отдельно (upd-pdf-local.parser.test.ts) и знают только
 * «что распозналось». Здесь проверяется следующий шаг — какие колонки записал
 * воркер, и он ловит ровно те ошибки, которые парсерные тесты пропускают:
 *   * сторону без ИНН нельзя связать с counterparties (inn NOT NULL), поэтому
 *     имя обязано лечь в *_name_raw, а FK остаться пустым;
 *   * ветка дубликата (duplicate_upd) — отдельный терминальный UPDATE, до
 *     записи шапки выполнение не доходит, и новые поля туда легко забыть;
 *   * у накладных ТН-2116 грузополучатель должен попасть в consignee_id, а
 *     recipient_id (операционный получатель отгрузки) остаться пустым.
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
vi.mock('../../src/db/client.js', () => ({ db: drizzle(sql!) }));
vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  getObject: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4\n%%EOF\n')),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  presign: vi.fn().mockResolvedValue('https://s3.example/signed'),
}));

// Распознавание замокано: тест про запись в БД, а не про качество разбора.
const parseUpdPdf = vi.fn();
vi.mock('../../src/domain/edo/upd-pdf.parser.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/edo/upd-pdf.parser.js',
  );
  return { ...actual, parseUpdPdf: (...args: unknown[]) => parseUpdPdf(...args) };
});
const parseWaybillBatch = vi.fn();
vi.mock('../../src/domain/edo/waybill-batch.parser.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/edo/waybill-batch.parser.js',
  );
  return { ...actual, parseWaybillBatch: (...args: unknown[]) => parseWaybillBatch(...args) };
});

const { handleJob } = await import('../../src/worker.js');

type ParsedParty = { inn: string | null; kpp: string | null; name: string | null };

function parsedUpd(over: {
  docNumber?: string;
  recipient?: ParsedParty | null;
  consignee?: ParsedParty | null;
}) {
  return {
    parsed: {
      docNumber: over.docNumber ?? '18266',
      docDate: '2026-07-10',
      totalSum: 597341,
      vatSum: 99556.83,
      itemsCount: 1,
      supplier: { inn: '5001120691', kpp: '500101001', name: 'ООО "АРХЕТИП"' },
      recipient:
        over.recipient === undefined
          ? { inn: '7736255508', kpp: '774550001', name: 'ООО «СУ-10»' }
          : over.recipient,
      consignee: over.consignee ?? null,
      items: [
        {
          nameRaw: 'Керамический Гранит Atlas Concorde',
          qty: 280,
          unit: 'шт',
          price: 1777.8,
          sum: 597341,
          vatRate: 20,
          vatSum: 99556.83,
        },
      ],
      confidence: 0.95,
    },
    textLength: 5000,
    llmProviderId: null,
  };
}

suite('стороны документа: что записывает воркер (реальный PostgreSQL)', () => {
  const db = sql!;
  const siteId = randomUUID();
  const bundleIds: string[] = [];

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`PRT${Date.now() % 10000}`}, 'Стороны')`;
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db`DELETE FROM sites WHERE id = ${siteId}`;
    await db.end({ timeout: 5 });
  });

  async function cleanup(): Promise<void> {
    await db`DELETE FROM source_document_items WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_document_attachments WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await db`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  }

  beforeEach(async () => {
    parseUpdPdf.mockReset();
    parseWaybillBatch.mockReset();
    await cleanup();
    bundleIds.length = 0;
  });

  /** Документ УПД в очереди + пакет, как их создаёт загрузка. */
  async function seedUpd(): Promise<string> {
    const bundleId = randomUUID();
    const docId = randomUUID();
    bundleIds.push(bundleId);
    await db`INSERT INTO source_bundles (id, site_id, direction, status, bundle_hash, doc_count)
             VALUES (${bundleId}, ${siteId}, 'inbound', 'queued', ${bundleId}, 1)`;
    await db`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, bundle_id)
             VALUES (${docId}, 'upd', 'inbound', 'queued', 'manual_pdf', ${siteId}, ${bundleId})`;
    return docId;
  }

  async function row(docId: string) {
    const [r] = await db<
      {
        status: string;
        parse_error_code: string | null;
        buyer_id: string | null;
        buyer_name_raw: string | null;
        consignee_id: string | null;
        consignee_name_raw: string | null;
        recipient_id: string | null;
        contractor_id: string | null;
      }[]
    >`SELECT status, parse_error_code, buyer_id, buyer_name_raw, consignee_id,
             consignee_name_raw, recipient_id, contractor_id
        FROM source_documents WHERE id = ${docId}`;
    return r!;
  }

  const job = (docId: string) =>
    ({ id: 'j1', data: { sourceDocumentId: docId, s3Key: `test/${docId}/source.pdf` } }) as never;

  it('грузополучатель без ИНН: имя сохранено, FK пустой', async () => {
    // Главный случай: графу 4 печатают без ИНН, а counterparties.inn NOT NULL.
    // Раньше такая сторона просто исчезала бы.
    const docId = await seedUpd();
    parseUpdPdf.mockResolvedValue(
      parsedUpd({ consignee: { inn: null, kpp: null, name: 'ООО «АЛЬЯНС»' } }),
    );

    await handleJob(job(docId));

    const r = await row(docId);
    expect(r.status).toBe('parsed');
    expect(r.consignee_name_raw).toBe('ООО «АЛЬЯНС»');
    expect(r.consignee_id).toBeNull();
  });

  it('грузополучатель с ИНН: заводится контрагент, но НЕ подрядчик', async () => {
    const docId = await seedUpd();
    parseUpdPdf.mockResolvedValue(
      parsedUpd({
        consignee: { inn: '7725494913', kpp: null, name: 'ООО "ФСК Инжиниринг"' },
      }),
    );

    await handleJob(job(docId));

    const r = await row(docId);
    expect(r.consignee_id).not.toBeNull();
    expect(r.consignee_name_raw).toBe('ООО "ФСК Инжиниринг"');
    // Роль customer: список подрядчиков наполняют люди, а не распознавание.
    const [cp] = await db<{ is_contractor: boolean; is_customer: boolean }[]>`
      SELECT is_contractor, is_customer FROM counterparties WHERE id = ${r.consignee_id!}`;
    expect(cp!.is_contractor).toBe(false);
    expect(cp!.is_customer).toBe(true);
  });

  it('покупатель пишется в buyer_*, contractor_id не трогается', async () => {
    const docId = await seedUpd();
    parseUpdPdf.mockResolvedValue(parsedUpd({}));

    await handleJob(job(docId));

    const r = await row(docId);
    expect(r.buyer_name_raw).toBe('ООО «СУ-10»');
    expect(r.buyer_id).not.toBeNull();
    // recipient_id остаётся заполненным для обратной совместимости, а
    // contractor_id — поле оператора, распознавание его не назначает.
    expect(r.recipient_id).toBe(r.buyer_id);
    expect(r.contractor_id).toBeNull();
  });

  it('дубликат: стороны сохраняются, хотя ветка — отдельный UPDATE', async () => {
    // Первый документ занимает пару (поставщик, номер, дата).
    const firstId = await seedUpd();
    parseUpdPdf.mockResolvedValue(parsedUpd({}));
    await handleJob(job(firstId));
    expect((await row(firstId)).status).toBe('parsed');

    // Второй с тем же номером и датой — уйдёт в ветку duplicate_upd.
    const secondId = await seedUpd();
    parseUpdPdf.mockResolvedValue(
      parsedUpd({ consignee: { inn: null, kpp: null, name: 'ООО «АЛЬЯНС»' } }),
    );
    await handleJob(job(secondId));

    const r = await row(secondId);
    expect(r.parse_error_code).toBe('duplicate_upd');
    expect(r.status).toBe('needs_resolution');
    expect(r.buyer_name_raw).toBe('ООО «СУ-10»');
    expect(r.consignee_name_raw).toBe('ООО «АЛЬЯНС»');
  });

  it('ТН-2116: грузополучатель в consignee_id, recipient_id пуст', async () => {
    const bundleId = randomUUID();
    const techId = randomUUID();
    bundleIds.push(bundleId);
    await db`INSERT INTO source_bundles (id, site_id, direction, status, bundle_hash, doc_count)
             VALUES (${bundleId}, ${siteId}, 'inbound', 'queued', ${bundleId}, 1)`;
    await db`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, bundle_id, is_technical)
             VALUES (${techId}, 'transport_waybill', 'inbound', 'queued', 'manual_pdf', ${siteId}, ${bundleId}, true)`;
    await db`INSERT INTO source_document_attachments (source_document_id, s3_key, filename, mime_type, size_bytes)
             VALUES (${techId}, ${`test/${techId}/tn.pdf`}, 'tn.pdf', 'application/pdf', 1000)`;

    parseWaybillBatch.mockResolvedValue({
      parsed: {
        documents: [
          {
            form: 'tn_2116',
            docNumber: '297',
            docDate: '2026-08-05',
            shipper: { inn: '5001120691', name: 'ООО «АЛЮПРОМ»' },
            consignee: { inn: '7736255508', name: 'ООО «СУ-10»' },
            items: [{ nameRaw: 'Профиль', qty: 10, unit: 'шт' }],
            confidence: 0.9,
          },
        ],
      },
      llmProviderId: null,
    });

    await handleJob({ id: 'j2', data: { bundleId } } as never);

    const [doc] = await db<
      {
        id: string;
        consignee_id: string | null;
        consignee_name_raw: string | null;
        recipient_id: string | null;
      }[]
    >`SELECT id, consignee_id, consignee_name_raw, recipient_id
        FROM source_documents
       WHERE bundle_id = ${bundleId} AND is_technical = false`;
    expect(doc).toBeTruthy();
    expect(doc!.consignee_name_raw).toBe('ООО «СУ-10»');
    expect(doc!.consignee_id).not.toBeNull();
    // Ключевое: получатель отгрузки остаётся незанятым — раньше грузополучатель
    // ТН писался именно туда и подменял бы колонку «Покупатель».
    expect(doc!.recipient_id).toBeNull();
  });
});
