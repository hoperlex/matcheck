/**
 * Промпт ТОРГ-12 для поставщиков из списка (TORG12_PROMPT) — в воркере целиком.
 *
 * Обычный разбор (активный промпт) отдаёт по накладной РОКВУЛ то, что видно
 * на бою: номер договора вместо номера документа и количество одного места.
 * Второй разбор версией с разделом ТОРГ-12 возвращает номер документа и графы
 * 7/8, а правило TORG12_QTY считает количество. Проверяется и обратное: чужой
 * поставщик второго вызова не получает ни в каком режиме.
 *
 * Запуск: см. заголовок test/integration/qty-repair.int.test.ts.
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
const flags = vi.hoisted(() => ({
  prompt: 'off' as 'off' | 'shadow' | 'on',
  inns: '5012093506',
}));
vi.mock('../../src/lib/env.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/lib/env.js');
  const load = actual.loadEnv as () => Record<string, unknown>;
  return {
    ...actual,
    loadEnv: () => ({
      ...load(),
      TORG12_QTY: 'on',
      TORG12_PROMPT: flags.prompt,
      TORG12_PROMPT_SUPPLIER_INNS: flags.inns,
      TORG12_PROMPT_NAME: 'default v18',
    }),
  };
});
vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  getObject: vi.fn().mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a])),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  presign: vi.fn().mockResolvedValue('https://s3.example/signed'),
}));
// Версия промпта по имени — без зависимости от содержимого тестовой БД.
vi.mock('../../src/domain/prompts/registry.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/prompts/registry.js',
  );
  return {
    ...actual,
    loadPromptByName: vi.fn(async (_kind: string, name: string) => ({
      id: 'p-v18',
      content: name,
    })),
  };
});

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

const { handleJob } = await import('../../src/worker.js');

const ROCKWOOL = { inn: '5012093506', kpp: null, name: 'ООО "РОКВУЛ"' };

/** Что даёт активный промпт: номер и дата договора, одно место вместо 13. */
function activeResult(supplier = ROCKWOOL) {
  return {
    parsed: {
      docNumber: 'MO/25347/2017',
      docDate: '2017-06-01',
      totalSum: null,
      vatSum: null,
      supplier,
      recipient: { inn: '7714529160', kpp: null, name: 'ООО "ТЕПЛОКРОВЛЯ"' },
      consignee: { inn: '7736255508', kpp: null, name: 'ООО "СУ-10"' },
      items: [
        {
          rowNo: 1,
          nameRaw: 'ВЕНТИ БАТТС Н 1000х600х100 (20 ПАЧ/ПАЛ) Плита минераловатная',
          qty: 60,
          unit: 'м2',
          price: null,
          sum: null,
          vatRate: null,
          vatSum: null,
        },
      ],
      confidence: 0.85,
    },
    llmProviderId: null,
  };
}

/** Что даёт версия с разделом ТОРГ-12: номер документа и графы 7/8. */
function torg12Result() {
  return {
    parsed: {
      ...activeResult().parsed,
      docNumber: '10626044499',
      docDate: '2026-09-21',
      items: [
        {
          rowNo: 1,
          nameRaw: 'ВЕНТИ БАТТС Н 1000х600х100 (20 ПАЧ/ПАЛ) Плита минераловатная',
          qty: null,
          qtyPerPlace: 60,
          places: 13,
          massNetKg: 2886,
          unit: 'м2',
          price: null,
          sum: null,
          vatRate: null,
          vatSum: null,
        },
      ],
      confidence: 0.9,
    },
    llmProviderId: null,
  };
}

/** Второй вызов узнаётся по promptOverride — его передаёт только правило ТОРГ-12. */
function byPrompt(active = activeResult(), torg12 = torg12Result()) {
  parseUpdVision.mockImplementation(async (_input: unknown, ctx: { promptOverride?: unknown }) =>
    ctx?.promptOverride ? torg12 : active,
  );
}

const torg12Calls = () =>
  parseUpdVision.mock.calls.filter((c) => (c[1] as { promptOverride?: unknown })?.promptOverride)
    .length;

suite('промпт ТОРГ-12 для поставщиков из списка (реальный PostgreSQL)', () => {
  const db = sql!;
  const siteId = randomUUID();

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`TP${Date.now() % 10000}`}, 'Torg12 prompt')`;
  });

  async function cleanup(): Promise<void> {
    await db`DELETE FROM job_outbox WHERE payload->>'sourceDocumentId' IN (
      SELECT id::text FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM recognition_evidence_events WHERE bundle_id IN (
      SELECT id FROM source_bundles WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_document_items WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
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
    parseUpdVision.mockReset();
    byPrompt();
    flags.prompt = 'off';
    flags.inns = '5012093506';
    await cleanup();
  });

  async function seedDoc(): Promise<{ docId: string; bundleId: string }> {
    const bundleId = randomUUID();
    const docId = randomUUID();
    await db`INSERT INTO source_bundles (id, site_id, direction, status, bundle_hash, doc_count)
             VALUES (${bundleId}, ${siteId}, 'inbound', 'queued', ${bundleId}, 1)`;
    await db`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, bundle_id)
             VALUES (${docId}, 'upd', 'inbound', 'queued', 'manual_pdf', ${siteId}, ${bundleId})`;
    return { docId, bundleId };
  }

  const job = (docId: string) =>
    ({
      id: 'j-torg12-prompt',
      data: { sourceDocumentId: docId, s3Key: `test/${docId}/source.jpg` },
    }) as never;

  async function docOf(docId: string) {
    const [d] = await db<{ doc_number: string | null; status: string }[]>`
      SELECT doc_number, status FROM source_documents WHERE id = ${docId}`;
    const items = await db<{ qty: string }[]>`
      SELECT qty FROM source_document_items WHERE source_document_id = ${docId} ORDER BY line_no`;
    return { ...d!, qty: items.map((i) => Number(i.qty)) };
  }

  const evidenceOf = (bundleId: string) => db<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM recognition_evidence_events
     WHERE bundle_id = ${bundleId} AND evidence_type = 'torg12_prompt'`;

  it('off — второго разбора нет, документ как сегодня', async () => {
    const { docId, bundleId } = await seedDoc();
    await handleJob(job(docId));

    expect(parseUpdVision).toHaveBeenCalledTimes(1);
    expect(torg12Calls()).toBe(0);
    expect(await docOf(docId)).toMatchObject({ doc_number: 'MO/25347/2017', qty: [60] });
    expect(await evidenceOf(bundleId)).toHaveLength(0);
  });

  it('shadow — второй разбор и след, документ с прежним результатом', async () => {
    flags.prompt = 'shadow';
    const { docId, bundleId } = await seedDoc();
    await handleJob(job(docId));

    expect(torg12Calls()).toBe(1);
    expect(await docOf(docId)).toMatchObject({ doc_number: 'MO/25347/2017', qty: [60] });
    const [ev] = await evidenceOf(bundleId);
    expect(ev?.payload).toMatchObject({
      mode: 'shadow',
      applied: false,
      promptName: 'default v18',
      base: { docNumber: 'MO/25347/2017' },
      torg12: { docNumber: '10626044499', rows: [{ qtyPerPlace: 60, places: 13 }] },
    });
  });

  it('on — номер документа и количество за всю поставку (60 × 13)', async () => {
    flags.prompt = 'on';
    const { docId, bundleId } = await seedDoc();
    await handleJob(job(docId));

    expect(torg12Calls()).toBe(1);
    expect(await docOf(docId)).toMatchObject({ doc_number: '10626044499', qty: [780] });
    const [ev] = await evidenceOf(bundleId);
    expect(ev?.payload).toMatchObject({ mode: 'on', applied: true });
  });

  it('чужой поставщик в режиме on — второго разбора нет', async () => {
    flags.prompt = 'on';
    byPrompt(activeResult({ inn: '7743429410', kpp: null, name: 'ООО "Поставщик"' }));
    const { docId, bundleId } = await seedDoc();
    await handleJob(job(docId));

    expect(parseUpdVision).toHaveBeenCalledTimes(1);
    expect(await docOf(docId)).toMatchObject({ doc_number: 'MO/25347/2017', qty: [60] });
    expect(await evidenceOf(bundleId)).toHaveLength(0);
  });

  it('пустой список ИНН в режиме on — второго разбора нет', async () => {
    flags.prompt = 'on';
    flags.inns = '';
    const { docId } = await seedDoc();
    await handleJob(job(docId));

    expect(parseUpdVision).toHaveBeenCalledTimes(1);
  });

  it('сбой второго разбора — документ с результатом обычного', async () => {
    flags.prompt = 'on';
    parseUpdVision.mockImplementation(
      async (_input: unknown, ctx: { promptOverride?: unknown }) => {
        if (ctx?.promptOverride) throw new Error('модель недоступна');
        return activeResult();
      },
    );
    const { docId } = await seedDoc();
    await handleJob(job(docId));

    expect(await docOf(docId)).toMatchObject({ doc_number: 'MO/25347/2017', qty: [60] });
  });
});
