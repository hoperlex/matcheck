/**
 * Перепроверка ТОРГ-12 в роутере и сборке (TORG12_RECHECK), реальный PostgreSQL.
 *
 * Боевой случай: товарная накладная РОКВУЛ на двух листах, загруженных двумя
 * фото. Сегодня лист со строками классификатор файла называет М-15 и уводит
 * отдельным документом, а лист с шапкой в сборке становится «ТН» — сборка
 * откатывается, и шапка разбирается без строк.
 *
 * Здесь проверяется не только «on склеивает», но прежде всего обратное:
 *   * off — ни одного второго вызова, всё как сегодня;
 *   * shadow — второй вызов и след, но маршрут, нарезка и документы те же,
 *     что при off;
 *   * on — меняется только ТОРГ-12; УПД с настоящей ТН и обычный пакет УПД
 *     идут прежним путём.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
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

const flags = vi.hoisted(() => ({ recheck: 'off' as 'off' | 'shadow' | 'on' }));

vi.mock('../../src/lib/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return {
    ...actual,
    loadEnv: () => ({
      ...actual.loadEnv(),
      UPD_ASSEMBLY_V1: true,
      UPD_ASSEMBLY_COPY_DEDUP_V1: true,
      UPD_ASSEMBLY_SPLIT_BY_DOC_NUMBER: 'off',
      UPD_ASSEMBLY_REORDER_V1: false,
      PAGE_CLASSIFY_TORG12: false,
      ROUTER_CLASSIFY_TORG12: false,
      TORG12_RECHECK: flags.recheck,
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
// Байты файла — его ключ: так подменённый классификатор файла отличает лист
// с шапкой от листа со строками.
vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  getObject: vi.fn(async (key: string) => Buffer.from(key)),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  presign: vi.fn().mockResolvedValue('https://s3.example/signed'),
}));

const classifyFile = vi.fn();
vi.mock('../../src/domain/edo/document-router.js', () => ({
  classifyFile: (...args: unknown[]) => classifyFile(...args),
}));

const classifyImageKind = vi.fn();
vi.mock('../../src/domain/edo/vision-classifier.js', () => ({
  classifyImageKind: (...args: unknown[]) => classifyImageKind(...args),
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

const { handleDocumentRouterJob, handleUpdAssemblyJob, handleJob } =
  await import('../../src/worker.js');
const { PAGE_CLASSIFY_TORG12_PROMPT } = await import('../../src/domain/edo/upd-page-prefilter.js');
const { encryptField, buildAad } = await import('../../src/domain/auth/crypto.js');

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

type PageType = 'upd_main' | 'upd_continuation' | 'transport_waybill' | 'certificate' | 'other';

suite('перепроверка ТОРГ-12 (реальный PostgreSQL)', () => {
  const siteId = randomUUID();
  const db = sql!;

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name)
      VALUES (${siteId}, ${`T12${Date.now() % 10000}`}, 'Перепроверка ТОРГ-12')`;
    await db`DELETE FROM llm_provider_credentials WHERE kind = 'openrouter'`;
    await db`DELETE FROM llm_providers WHERE name = 'test-openrouter'`;
    await db`UPDATE llm_providers SET is_default = false WHERE is_default = true`;
    await db`INSERT INTO llm_providers (name, kind, model, api_base_url, is_default)
      VALUES ('test-openrouter', 'openrouter', 'test/model', 'https://openrouter.test/api/v1', true)`;
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
      JOIN source_bundles b ON b.id = s.bundle_id
      WHERE b.site_id = ${siteId}`;
    const ids = [...docs.map((d) => d.id), ...bundles.map((b) => b.id)];
    const auditIds = [...ids, ...segments.map((s) => s.id)];
    if (ids.length > 0) {
      await db`DELETE FROM job_outbox
         WHERE payload->>'sourceDocumentId' = ANY(${ids})
            OR payload->>'bundleId' = ANY(${ids})`;
      await db`DELETE FROM recognition_evidence_events WHERE bundle_id = ANY(${bundles.map((b) => b.id)})`;
    }
    if (auditIds.length > 0) {
      await db`DELETE FROM recognition_dispatch_events WHERE entity_id = ANY(${auditIds})`;
    }
    await db`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await db`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  }

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db`DELETE FROM llm_provider_credentials WHERE kind = 'openrouter'`;
    await db`DELETE FROM llm_providers WHERE name = 'test-openrouter'`;
    await db`DELETE FROM sites WHERE id = ${siteId}`;
    await db.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await cleanup();
    flags.recheck = 'off';
    // По умолчанию файл уже опознан как УПД: проверяется только сборка.
    classifyFile.mockReset().mockResolvedValue({
      detectedKind: 'upd',
      confidence: 0.95,
      needsVision: true,
      parserUsed: 'none',
      signals: ['test'],
    });
    classifyImageKind.mockReset();
    classifyPages.mockReset();
    extractUpdSegment.mockReset().mockResolvedValue(updResult('10626044499'));
  });

  async function publicBundle(files: string[]): Promise<string> {
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
    for (const [idx, name] of files.entries()) {
      const key = `upload/${bundleId}/${name}`;
      await db`INSERT INTO source_document_attachments
          (source_document_id, s3_key, filename, mime_type, size_bytes, role)
        VALUES (${tech!.id}, ${key}, ${name}, 'image/jpeg', 1000, 'original')`;
      await db`INSERT INTO bundle_import_items
          (bundle_id, source_filename, input_s3_key, mime_type, size_bytes,
           upload_generation, input_order, processing_mode, status)
        VALUES (${bundleId}, ${name}, ${key}, 'image/jpeg', 1000, 0, ${idx}, 'auto', 'accepted')`;
    }
    return bundleId;
  }

  function answer(types: PageType[]) {
    return {
      classification: types.map((type, i) => ({
        page: i + 1,
        type,
        use: type !== 'certificate' && type !== 'transport_waybill',
      })),
      raw: '{}',
      promptTokens: 10,
      completionTokens: 10,
      finishReason: 'stop',
    };
  }

  /** Основной вызов отвечает `base`, вопрос с текстом ТОРГ-12 — `torg12`. */
  function pages(base: PageType[], torg12: PageType[]): void {
    classifyPages.mockImplementation(async (args: { prompt?: string }) =>
      answer(args.prompt === PAGE_CLASSIFY_TORG12_PROMPT ? torg12 : base),
    );
  }

  const torg12Calls = () =>
    classifyPages.mock.calls.filter(
      (c) => (c[0] as { prompt?: string }).prompt === PAGE_CLASSIFY_TORG12_PROMPT,
    ).length;

  function updResult(docNumber: string) {
    return {
      parsed: {
        docNumber,
        docDate: '2026-09-21',
        totalSum: null,
        vatSum: null,
        supplier: { name: 'ООО "РОКВУЛ"', inn: '5012093506' },
        recipient: { name: 'ООО "ТЕПЛОКРОВЛЯ"', inn: '7714529160' },
        items: [{ nameRaw: 'ВЕНТИ БАТТС Н 1000х600х100', qty: 780, unit: 'м2', price: null, sum: null }],
        confidence: 0.9,
      },
      llmProviderId: null as string | null,
    };
  }

  const realDocs = () => db<{ id: string; kind: string; status: string; doc_number: string | null }[]>`
    SELECT id, kind, status, doc_number FROM source_documents
     WHERE site_id = ${siteId} AND is_technical = false ORDER BY created_at`;

  const segmentsOf = (bundleId: string) => db<
    { id: string; segment_index: number; source_document_id: string | null; page_refs: unknown }[]
  >`SELECT id, segment_index, source_document_id, page_refs FROM bundle_segments
      WHERE bundle_id = ${bundleId} ORDER BY segment_index`;

  const evidenceOf = (bundleId: string) => db<
    { evidence_type: string; payload: Record<string, unknown> }[]
  >`SELECT evidence_type, payload FROM recognition_evidence_events
      WHERE bundle_id = ${bundleId} ORDER BY created_at`;

  async function runAssembly(bundleId: string): Promise<void> {
    await handleDocumentRouterJob(bundleId, log);
    const [sub] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundleId}`;
    if (!sub) return;
    await handleUpdAssemblyJob(sub.id, 0, log);
    for (const seg of await segmentsOf(bundleId)) {
      if (!seg.source_document_id) continue;
      await handleJob({
        id: `seg-${seg.segment_index}`,
        data: { sourceDocumentId: seg.source_document_id, segmentId: seg.id, generation: 0 },
      } as never);
    }
  }

  describe('сборка: шапка ТОРГ-12 названа «ТН»', () => {
    it('off — второго вызова нет, сборка откатывается, как сегодня', async () => {
      const bundleId = await publicBundle(['list1.jpg', 'list2.jpg']);
      pages(['transport_waybill', 'other'], ['upd_main', 'upd_continuation']);

      await runAssembly(bundleId);

      expect(classifyPages).toHaveBeenCalledTimes(1);
      expect(torg12Calls()).toBe(0);
      expect(await segmentsOf(bundleId)).toHaveLength(0);
      expect(await realDocs()).toHaveLength(2);
      const evidence = await evidenceOf(bundleId);
      expect(evidence.map((e) => e.evidence_type)).not.toContain('torg12_recheck');
    });

    it('shadow — второй вызов и след, но исход тот же, что при off', async () => {
      flags.recheck = 'shadow';
      const bundleId = await publicBundle(['list1.jpg', 'list2.jpg']);
      pages(['transport_waybill', 'other'], ['upd_main', 'upd_continuation']);

      await runAssembly(bundleId);

      expect(torg12Calls()).toBe(1);
      expect(await segmentsOf(bundleId)).toHaveLength(0);
      expect(await realDocs()).toHaveLength(2);
      const recheck = (await evidenceOf(bundleId)).find((e) => e.evidence_type === 'torg12_recheck');
      expect(recheck?.payload).toMatchObject({
        stage: 'pages',
        mode: 'shadow',
        changedPages: [1, 2],
        applied: false,
        wouldPlan: { confident: true },
      });
      const pageEvidence = (await evidenceOf(bundleId)).find(
        (e) => e.evidence_type === 'page_classification',
      );
      expect(pageEvidence?.payload).not.toHaveProperty('torg12Recheck');
    });

    it('on — два листа становятся одним документом', async () => {
      flags.recheck = 'on';
      const bundleId = await publicBundle(['list1.jpg', 'list2.jpg']);
      pages(['transport_waybill', 'other'], ['upd_main', 'upd_continuation']);

      await runAssembly(bundleId);

      const segs = await segmentsOf(bundleId);
      expect(segs).toHaveLength(1);
      expect(extractUpdSegment).toHaveBeenCalledTimes(1);
      const docs = await realDocs();
      expect(docs).toHaveLength(1);
      expect(docs[0]!.doc_number).toBe('10626044499');
      const pageEvidence = (await evidenceOf(bundleId)).find(
        (e) => e.evidence_type === 'page_classification',
      );
      expect(pageEvidence?.payload).toMatchObject({ torg12Recheck: 'applied' });
    });

    it('on — лист со строками загружен первым: перестановка только здесь', async () => {
      flags.recheck = 'on';
      const bundleId = await publicBundle(['list2.jpg', 'list1.jpg']);
      pages(['certificate', 'transport_waybill'], ['upd_continuation', 'upd_main']);

      await runAssembly(bundleId);

      expect(await segmentsOf(bundleId)).toHaveLength(1);
      expect(await realDocs()).toHaveLength(1);
    });
  });

  describe('сборка: остальные пакеты не меняются', () => {
    it('УПД + настоящая ТН: модель подтвердила ТН — исход как при off', async () => {
      const runWith = async (mode: 'off' | 'on') => {
        await cleanup();
        flags.recheck = mode;
        classifyPages.mockReset();
        extractUpdSegment.mockReset().mockResolvedValue(updResult('1381'));
        const bundleId = await publicBundle(['upd.jpg', 'tn.jpg']);
        pages(['upd_main', 'transport_waybill'], ['upd_main', 'transport_waybill']);
        await runAssembly(bundleId);
        const segs = await segmentsOf(bundleId);
        // Адрес страницы без id строки реестра: у двух прогонов разные пакеты.
        return {
          segments: segs.map((s) =>
            (s.page_refs as Array<{ inputOrder: number; pageInFile: number }>).map((r) => [
              r.inputOrder,
              r.pageInFile,
            ]),
          ),
          docs: (await realDocs()).map((d) => [d.kind, d.doc_number]),
        };
      };
      const off = await runWith('off');
      const on = await runWith('on');
      expect(on).toEqual(off);
      // ТН отброшена в обоих режимах: сегмент — одна страница УПД.
      expect(on.segments).toEqual([[[0, 1]]]);
    });

    it('обычный пакет УПД не переспрашивается ни в одном режиме', async () => {
      for (const mode of ['shadow', 'on'] as const) {
        await cleanup();
        flags.recheck = mode;
        classifyPages.mockReset();
        const bundleId = await publicBundle(['1.jpg', '2.jpg']);
        pages(['upd_main', 'upd_continuation'], ['transport_waybill', 'transport_waybill']);
        await runAssembly(bundleId);
        expect(torg12Calls()).toBe(0);
        expect(await segmentsOf(bundleId)).toHaveLength(1);
        const evidence = await evidenceOf(bundleId);
        expect(evidence.map((e) => e.evidence_type)).not.toContain('torg12_recheck');
      }
    });
  });

  describe('роутер: лист со строками назван М-15', () => {
    beforeEach(() => {
      // Фото без текстового слоя: тип решает классификатор по изображению.
      classifyFile.mockReset().mockResolvedValue({
        detectedKind: 'unknown',
        confidence: 0,
        needsVision: true,
        parserUsed: 'none',
        signals: [],
      });
      classifyImageKind.mockImplementation(
        async (buffer: Buffer, _mime: string, ctx: { prompt?: string }) => {
          const isList2 = buffer.toString().includes('list2');
          if (ctx?.prompt === 'torg12') return { kind: 'upd', confidence: 0.9 };
          return isList2 ? { kind: 'm15', confidence: 0.95 } : { kind: 'upd', confidence: 0.9 };
        },
      );
      pages(['transport_waybill', 'other'], ['upd_main', 'upd_continuation']);
    });

    const torg12FileCalls = () =>
      classifyImageKind.mock.calls.filter((c) => (c[2] as { prompt?: string })?.prompt === 'torg12')
        .length;

    it('off — М-15 уходит отдельным документом, второго вызова нет', async () => {
      const bundleId = await publicBundle(['list1.jpg', 'list2.jpg']);
      await handleDocumentRouterJob(bundleId, log);

      expect(classifyImageKind).toHaveBeenCalledTimes(2);
      expect(torg12FileCalls()).toBe(0);
      // Лист 2 — документ М-15 сразу после router'а.
      expect((await realDocs()).map((d) => d.kind)).toEqual(['transport_waybill']);
    });

    it('shadow — вызов и след, маршрут прежний', async () => {
      flags.recheck = 'shadow';
      const bundleId = await publicBundle(['list1.jpg', 'list2.jpg']);
      await handleDocumentRouterJob(bundleId, log);

      expect(torg12FileCalls()).toBe(1);
      expect((await realDocs()).map((d) => d.kind)).toEqual(['transport_waybill']);
      const recheck = (await evidenceOf(bundleId)).find((e) => e.evidence_type === 'torg12_recheck');
      expect(recheck?.payload).toMatchObject({
        stage: 'file',
        mode: 'shadow',
        filename: 'list2.jpg',
        wouldChange: true,
        applied: false,
      });
    });

    it('on — оба листа уходят в сборку и становятся одним документом', async () => {
      flags.recheck = 'on';
      const bundleId = await publicBundle(['list1.jpg', 'list2.jpg']);
      await runAssembly(bundleId);

      // Переспрошен только лист «М-15»; лист «УПД» — нет.
      expect(torg12FileCalls()).toBe(1);
      const docs = await realDocs();
      expect(docs).toHaveLength(1);
      expect(docs[0]!.doc_number).toBe('10626044499');
      const fileEvidence = (await evidenceOf(bundleId)).filter(
        (e) => e.evidence_type === 'file_classification',
      );
      expect(JSON.stringify(fileEvidence)).toContain('torg12-recheck:m15->upd');
    });

    it('настоящая ТН остаётся ТН и в режиме on', async () => {
      flags.recheck = 'on';
      classifyImageKind.mockImplementation(async () => ({
        kind: 'transport_waybill',
        confidence: 0.95,
      }));
      const bundleId = await publicBundle(['tn.jpg']);
      await handleDocumentRouterJob(bundleId, log);

      expect(torg12FileCalls()).toBe(1);
      const recheck = (await evidenceOf(bundleId)).find((e) => e.evidence_type === 'torg12_recheck');
      expect(recheck?.payload).toMatchObject({ wouldChange: false, applied: false });
      // Ни одного кандидата сборки: файл ушёл в путь накладных, как сегодня.
      // Дочерний пакет сборки — kind 'upd', пакет накладной — 'waybill'.
      const subs = await db<{ kind: string }[]>`
        SELECT kind FROM source_bundles WHERE parent_bundle_id = ${bundleId}`;
      expect(subs.map((s) => s.kind)).toEqual(['waybill']);
    });
  });
});
