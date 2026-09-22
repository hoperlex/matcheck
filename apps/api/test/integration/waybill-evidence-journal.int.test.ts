/**
 * След разбора пакета накладных и сохранность журнала вызовов.
 *
 * Разбор пакета логируется на ТЕХНИЧЕСКУЮ запись документа, которую воркер
 * удаляет сразу после создания реальных документов. Пока внешний ключ был
 * ON DELETE CASCADE, запись журнала уходила вместе с ней — и на бою по
 * накладным журнала не было вовсе: у документа № 20 144 заполнены
 * llm_provider_id и llm_confidence, то есть вызов был, а записи нет.
 *
 * Здесь проверяются три свойства правки: запись журнала переживает удаление
 * техзаписи, улика разбора несёт координаты пакета и попытки, и ни одно из
 * этого не может уронить сам разбор.
 *
 * Запуск: см. заголовок test/integration/waybill-1t-fallback.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

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
vi.mock('../../src/db/client.js', () => ({ db: sql ? drizzle(sql) : ({} as never) }));
vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  getObject: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4\n%%EOF\n')),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  presign: vi.fn().mockResolvedValue('https://s3.example/signed'),
}));
vi.mock('../../src/domain/llm/registry.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/domain/llm/registry.js');
  return { ...actual, getDefaultProviderKind: vi.fn().mockResolvedValue('google_ai_studio') };
});

// Сбой подготовки улики имитируется здесь, а не временным CHECK на таблице:
// схема общая для всего прогона, и её правка ломала бы соседние наборы.
let failEvidencePrep = false;
vi.mock('../../src/domain/sourceDocuments/bundle-import-registry.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/sourceDocuments/bundle-import-registry.js',
  );
  const real = actual.resolveRootBundle as (...a: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    resolveRootBundle: (...args: unknown[]) => {
      if (failEvidencePrep) throw new Error('evidence prep boom');
      return real(...args);
    },
  };
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

function waybill(docNumber: string) {
  return {
    parsed: {
      documents: [
        {
          form: 'tn_2116' as const,
          docNumber,
          docDate: '2026-09-21',
          shipper: { inn: '7727447845', name: 'ООО «АРМОДРЕЙН»' },
          consignee: { inn: '7736255508', name: 'ООО «СУ-10»' },
          items: [{ nameRaw: 'Кирпич', qty: 8000, unit: 'шт', sum: null }],
          confidence: 0.9,
        },
      ],
    },
    llmProviderId: null,
  };
}

suite('журнал и след разбора пакета накладных (реальный PostgreSQL)', () => {
  const db = sql!;
  const siteId = randomUUID();

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name, is_active)
             VALUES (${siteId}, ${`EV${Date.now() % 10000}`}, 'Объект улик', true)`;
  });

  afterAll(async () => {
    await cleanup();
    await db`DELETE FROM sites WHERE id = ${siteId}`;
    await db.end({ timeout: 5 });
  });

  async function cleanup(): Promise<void> {
    await db`DELETE FROM recognition_evidence_events WHERE bundle_id IN (
      SELECT id FROM source_bundles WHERE site_id = ${siteId})`;
    await db`DELETE FROM llm_calls WHERE bundle_id IN (
      SELECT id FROM source_bundles WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_document_items WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await db`DELETE FROM bundle_import_items WHERE bundle_id IN (
      SELECT id FROM source_bundles WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_bundles WHERE site_id = ${siteId} AND parent_bundle_id IS NOT NULL`;
    await db`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  }

  beforeEach(async () => {
    parseWaybillBatch.mockReset();
    parseWaybillBatch.mockResolvedValue(waybill('ТН-900'));
    failEvidencePrep = false;
    await cleanup();
  });

  /**
   * Пакет накладных ровно в той форме, в какой его заводит router: корневая
   * загрузка, дочерний пакет под неё, техзапись с оригиналом и строка реестра.
   */
  async function makeChildBundle(): Promise<{
    rootId: string;
    childId: string;
    techId: string;
    registryItemId: string;
    s3Key: string;
  }> {
    const rootId = randomUUID();
    const childId = randomUUID();
    const techId = randomUUID();
    const registryItemId = randomUUID();
    const s3Key = `test/${childId}/ttn.pdf`;
    await db`INSERT INTO source_bundles
        (id, site_id, direction, status, bundle_hash, dispatch_generation, active_upload_generation)
      VALUES (${rootId}, ${siteId}, 'inbound', 'processing', ${rootId}, 0, 0)`;
    await db`INSERT INTO source_bundles
        (id, site_id, direction, status, bundle_hash, dispatch_generation, parent_bundle_id)
      VALUES (${childId}, ${siteId}, 'inbound', 'queued', ${childId}, 0, ${rootId})`;
    await db`INSERT INTO source_documents
        (id, kind, is_technical, direction, status, origin, site_id, bundle_id, queued_at)
      VALUES (${techId}, 'transport_waybill', true, 'inbound', 'queued', 'manual_pdf',
              ${siteId}, ${childId}, now())`;
    await db`INSERT INTO source_document_attachments
        (source_document_id, s3_key, filename, mime_type, role)
      VALUES (${techId}, ${s3Key}, 'ttn.pdf', 'application/pdf', 'original')`;
    await db`INSERT INTO bundle_import_items
        (id, bundle_id, source_filename, input_s3_key, mime_type, status, input_order,
         upload_generation, sub_bundle_id)
      VALUES (${registryItemId}, ${rootId}, 'ttn.pdf', ${s3Key}, 'application/pdf', 'created', 3, 0,
              ${childId})`;
    return { rootId, childId, techId, registryItemId, s3Key };
  }

  const runJob = (childId: string) =>
    handleJob({ id: 'bundle-job', data: { bundleId: childId, bundleGeneration: 0 } } as never);

  async function evidenceOf(rootId: string) {
    const rows = await db<{ payload: Record<string, unknown>; generation: number }[]>`
      SELECT payload, generation FROM recognition_evidence_events
       WHERE bundle_id = ${rootId} AND evidence_type = 'waybill_batch_result'
       ORDER BY created_at`;
    return rows;
  }

  it('запись журнала переживает удаление технической записи', async () => {
    const { childId, techId } = await makeChildBundle();
    // Журнал пишет сам парсер, а он в этом наборе подменён — поэтому запись
    // кладём руками ровно так, как это делает parseWaybillBatch: на техзапись
    // и на пакет.
    const callId = randomUUID();
    await db`INSERT INTO llm_calls (id, source_document_id, bundle_id, doc_kind, request_messages, latency_ms)
             VALUES (${callId}, ${techId}, ${childId}, 'transport_waybill', '[]'::jsonb, 10)`;

    await runJob(childId);

    // Техзапись удалена…
    expect(await db`SELECT 1 FROM source_documents WHERE id = ${techId}`).toHaveLength(0);
    // …а запись журнала осталась и по-прежнему связана с пакетом.
    const [row] = await db<{ source_document_id: string | null; bundle_id: string }[]>`
      SELECT source_document_id, bundle_id FROM llm_calls WHERE id = ${callId}`;
    expect(row).toBeTruthy();
    expect(row!.source_document_id).toBeNull();
    expect(row!.bundle_id).toBe(childId);
  });

  it('улика пишется на корень с его поколением и несёт координаты попытки', async () => {
    const { rootId, childId, registryItemId, s3Key } = await makeChildBundle();

    await runJob(childId);

    const rows = await evidenceOf(rootId);
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as {
      childBundleId: string;
      childDispatchGeneration: number;
      rootUploadGeneration: number | null;
      inputFiles: { s3Key: string; registryItemId: string | null; inputOrder: number }[];
      returnedDocuments: { docNumber: string | null; itemsCount: number }[];
      createdDocumentIds: string[];
    };
    // Поколение события — корневое, дочернее лежит в payload: иначе после
    // дозагрузки события разных поколений стали бы неразличимы.
    expect(rows[0]!.generation).toBe(0);
    expect(payload.childBundleId).toBe(childId);
    expect(payload.childDispatchGeneration).toBe(0);
    expect(payload.rootUploadGeneration).toBe(0);
    // Файл сопоставлен со строкой реестра по s3-ключу, а не по порядку.
    expect(payload.inputFiles).toEqual([
      { filename: 'ttn.pdf', s3Key, registryItemId, inputOrder: 3 },
    ]);
    expect(payload.returnedDocuments).toEqual([
      expect.objectContaining({ docNumber: 'ТН-900', itemsCount: 1 }),
    ]);
    expect(payload.createdDocumentIds).toHaveLength(1);
  });

  it('повторная попытка добавляет вторую улику, а не переписывает первую', async () => {
    const { rootId, childId } = await makeChildBundle();

    await runJob(childId);
    // Повтор того же задания: техзапись уже удалена, разбор просто выходит —
    // но если бы он дошёл до записи, улик стало бы две. Поэтому вторую попытку
    // имитируем полноценно: возвращаем техзапись, как после отката.
    const techId = randomUUID();
    await db`INSERT INTO source_documents
        (id, kind, is_technical, direction, status, origin, site_id, bundle_id, queued_at)
      VALUES (${techId}, 'transport_waybill', true, 'inbound', 'queued', 'manual_pdf',
              ${siteId}, ${childId}, now())`;
    await db`INSERT INTO source_document_attachments
        (source_document_id, s3_key, filename, mime_type, role)
      VALUES (${techId}, ${`test/${childId}/ttn.pdf`}, 'ttn.pdf', 'application/pdf', 'original')`;
    await db`UPDATE source_bundles SET status = 'queued' WHERE id = ${childId}`;

    await runJob(childId);

    const rows = await evidenceOf(rootId);
    expect(rows).toHaveLength(2);
  });

  it('сбой записи улики не меняет результат распознавания', async () => {
    const { rootId, childId } = await makeChildBundle();
    failEvidencePrep = true;

    await runJob(childId);

    // Документ создан, пакет разобран — диагностика не тронула основной путь.
    const docs = await db<{ id: string; doc_number: string | null }[]>`
      SELECT id, doc_number FROM source_documents
       WHERE bundle_id = ${childId} AND is_technical = false`;
    expect(docs).toHaveLength(1);
    expect(docs[0]!.doc_number).toBe('ТН-900');
    expect(await evidenceOf(rootId)).toHaveLength(0);
  });
});
