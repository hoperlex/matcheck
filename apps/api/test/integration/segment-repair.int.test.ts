/**
 * Автоповтор распознавания сегмента при расхождении сумм.
 *
 * Юнит-тесты проверяют арбитраж как чистую функцию (segment-repair-arbiter),
 * здесь — поведение воркера целиком: когда повтор ставится, что происходит с
 * публикацией комплекта, пока он не закончил, и главное — что при любом исходе
 * документ доходит до терминального состояния, а не остаётся в работе навсегда.
 *
 * Данные — боевой УПД № 53 от 31.08.2026: в бланке три строки, модель вернула
 * две (строку на 1 043 565 ₽ потеряла, а числа третьей приписала наименованию
 * второй), при этом итог по шапке посчитан по всем трём.
 *
 * Запуск: см. заголовок test/integration/upd-assembly.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { createHash, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EnvModule from '../../src/lib/env.js';
import type * as PrefilterModule from '../../src/domain/edo/upd-page-prefilter.js';
import type * as PageRenderModule from '../../src/domain/edo/page-render.js';
import type * as SegmentExtractModule from '../../src/domain/edo/upd-segment-extract.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;
const sql = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 4 }) : null;

vi.setConfig({ testTimeout: 60_000 });

// Режим меняется от сценария к сценарию, поэтому не константа в моке, а
// изменяемая ячейка: off / shadow / on — три разных ожидаемых поведения.
const envState = vi.hoisted(() => ({ repair: 'on' as 'off' | 'shadow' | 'on' }));

vi.mock('../../src/lib/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return {
    ...actual,
    loadEnv: () => ({
      ...actual.loadEnv(),
      UPD_ASSEMBLY_V1: true,
      UPD_SEGMENT_REPAIR: envState.repair,
    }),
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
  getObject: vi.fn().mockResolvedValue(Buffer.from('fake-image-bytes')),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  presign: vi.fn().mockResolvedValue('https://s3.example/signed'),
}));

const classifyFile = vi.fn();
vi.mock('../../src/domain/edo/document-router.js', () => ({
  classifyFile: (...args: unknown[]) => classifyFile(...args),
}));

const classifyPages = vi.fn();
vi.mock('../../src/domain/edo/upd-page-prefilter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PrefilterModule>();
  return { ...actual, classifyPages: (...args: unknown[]) => classifyPages(...args) };
});

vi.mock('../../src/domain/edo/page-render.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PageRenderModule>();
  return {
    ...actual,
    renderPdf: vi.fn().mockResolvedValue([Buffer.from('page-1')]),
    imageToPng: vi.fn().mockResolvedValue(Buffer.from('png')),
    imageToVisionPage: vi.fn().mockResolvedValue(Buffer.from('png')),
    toClassifyThumb: vi.fn().mockResolvedValue(Buffer.from('thumb')),
  };
});

const extractUpdSegment = vi.fn();
vi.mock('../../src/domain/edo/upd-segment-extract.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SegmentExtractModule>();
  return { ...actual, extractUpdSegment: (...args: unknown[]) => extractUpdSegment(...args) };
});

const { handleDocumentRouterJob, handleUpdAssemblyJob, handleJob, loadSegmentRepairBaseline } =
  await import('../../src/worker.js');
const { encryptField, buildAad } = await import('../../src/domain/auth/crypto.js');

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

/** Строки бланка № 53. */
const L1 = {
  nameRaw: 'ВРУ2.1(ПОН)',
  qty: 1,
  unit: 'шт',
  price: 1007299.18,
  sum: 1228905,
  vatRate: 22,
  vatSum: 221605.82,
  rowNo: 1,
};
const L2 = {
  nameRaw: 'ВРУ2.2(ПОН)',
  qty: 1,
  unit: 'шт',
  price: 855381.15,
  sum: 1043565,
  vatRate: 22,
  vatSum: 188183.85,
  rowNo: 2,
};
const L3 = {
  nameRaw: 'ВРУ2.2(ПЭСПЗ)',
  qty: 1,
  unit: 'шт',
  price: 233440.98,
  sum: 284798,
  vatRate: 22,
  vatSum: 51357.02,
  rowNo: 3,
};
/** Как прочитала модель на первом заходе: имя второй строки, числа третьей. */
const MERGED = { ...L3, nameRaw: L2.nameRaw, rowNo: 2 };

function result(items: object[], over: Record<string, unknown> = {}) {
  return {
    parsed: {
      docNumber: '53',
      docDate: '2026-08-31',
      totalSum: 2557288,
      vatSum: 461146.69,
      itemsCount: null,
      supplier: { name: 'ООО ПЭМ-ЭНЕРГО', inn: '7743190837' },
      recipient: { name: 'ООО ТАДЖИНКСТРОЙ', inn: '7743483077' },
      items,
      confidence: 0.95,
      ...over,
    },
    llmProviderId: null as string | null,
  };
}

/** Первый разбор: две позиции, итог посчитан по трём — суммы не сходятся. */
const BASELINE = () => result([L1, MERGED]);
/** Удачный повтор: все три строки и верный итог. */
const FIXED = () => result([L1, L2, L3], { totalSum: 2557268 });

suite('автоповтор сегмента (реальный PostgreSQL)', () => {
  const siteId = randomUUID();
  const db = sql!;

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name)
      VALUES (${siteId}, ${`RPR${Date.now() % 10000}`}, 'Повтор сегмента')`;
    await db`DELETE FROM llm_provider_credentials WHERE kind = 'openrouter'`;
    await db`DELETE FROM llm_providers WHERE name = 'repair-openrouter'`;
    await db`UPDATE llm_providers SET is_default = false WHERE is_default = true`;
    await db`INSERT INTO llm_providers (name, kind, model, api_base_url, is_default)
      VALUES ('repair-openrouter', 'openrouter', 'test/model', 'https://openrouter.test/api/v1', true)`;
    const envelope = encryptField('test-key', buildAad('llm_provider_credentials', 'openrouter'));
    await db`INSERT INTO llm_provider_credentials (kind, api_base_url, api_key_encrypted)
      VALUES ('openrouter', 'https://openrouter.test/api/v1', ${JSON.stringify(envelope)})`;
  });

  async function cleanup(): Promise<void> {
    const docs = await db<{ id: string }[]>`
      SELECT id FROM source_documents WHERE site_id = ${siteId}`;
    const bundles = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE site_id = ${siteId}`;
    const segments = await db<{ id: string }[]>`
      SELECT s.id FROM bundle_segments s
      JOIN source_bundles b ON b.id = s.bundle_id WHERE b.site_id = ${siteId}`;
    const ids = [...docs.map((d) => d.id), ...bundles.map((b) => b.id)];
    if (ids.length > 0) {
      await db`DELETE FROM job_outbox
         WHERE payload->>'sourceDocumentId' = ANY(${ids}) OR payload->>'bundleId' = ANY(${ids})`;
      await db`DELETE FROM recognition_evidence_events WHERE bundle_id = ANY(${bundles.map((b) => b.id)})`;
    }
    const auditIds = [...ids, ...segments.map((s) => s.id)];
    if (auditIds.length > 0) {
      await db`DELETE FROM recognition_dispatch_events WHERE entity_id = ANY(${auditIds})`;
      await db`DELETE FROM job_outbox WHERE payload->>'segmentId' = ANY(${segments.map((s) => s.id)})`;
    }
    await db`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await db`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  }

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db`DELETE FROM llm_provider_credentials WHERE kind = 'openrouter'`;
    await db`DELETE FROM llm_providers WHERE name = 'repair-openrouter'`;
    await db`DELETE FROM sites WHERE id = ${siteId}`;
    await db.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await cleanup();
    envState.repair = 'on';
    classifyFile.mockReset().mockResolvedValue({
      detectedKind: 'upd',
      confidence: 0.95,
      needsVision: true,
      parserUsed: 'none',
      signals: ['test'],
    });
    classifyPages.mockReset().mockResolvedValue({
      classification: [
        { page: 1, type: 'upd_main', use: true },
        { page: 2, type: 'upd_continuation', use: true },
      ],
      raw: '{}',
      promptTokens: 10,
      completionTokens: 10,
    });
    extractUpdSegment.mockReset();
  });

  /** Пакет из двух листов одной УПД, доведённый до нарезки на сегменты. */
  async function assembledBundle(): Promise<{ segmentId: string; docId: string; rootId: string }> {
    const hash = createHash('sha256').update(randomUUID()).digest('hex');
    const [bundle] = await db<{ id: string }[]>`
      INSERT INTO source_bundles (bundle_hash, kind, direction, site_id, status, origin)
      VALUES (${hash}, 'mixed', 'inbound', ${siteId}, 'queued', 'manual_pdf')
      RETURNING id`;
    const bundleId = bundle!.id;
    await db`INSERT INTO ingest_events (bundle_id, channel) VALUES (${bundleId}, 'public')`;
    const [tech] = await db<{ id: string }[]>`
      INSERT INTO source_documents
        (kind, is_technical, direction, origin, status, site_id, bundle_id, queued_at)
      VALUES ('upd', true, 'inbound', 'manual_pdf', 'queued', ${siteId}, ${bundleId}, now())
      RETURNING id`;
    for (const [idx, name] of ['лист1.jpg', 'лист2.jpg'].entries()) {
      const key = `upload/${bundleId}/${name}`;
      await db`INSERT INTO source_document_attachments
          (source_document_id, s3_key, filename, mime_type, size_bytes, role)
        VALUES (${tech!.id}, ${key}, ${name}, 'image/jpeg', 1000, 'original')`;
      await db`INSERT INTO bundle_import_items
          (bundle_id, source_filename, input_s3_key, mime_type, size_bytes,
           upload_generation, input_order, processing_mode, status)
        VALUES (${bundleId}, ${name}, ${key}, 'image/jpeg', 1000, 0, ${idx}, 'auto', 'accepted')`;
    }
    await handleDocumentRouterJob(bundleId, 0, log);
    const [sub] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundleId} LIMIT 1`;
    if (sub) await handleUpdAssemblyJob(sub.id, 0, 0, log);
    const [seg] = await db<{ id: string; source_document_id: string; bundle_id: string }[]>`
      SELECT s.id, s.source_document_id, s.bundle_id FROM bundle_segments s
      JOIN source_bundles b ON b.id = s.bundle_id
      WHERE b.site_id = ${siteId} ORDER BY s.segment_index LIMIT 1`;
    return { segmentId: seg!.id, docId: seg!.source_document_id!, rootId: seg!.bundle_id };
  }

  const docOf = async (id: string) =>
    (
      await db<
        {
          status: string;
          parse_error_code: string | null;
          total_sum: string | null;
          second_pass: Record<string, unknown> | null;
          is_technical: boolean;
        }[]
      >`SELECT status, parse_error_code, total_sum, second_pass, is_technical
          FROM source_documents WHERE id = ${id}`
    )[0]!;

  const itemsOf = async (id: string) =>
    db<{ name_raw: string; sum: string | null }[]>`
      SELECT name_raw, sum FROM source_document_items
        WHERE source_document_id = ${id} ORDER BY line_no`;

  const repairJobsOf = async (segmentId: string) =>
    db<{ dedupe_key: string }[]>`
      SELECT dedupe_key FROM job_outbox
        WHERE payload->>'segmentId' = ${segmentId} AND payload->>'pass' = 'segment_repair'`;

  /** Прогоняет первичный разбор сегмента. */
  const runFirstPass = (docId: string, segmentId: string) =>
    handleJob({
      id: 'seg-0',
      data: { sourceDocumentId: docId, segmentId, generation: 0 },
    } as never);

  /** Прогоняет поставленный повтор. */
  const runRepair = (docId: string, segmentId: string) =>
    handleJob({
      id: 'seg-0-repair',
      data: {
        sourceDocumentId: docId,
        segmentId,
        generation: 0,
        docGeneration: 0,
        pass: 'segment_repair',
      },
    } as never);

  it('расхождение сумм ставит повтор, а комплект ждёт его завершения', async () => {
    extractUpdSegment.mockResolvedValue(BASELINE());
    const { segmentId, docId } = await assembledBundle();

    await runFirstPass(docId, segmentId);

    expect(await repairJobsOf(segmentId)).toHaveLength(1);
    const doc = await docOf(docId);
    // Документ остаётся в работе — иначе комплект опубликуется до повтора.
    expect(doc.status).toBe('queued');
    expect(doc.is_technical).toBe(true);
    expect((doc.second_pass as { mode?: string })?.mode).toBe('segment_repair');
  });

  it('повтор вернул все три строки — разбор заменяется, комплект публикуется', async () => {
    extractUpdSegment.mockResolvedValueOnce(BASELINE()).mockResolvedValueOnce(FIXED());
    const { segmentId, docId } = await assembledBundle();

    await runFirstPass(docId, segmentId);
    await runRepair(docId, segmentId);

    const items = await itemsOf(docId);
    expect(items.map((i) => i.name_raw)).toEqual([L1.nameRaw, L2.nameRaw, L3.nameRaw]);
    expect(items.map((i) => Number(i.sum))).toEqual([1228905, 1043565, 284798]);

    const doc = await docOf(docId);
    expect(Number(doc.total_sum)).toBe(2557268);
    // Суммы сошлись — расхождения больше нет.
    expect(doc.parse_error_code).toBeNull();
    expect(doc.status).not.toBe('queued');
    expect((doc.second_pass as { outcome?: string })?.outcome).toBe('replaced');
    // Комплект опубликован: технический флаг снят.
    expect(doc.is_technical).toBe(false);
  });

  it('повтор подогнал итог под те же две строки — разбор не меняется', async () => {
    // Кандидат «чинит» расхождение, переписав итог: валидация станет чистой, а
    // материалов по-прежнему два из трёх.
    extractUpdSegment
      .mockResolvedValueOnce(BASELINE())
      .mockResolvedValueOnce(result([L1, MERGED], { totalSum: 1513703, vatSum: 272962.84 }));
    const { segmentId, docId } = await assembledBundle();

    await runFirstPass(docId, segmentId);
    await runRepair(docId, segmentId);

    const doc = await docOf(docId);
    expect(Number(doc.total_sum)).toBe(2557288);
    expect(doc.parse_error_code).toBe('validation_mismatch');
    expect((doc.second_pass as { outcome?: string })?.outcome).toBe('kept_baseline');
    // И всё равно доведён до терминала — комплект не завис.
    expect(doc.status).not.toBe('queued');
    expect(doc.is_technical).toBe(false);
  });

  it('shadow: повтор считает, но распознанные данные не трогает', async () => {
    envState.repair = 'shadow';
    extractUpdSegment.mockResolvedValueOnce(BASELINE()).mockResolvedValueOnce(FIXED());
    const { segmentId, docId } = await assembledBundle();

    await runFirstPass(docId, segmentId);
    await runRepair(docId, segmentId);

    const items = await itemsOf(docId);
    expect(items).toHaveLength(2);
    const doc = await docOf(docId);
    expect(Number(doc.total_sum)).toBe(2557288);
    // Решение записано, чтобы его можно было разобрать до включения `on`.
    expect((doc.second_pass as { outcome?: string })?.outcome).toBe('shadow_would_replace');
    expect(doc.status).not.toBe('queued');
  });

  it('off: поведение прежнее, задание не ставится', async () => {
    envState.repair = 'off';
    extractUpdSegment.mockResolvedValue(BASELINE());
    const { segmentId, docId } = await assembledBundle();

    await runFirstPass(docId, segmentId);

    expect(await repairJobsOf(segmentId)).toHaveLength(0);
    const doc = await docOf(docId);
    expect(doc.parse_error_code).toBe('validation_mismatch');
    expect(doc.status).not.toBe('queued');
    expect(doc.second_pass).toBeNull();
  });

  it('третьего прохода не бывает: повтор с расхождением нового задания не ставит', async () => {
    // Повтор вернул три строки, но снова ошибся в итоге на 20 ₽ — расхождение
    // осталось. Кандидат принимается (он лучше), но следующего повтора нет.
    extractUpdSegment.mockResolvedValueOnce(BASELINE()).mockResolvedValueOnce(result([L1, L2, L3]));
    const { segmentId, docId } = await assembledBundle();

    await runFirstPass(docId, segmentId);
    await runRepair(docId, segmentId);

    expect(await repairJobsOf(segmentId)).toHaveLength(1);
    const doc = await docOf(docId);
    expect(await itemsOf(docId)).toHaveLength(3);
    // Расхождение в 20 ₽ осталось — и это честно показано менеджеру.
    expect(doc.parse_error_code).toBe('validation_mismatch');
    expect(doc.status).not.toBe('queued');
  });

  it('снимок baseline несёт rowNo, «Всего наименований» и поставщика', async () => {
    // Через loadParsedBaseline эти поля терялись (itemsCount и supplier он
    // жёстко обнуляет, rowNo не переносит вовсе), и арбитраж сравнивал бы
    // кандидата с искусственно обеднённым снимком: покрытие items_count и
    // items_sequence у baseline оказалось бы нулевым.
    extractUpdSegment.mockResolvedValue(result([L1, MERGED], { itemsCount: 3 }));
    const { segmentId, docId } = await assembledBundle();

    await runFirstPass(docId, segmentId);

    const snapshot = await loadSegmentRepairBaseline(docId);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.parsed.items.map((i) => i.rowNo)).toEqual([1, 2]);
    expect(snapshot!.parsed.itemsCount).toBe(3);
    expect(snapshot!.parsed.supplier?.name).toContain('ПЭМ-ЭНЕРГО');
    // Восстанавливать документ надо к терминальному статусу, а не к `queued`,
    // в котором он лежит прямо сейчас, ожидая повтора.
    expect(snapshot!.restore.status).not.toBe('queued');
  });

  it('«Всего наименований» не сошлось с числом строк — повтор тоже ставится', async () => {
    // Суммы при этом сходятся: расхождение видит только items_count, который
    // hasMoneyMismatch исключает. Ради этого класса триггер и построен на
    // hasMismatch.
    extractUpdSegment.mockResolvedValue(result([L1, L2, L3], { totalSum: 2557268, itemsCount: 4 }));
    const { segmentId, docId } = await assembledBundle();

    await runFirstPass(docId, segmentId);

    expect(await repairJobsOf(segmentId)).toHaveLength(1);
    expect((await docOf(docId)).status).toBe('queued');
  });

  it('отклонённый кандидат не заводит материалы в справочнике', async () => {
    // Арбитраж стоит ДО findOrCreateMaterial намеренно: иначе каждая неудачная
    // попытка засоряла бы справочник выдуманными наименованиями.
    extractUpdSegment.mockResolvedValueOnce(BASELINE()).mockResolvedValueOnce(
      result([
        { ...L1, nameRaw: 'ВЫДУМАННЫЙ МАТЕРИАЛ ПОВТОРА' },
        { ...MERGED, nameRaw: 'ВЫДУМАННЫЙ МАТЕРИАЛ ПОВТОРА 2' },
      ]),
    );
    const { segmentId, docId } = await assembledBundle();

    await runFirstPass(docId, segmentId);
    await runRepair(docId, segmentId);

    const [{ count }] = await db<{ count: string }[]>`
      SELECT count(*)::text AS count FROM materials WHERE name LIKE 'ВЫДУМАННЫЙ МАТЕРИАЛ%'`;
    expect(count).toBe('0');
    expect((await docOf(docId)).status).not.toBe('queued');
  });

  it('повтор упал — сохранён первый разбор, документ не parse_failed', async () => {
    extractUpdSegment
      .mockResolvedValueOnce(BASELINE())
      .mockRejectedValueOnce(new Error('vision недоступен'));
    const { segmentId, docId } = await assembledBundle();

    await runFirstPass(docId, segmentId);
    await expect(runRepair(docId, segmentId)).rejects.toThrow();

    // Падение задания разбирает обработчик 'failed' очереди; здесь проверяем
    // главное: позиции первого разбора на месте, они не стёрты повтором.
    expect(await itemsOf(docId)).toHaveLength(2);
    const doc = await docOf(docId);
    expect(Number(doc.total_sum)).toBe(2557288);
  });
});
