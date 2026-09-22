/**
 * Количество по графам ТОРГ-12 в воркере: режимы рубильника и запреты.
 *
 * Юнит-тесты (test/torg12-qty.test.ts) проверяют само правило на числах, здесь
 * — поведение воркера целиком: меняются ли позиции в БД, что попадает в
 * служебный след и отменяется ли правка, когда документ уже уехал в приёмку.
 *
 * Числа взяты с боевой накладной 1002004449 от 21.09.2026 (ООО «РОКВУЛ»):
 * 13 мест по 60 м², масса нетто 2886 кг, денежных граф в бланке нет. Именно
 * масса приехала в количество и в цену, когда документ разбирали как УПД.
 *
 * Запуск: см. заголовок test/integration/qty-repair.int.test.ts.
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
// loadEnv кэширует разбор process.env при первом вызове, поэтому менять
// переменную между тестами бесполезно — подменяем сам режим.
const mocks = vi.hoisted(() => ({ mode: 'off' as 'off' | 'shadow' | 'on' }));
vi.mock('../../src/lib/env.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/lib/env.js');
  const load = actual.loadEnv as () => Record<string, unknown>;
  return { ...actual, loadEnv: () => ({ ...load(), TORG12_QTY: mocks.mode }) };
});
// JPEG-сигнатура: воркер обязан пойти vision-путём, иначе правило под запрет
// по parseMode.
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

// Сбой наблюдения: необязательная диагностика не имеет права уронить разбор.
let throwOnDetect = false;
vi.mock('../../src/domain/edo/torg12-qty.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/edo/torg12-qty.js',
  );
  const detect = actual.detectTorg12Qty as (...a: unknown[]) => unknown[];
  return {
    ...actual,
    detectTorg12Qty: (...args: unknown[]) => {
      if (throwOnDetect) throw new Error('torg12 qty detect boom');
      return detect(...args);
    },
  };
});

const { handleJob } = await import('../../src/worker.js');

/** Товарная накладная ТОРГ-12 без цен: в qty приехала масса нетто. */
function parsedTorg12() {
  return {
    parsed: {
      docNumber: 'TORG12-TEST',
      docDate: '2026-09-21',
      totalSum: null,
      vatSum: null,
      itemsCount: 1,
      supplier: { inn: '5012093506', kpp: null, name: 'ООО «РОКВУЛ»' },
      recipient: { inn: '7714529160', kpp: null, name: 'ООО «ТЕПЛОКРОВЛЯ»' },
      consignee: null,
      items: [
        {
          rowNo: 1,
          nameRaw: 'ВЕНТИ БАТТС Н 1000х600х100 (20 ПАЧ/ПАЛ) Плита минераловатная',
          qty: 2886,
          unit: 'м2',
          price: null,
          sum: null,
          vatRate: null,
          vatSum: null,
          qtyPerPlace: 60,
          places: 13,
          massNetKg: 2886,
        },
      ],
      confidence: 0.9,
    },
    textLength: 100,
    llmProviderId: null,
  };
}

suite('количество по графам ТОРГ-12 в воркере (реальный PostgreSQL)', () => {
  const db = sql!;
  const siteId = randomUUID();

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`TG${Date.now() % 10000}`}, 'Torg12 qty')`;
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
    parseUpdVision.mockResolvedValue(parsedTorg12());
    throwOnDetect = false;
    mocks.mode = 'off';
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
    ({ id: 'j-torg12', data: { sourceDocumentId: docId, s3Key: `test/${docId}/source.jpg` } }) as never;

  async function itemsOf(docId: string) {
    return db<{ qty: string; line_no: number; id: string; price: string | null }[]>`
      SELECT id, qty, line_no, price FROM source_document_items
      WHERE source_document_id = ${docId} ORDER BY line_no`;
  }

  async function traceOf(docId: string) {
    const [r] = await db<{ torg12_qty: Record<string, unknown> | null }[]>`
      SELECT torg12_qty FROM source_documents WHERE id = ${docId}`;
    return r!.torg12_qty as {
      mode: string;
      generation: number | null;
      docVersion: string | null;
      entries: Array<{
        state: string;
        row: number;
        itemId?: string;
        kind: string;
        qtyFrom: number | null;
        qtyTo: number;
        blockedBy?: string;
      }>;
    } | null;
  }

  it('off: количество не тронуто, следа нет', async () => {
    mocks.mode = 'off';
    const docId = await seedDoc();

    await handleJob(job(docId));

    expect(Number((await itemsOf(docId))[0]!.qty)).toBe(2886);
    expect(await traceOf(docId)).toBeNull();
  });

  it('shadow: количество не тронуто, кандидат записан как наблюдение', async () => {
    mocks.mode = 'shadow';
    const docId = await seedDoc();

    await handleJob(job(docId));

    expect(Number((await itemsOf(docId))[0]!.qty)).toBe(2886);
    const trace = await traceOf(docId);
    expect(trace?.mode).toBe('shadow');
    expect(trace?.entries).toHaveLength(1);
    expect(trace!.entries[0]).toMatchObject({
      state: 'observed',
      kind: 'mass_as_qty',
      qtyFrom: 2886,
      qtyTo: 780,
    });
    expect(trace!.docVersion).toBeTruthy();
    expect(trace!.generation).toBe(0);
  });

  it('on: количество пересчитано по графам, след привязан к строке', async () => {
    mocks.mode = 'on';
    const docId = await seedDoc();

    await handleJob(job(docId));

    const items = await itemsOf(docId);
    expect(Number(items[0]!.qty)).toBe(780);
    // Денежных граф в бланке нет — и после правки их не появляется: масса в
    // цену не переезжает ни при каком режиме.
    expect(items[0]!.price == null || Number(items[0]!.price) === 0).toBe(true);
    const trace = await traceOf(docId);
    expect(trace!.entries[0]!.state).toBe('applied');
    expect(trace!.entries[0]!.itemId).toBe(items[0]!.id);
  });

  it('итог накладной без цен не синтезируется из массы', async () => {
    mocks.mode = 'on';
    const docId = await seedDoc();

    await handleJob(job(docId));

    const [doc] = await db<{ total_sum: string | null; status: string }[]>`
      SELECT total_sum, status FROM source_documents WHERE id = ${docId}`;
    expect(doc!.total_sum).toBeNull();
  });

  it('обычная УПД без граф ТОРГ-12 правилом не затрагивается', async () => {
    mocks.mode = 'on';
    parseUpdVision.mockResolvedValue({
      parsed: {
        docNumber: 'UPD-PLAIN',
        docDate: '2026-09-21',
        totalSum: 2196,
        vatSum: 396,
        itemsCount: 1,
        supplier: { inn: '5012093506', kpp: null, name: 'ООО «РОКВУЛ»' },
        recipient: { inn: '7714529160', kpp: null, name: 'ООО «ТЕПЛОКРОВЛЯ»' },
        consignee: null,
        items: [
          {
            rowNo: 1,
            nameRaw: 'Труба стальная',
            qty: 18,
            unit: 'м',
            price: 100,
            sum: 2196,
            vatRate: 22,
            vatSum: 396,
          },
        ],
        confidence: 0.95,
      },
      textLength: 100,
      llmProviderId: null,
    });
    const docId = await seedDoc();

    await handleJob(job(docId));

    expect(Number((await itemsOf(docId))[0]!.qty)).toBe(18);
    expect(await traceOf(docId)).toBeNull();
  });

  it('сбой наблюдения не роняет разбор: документ разобран, следа нет', async () => {
    mocks.mode = 'shadow';
    throwOnDetect = true;
    const docId = await seedDoc();

    await handleJob(job(docId));

    const items = await itemsOf(docId);
    expect(items).toHaveLength(1);
    expect(Number(items[0]!.qty)).toBe(2886);
    expect(await traceOf(docId)).toBeNull();
  });

  it('документ уже в приёмке: правка отменяется, в позициях прочитанное моделью', async () => {
    mocks.mode = 'on';
    const docId = await seedDoc();

    // Первый разбор — документ свободен, правка применяется.
    await handleJob(job(docId));
    expect(Number((await itemsOf(docId))[0]!.qty)).toBe(780);

    const deliveryId = randomUUID();
    const [status] = await db<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'draft' LIMIT 1`;
    await db`INSERT INTO deliveries (id, site_id, status_id, arrived_at)
             VALUES (${deliveryId}, ${siteId}, ${status!.id}, now())`;
    await db`INSERT INTO delivery_sources (delivery_id, source_document_id)
             VALUES (${deliveryId}, ${docId})`;

    await handleJob(job(docId));

    expect(Number((await itemsOf(docId))[0]!.qty)).toBe(2886);
    const trace = await traceOf(docId);
    expect(trace!.entries[0]!.state).toBe('observed');
    expect(trace!.entries[0]!.blockedBy).toBe('operation_trace');
  });
});
