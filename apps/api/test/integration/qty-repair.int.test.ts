/**
 * Восстановление количества в воркере: режимы рубильника и запреты.
 *
 * Юнит-тесты (test/qty-repair.test.ts) проверяют само правило на числах, здесь
 * — поведение воркера целиком: меняются ли позиции в БД, что попадает в
 * служебный след и работает ли защита «документ уехал в операцию».
 *
 * Разрешённый список пар «единица — код» в боевом коде ПУСТ, поэтому сценарии
 * применения подменяют детектор: проверяется механика воркера, а не состав
 * списка. Замок на пустоту списка живёт в юнит-тестах.
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
vi.mock('../../src/db/client.js', () => ({ db: drizzle(sql!) }));
// loadEnv кэширует разбор process.env при первом вызове, поэтому менять
// переменную между тестами бесполезно — подменяем сам режим.
const mocks = vi.hoisted(() => ({ qtyRepairMode: 'off' as 'off' | 'shadow' | 'on' }));
vi.mock('../../src/lib/env.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/lib/env.js');
  const load = actual.loadEnv as () => Record<string, unknown>;
  return {
    ...actual,
    loadEnv: () => ({ ...load(), UPD_QTY_REPAIR: mocks.qtyRepairMode }),
  };
});
// JPEG-сигнатура: воркер обязан пойти vision-путём, иначе правило под запрет
// по parseMode и сценарии применения не проверятся.
vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  getObject: vi.fn().mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a])),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  presign: vi.fn().mockResolvedValue('https://s3.example/signed'),
}));

const parseUpdVision = vi.fn();
vi.mock('../../src/domain/edo/upd-vision.parser.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/edo/upd-vision.parser.js',
  );
  return { ...actual, parseUpdVision: (...args: unknown[]) => parseUpdVision(...args) };
});
vi.mock('../../src/domain/jobs/job-outbox.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/jobs/job-outbox.js',
  );
  return { ...actual, processJobOutbox: vi.fn().mockResolvedValue({ dispatched: 0, failed: 0 }) };
});

// Подмена «разрешено применять» без правки боевого списка пар: детектор
// возвращает то же, что настоящий, но помечает кандидата применимым.
let forceApplicable = false;
// Сбой наблюдения: проверяется, что необязательная диагностика не может
// уронить разбор документа.
let throwOnDetect = false;
vi.mock('../../src/domain/edo/qty-repair.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/edo/qty-repair.js',
  );
  const detect = actual.detectQtyRepairs as (...a: unknown[]) => Array<Record<string, unknown>>;
  return {
    ...actual,
    detectQtyRepairs: (...args: unknown[]) => {
      if (throwOnDetect) throw new Error('qty repair detect boom');
      const found = detect(...args);
      return forceApplicable
        ? found.map((c) => ({ ...c, applicable: true, blockedBy: undefined }))
        : found;
    },
  };
});
// Сбой проверки следа в операциях: правка обязана отменяться, а не сохраняться.
let throwOnOperationTrace = false;
vi.mock('../../src/domain/sourceDocuments/operation-trace.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/sourceDocuments/operation-trace.js',
  );
  const real = actual.operationTrace as (...a: unknown[]) => Promise<string | null>;
  return {
    ...actual,
    operationTrace: async (...args: unknown[]) => {
      if (throwOnOperationTrace) throw new Error('operation trace boom');
      return real(...args);
    },
  };
});

const { handleJob } = await import('../../src/worker.js');

/** УПД УТ-480: в бумаге 57 × 4 450,82, модель вернула количество 16. */
function parsedUt480() {
  return {
    parsed: {
      docNumber: 'UT-480-TEST',
      docDate: '2026-09-13',
      totalSum: 309510,
      vatSum: 55813.28,
      itemsCount: 1,
      supplier: { inn: '7727798773', kpp: '772701001', name: 'ООО «ТК «Скарабей С»' },
      recipient: { inn: '7736255508', kpp: '773601001', name: 'ООО «СУ-10»' },
      consignee: null,
      items: [
        {
          rowNo: 1,
          nameRaw: 'ОПТИМИСТ W220 Краска негорючая КМ0 моющаяся 14кг',
          qty: 16,
          unit: 'шт',
          price: 4450.82,
          sum: 309510,
          vatRate: 22,
          vatSum: 55813.28,
        },
      ],
      confidence: 0.95,
    },
    textLength: 100,
    llmProviderId: null,
  };
}

suite('восстановление количества в воркере (реальный PostgreSQL)', () => {
  const db = sql!;
  const siteId = randomUUID();

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`QR${Date.now() % 10000}`}, 'Qty repair')`;
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db`DELETE FROM sites WHERE id = ${siteId}`;
    await db.end({ timeout: 5 });
  });

  async function cleanup(): Promise<void> {
    await db`DELETE FROM delivery_items WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM delivery_sources WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await db`DELETE FROM job_outbox WHERE payload->>'sourceDocumentId' IN (
      SELECT id::text FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_document_items WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await db`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  }

  beforeEach(async () => {
    parseUpdVision.mockReset();
    parseUpdVision.mockResolvedValue(parsedUt480());
    forceApplicable = false;
    throwOnDetect = false;
    throwOnOperationTrace = false;
    mocks.qtyRepairMode = 'off';
    await cleanup();
  });

  async function seedDoc(): Promise<string> {
    const bundleId = randomUUID();
    const docId = randomUUID();
    await db`INSERT INTO source_bundles (id, site_id, direction, status, bundle_hash, doc_count)
             VALUES (${bundleId}, ${siteId}, 'inbound', 'queued', ${bundleId}, 1)`;
    await db`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, bundle_id)
             VALUES (${docId}, 'upd', 'inbound', 'queued', 'manual_pdf', ${siteId}, ${bundleId})`;
    return docId;
  }

  const job = (docId: string) =>
    ({
      id: 'j-qty',
      data: { sourceDocumentId: docId, s3Key: `test/${docId}/source.jpg` },
    }) as never;

  async function itemsOf(docId: string) {
    return db<{ qty: string; line_no: number; id: string }[]>`
      SELECT id, qty, line_no FROM source_document_items
      WHERE source_document_id = ${docId} ORDER BY line_no`;
  }

  async function traceOf(docId: string) {
    const [r] = await db<{ qty_repair: Record<string, unknown> | null }[]>`
      SELECT qty_repair FROM source_documents WHERE id = ${docId}`;
    return r!.qty_repair as {
      mode: string;
      generation: number | null;
      docVersion: string | null;
      entries: Array<{
        state: string;
        row: number;
        itemId?: string;
        qtyFrom: number;
        qtyTo: number;
        blockedBy?: string;
      }>;
    } | null;
  }

  it('off: количество не тронуто, следа нет', async () => {
    mocks.qtyRepairMode = 'off';
    const docId = await seedDoc();

    await handleJob(job(docId));

    expect(Number((await itemsOf(docId))[0]!.qty)).toBe(16);
    expect(await traceOf(docId)).toBeNull();
  });

  it('shadow: количество не тронуто, кандидат записан как наблюдение', async () => {
    mocks.qtyRepairMode = 'shadow';
    const docId = await seedDoc();

    await handleJob(job(docId));

    expect(Number((await itemsOf(docId))[0]!.qty)).toBe(16);
    const trace = await traceOf(docId);
    expect(trace?.mode).toBe('shadow');
    expect(trace?.entries).toHaveLength(1);
    expect(trace!.entries[0]!.state).toBe('observed');
    expect(trace!.entries[0]!.qtyFrom).toBe(16);
    expect(trace!.entries[0]!.qtyTo).toBe(57);
    // Версия разбора обязана быть в следе: без неё откат не отличит его от
    // следа прошлого распознавания.
    expect(trace!.docVersion).toBeTruthy();
    expect(trace!.generation).toBe(0);
  });

  it('on при пустом списке пар: ничего не применяется', async () => {
    mocks.qtyRepairMode = 'on';
    const docId = await seedDoc();

    await handleJob(job(docId));

    expect(Number((await itemsOf(docId))[0]!.qty)).toBe(16);
    const trace = await traceOf(docId);
    expect(trace!.entries[0]!.state).toBe('observed');
    expect(trace!.entries[0]!.blockedBy).toBe('class_not_allowed');
  });

  it('on с разрешённым кандидатом: количество исправлено, след привязан к строке', async () => {
    mocks.qtyRepairMode = 'on';
    forceApplicable = true;
    const docId = await seedDoc();

    await handleJob(job(docId));

    const items = await itemsOf(docId);
    expect(Number(items[0]!.qty)).toBe(57);
    const trace = await traceOf(docId);
    expect(trace!.entries[0]!.state).toBe('applied');
    expect(trace!.entries[0]!.qtyFrom).toBe(16);
    // Идентификатор строки — чтобы откат нашёл именно её, а не полагался на
    // нумерацию, которая при следующем разборе может смениться.
    expect(trace!.entries[0]!.itemId).toBe(items[0]!.id);
  });

  it('сбой наблюдения не роняет разбор: документ разобран, следа нет', async () => {
    mocks.qtyRepairMode = 'shadow';
    throwOnDetect = true;
    const docId = await seedDoc();

    // Ни исключения наружу, ни потерянных позиций: наблюдение — необязательная
    // диагностика, права ронять основной путь у неё нет.
    await handleJob(job(docId));

    const items = await itemsOf(docId);
    expect(items).toHaveLength(1);
    expect(Number(items[0]!.qty)).toBe(16);
    expect(await traceOf(docId)).toBeNull();
  });

  it('проверка следа упала: правка отменена, количество прочитанное моделью', async () => {
    mocks.qtyRepairMode = 'on';
    forceApplicable = true;
    throwOnOperationTrace = true;
    const docId = await seedDoc();

    await handleJob(job(docId));

    // Не смогли убедиться, что документ свободен, — значит не применяем.
    const items = await itemsOf(docId);
    expect(Number(items[0]!.qty)).toBe(16);
    expect(await traceOf(docId)).toBeNull();
    // И сверка обязана соответствовать записанным числам.
    const [doc] = await db<{ validation: { hasMismatch: boolean } }[]>`
      SELECT validation FROM source_documents WHERE id = ${docId}`;
    expect(doc!.validation.hasMismatch).toBe(true);
  });

  it('документ уже в приёмке: правка отменяется, сверка считается по исходным', async () => {
    mocks.qtyRepairMode = 'on';
    forceApplicable = true;
    const docId = await seedDoc();

    // Первый разбор — документ ещё свободен, правка применяется.
    await handleJob(job(docId));
    expect(Number((await itemsOf(docId))[0]!.qty)).toBe(57);

    // Документ уехал в приёмку.
    const deliveryId = randomUUID();
    const [status] = await db<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'draft' LIMIT 1`;
    await db`INSERT INTO deliveries (id, site_id, status_id, arrived_at)
             VALUES (${deliveryId}, ${siteId}, ${status!.id}, now())`;
    await db`INSERT INTO delivery_sources (delivery_id, source_document_id)
             VALUES (${deliveryId}, ${docId})`;

    // Повторный разбор того же документа (recovery в том же поколении).
    await handleJob(job(docId));

    const items = await itemsOf(docId);
    expect(Number(items[0]!.qty)).toBe(16);
    const trace = await traceOf(docId);
    expect(trace!.entries[0]!.state).toBe('observed');
    expect(trace!.entries[0]!.blockedBy).toBe('operation_trace');

    // Сверка обязана соответствовать записанным числам: иначе в карточке
    // «всё сошлось», а в позициях — исходное расхождение.
    const [doc] = await db<{ validation: { hasMismatch: boolean } }[]>`
      SELECT validation FROM source_documents WHERE id = ${docId}`;
    expect(doc!.validation.hasMismatch).toBe(true);
  });
});
