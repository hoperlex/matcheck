/**
 * Правило ×1000 на накладных пакетного пути.
 *
 * Сверки у накладных нет, поэтому «8 000 000 шт кирпича» доезжала до приёмки
 * молча. Здесь проверяется запись воркера целиком: создание документа правит
 * количество и хранит прочитанное, повторный разбор только наблюдает и не
 * оставляет устаревший след «применено».
 *
 * Запуск: см. заголовок test/integration/upd-assembly.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EnvModule from '../../src/lib/env.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;
const sql = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 4 }) : null;

const envState = vi.hoisted(() => ({ qtyScale: 'on' as 'off' | 'shadow' | 'on' }));

vi.mock('../../src/lib/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return {
    ...actual,
    loadEnv: () => ({ ...actual.loadEnv(), QTY_SCALE_REPAIR: envState.qtyScale }),
  };
});
vi.mock('../../src/domain/sse/redis-bridge.js', () => ({
  publishSseEvent: vi.fn().mockResolvedValue(undefined),
}));
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
  getObject: vi.fn().mockResolvedValue(Buffer.from('jpeg-bytes')),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  presign: vi.fn().mockResolvedValue('https://s3.example/signed'),
}));
const parseWaybillBatch = vi.fn();
vi.mock('../../src/domain/edo/waybill-batch.parser.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/edo/waybill-batch.parser.js',
  );
  return { ...actual, parseWaybillBatch: (...args: unknown[]) => parseWaybillBatch(...args) };
});

const { handleJob } = await import('../../src/worker.js');

/** Ответ модели: одна ТН, кирпич прочитан как 8 000 000 шт, цены нет. */
const brickWaybill = () => ({
  parsed: {
    documents: [
      {
        form: 'tn_2116' as const,
        docNumber: 'ТН-8000',
        docDate: '2026-09-30',
        shipper: null,
        consignee: null,
        items: [
          { nameRaw: 'Кирпич керамический М150', qty: 8_000_000, unit: 'шт' },
          { nameRaw: 'Раствор кладочный', qty: 3, unit: 'м3' },
        ],
        confidence: 0.9,
      },
    ],
  },
  llmProviderId: null,
});

type TraceRow = {
  id: string;
  qty_scale: { mode: string; entries: Array<{ state: string; kind: string; row: number }> } | null;
};

suite('правило ×1000 на накладных (реальный PostgreSQL)', () => {
  const db = sql!;
  const siteId = randomUUID();

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name)
      VALUES (${siteId}, ${`QSW${Date.now() % 10000}`}, 'Накладные ×1000')`;
  });

  async function cleanup(): Promise<void> {
    await db`DELETE FROM source_document_items WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_document_attachments WHERE source_document_id IN (
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
    envState.qtyScale = 'on';
    parseWaybillBatch.mockReset().mockResolvedValue(brickWaybill());
    await cleanup();
  });

  /** Пакет с одним файлом накладной, разобранный пакетным путём. */
  async function createWaybill(): Promise<string> {
    const bundleId = randomUUID();
    const techId = randomUUID();
    await db`INSERT INTO source_bundles (id, site_id, direction, status, bundle_hash, doc_count)
             VALUES (${bundleId}, ${siteId}, 'inbound', 'queued', ${bundleId}, 1)`;
    await db`INSERT INTO source_documents
               (id, kind, direction, status, origin, site_id, bundle_id, is_technical)
             VALUES (${techId}, 'transport_waybill', 'inbound', 'queued', 'manual_pdf',
                     ${siteId}, ${bundleId}, true)`;
    await db`INSERT INTO source_document_attachments
               (source_document_id, s3_key, filename, mime_type, size_bytes)
             VALUES (${techId}, ${`test/${techId}/tn.jpg`}, 'tn.jpg', 'image/jpeg', 1000)`;
    await handleJob({ id: 'j-wb', data: { bundleId } } as never);
    const [doc] = await db<{ id: string }[]>`
      SELECT id FROM source_documents WHERE bundle_id = ${bundleId} AND is_technical = false`;
    expect(doc).toBeTruthy();
    return doc!.id;
  }

  const itemsOf = (id: string) =>
    db<{ name_raw: string; qty: string; qty_read: string | null }[]>`
      SELECT name_raw, qty, qty_read FROM source_document_items
        WHERE source_document_id = ${id} ORDER BY line_no`;

  const traceOf = async (id: string) =>
    (await db<TraceRow[]>`SELECT id, qty_scale FROM source_documents WHERE id = ${id}`)[0]!;

  /** Ручной повтор: то же, что делает маршрут /reparse. */
  async function reparse(id: string): Promise<void> {
    const [row] = await db<{ dispatch_generation: number; status: string }[]>`
      SELECT dispatch_generation, status FROM source_documents WHERE id = ${id}`;
    const generation = row!.dispatch_generation + 1;
    await db`UPDATE source_documents
                SET status = 'queued', dispatch_generation = ${generation}, queued_at = now(),
                    reparse = ${JSON.stringify({
                      state: 'queued',
                      generation,
                      at: new Date().toISOString(),
                      by: null,
                      snapshot: { status: row!.status },
                    })}::jsonb
              WHERE id = ${id}`;
    await handleJob({
      id: 'j-wb-reparse',
      data: { sourceDocumentId: id, mode: 'waybill_single', docGeneration: generation },
    } as never);
  }

  it('on: создание делит количество и хранит прочитанное', async () => {
    const id = await createWaybill();

    const items = await itemsOf(id);
    expect(items.map((i) => Number(i.qty))).toEqual([8000, 3]);
    expect(Number(items[0]!.qty_read)).toBe(8_000_000);
    // Строку, которую правило не трогало, след не помечает.
    expect(items[1]!.qty_read).toBeNull();
    const { qty_scale } = await traceOf(id);
    expect(qty_scale?.mode).toBe('on');
    expect(qty_scale?.entries).toEqual([
      expect.objectContaining({ row: 1, kind: 'unpriced_million', state: 'applied' }),
    ]);
  });

  it('shadow: числа как прочитаны, кандидат только в следе', async () => {
    envState.qtyScale = 'shadow';
    const id = await createWaybill();

    const items = await itemsOf(id);
    expect(items.map((i) => Number(i.qty))).toEqual([8_000_000, 3]);
    expect(items.every((i) => i.qty_read === null)).toBe(true);
    expect((await traceOf(id)).qty_scale?.entries[0]?.state).toBe('observed');
  });

  it('off: поведение прежнее, следа нет', async () => {
    envState.qtyScale = 'off';
    const id = await createWaybill();

    expect((await itemsOf(id)).map((i) => Number(i.qty))).toEqual([8_000_000, 3]);
    expect((await traceOf(id)).qty_scale).toBeNull();
  });

  it('повторный разбор только наблюдает и заменяет устаревший след', async () => {
    const id = await createWaybill();
    expect((await traceOf(id)).qty_scale?.entries[0]?.state).toBe('applied');

    await reparse(id);

    // Повтор у накладной, как и у УПД, машиной не правит: позиции заменены
    // ответом модели целиком, и след обязан это отражать, а не прежнюю правку.
    const items = await itemsOf(id);
    expect(items.map((i) => Number(i.qty))).toEqual([8_000_000, 3]);
    expect(items.every((i) => i.qty_read === null)).toBe(true);
    expect((await traceOf(id)).qty_scale?.entries).toEqual([
      expect.objectContaining({ row: 1, state: 'observed' }),
    ]);
  });
});
