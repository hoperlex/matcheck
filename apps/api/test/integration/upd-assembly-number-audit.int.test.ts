/**
 * Границы документов по номеру и видимые следы потерь (реальный PostgreSQL).
 *
 * Боевой случай: поставщик прислал один PDF на девять страниц с шестью УПД,
 * система создала пять. Шапка УТ-4308 (36 189,52 ₽) была прочитана как оборот
 * УТ-4309, страницы слиплись в один сегмент, а парсер на сегмент возвращает
 * ровно один документ — и шестой документ не появился нигде: ни строки, ни
 * ошибки, ни расхождения в суммах остальных.
 *
 * Здесь проверяется то, что на моках не воспроизводится: манифест, публикация
 * и пометки в validation. Отдельно — главный запрет выпуска: пометка не смеет
 * менять статус документа и его путь на планшет. Инспектор обязан получить
 * материалы, даже если к пакету есть вопросы, иначе машину не впустят на КПП.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq as drEq, sql as drSql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EnvModule from '../../src/lib/env.js';
import type * as PrefilterModule from '../../src/domain/edo/upd-page-prefilter.js';
import type * as PageRenderModule from '../../src/domain/edo/page-render.js';
import type * as SegmentExtractModule from '../../src/domain/edo/upd-segment-extract.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;
const sql = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 4 }) : null;

/** Режимы переключаются внутри кейсов: набор проверяет и включённое, и off. */
const flags = {
  splitByDocNumber: 'off' as 'off' | 'shadow' | 'on',
  numberAudit: false,
  rollbackKind: 'off' as 'off' | 'shadow' | 'on',
};

vi.mock('../../src/lib/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return {
    ...actual,
    loadEnv: () => ({
      ...actual.loadEnv(),
      UPD_ASSEMBLY_V1: true,
      UPD_ASSEMBLY_COPY_DEDUP_V1: true,
      UPD_ASSEMBLY_SPLIT_BY_DOC_NUMBER: flags.splitByDocNumber,
      UPD_ASSEMBLY_NUMBER_AUDIT: flags.numberAudit,
      UPD_ASSEMBLY_ROLLBACK_KIND: flags.rollbackKind,
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

const { handleDocumentRouterJob, handleUpdAssemblyJob, handleJob } =
  await import('../../src/worker.js');
const { mobileVisibleSourceDocumentSql } =
  await import('../../src/domain/sourceDocuments/mobile-visibility.js');
const { sourceDocuments } = await import('../../src/db/schema.js');
const drizzleDb = drizzle(sql!);
const { encryptField, buildAad } = await import('../../src/domain/auth/crypto.js');

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

type DocRow = {
  id: string;
  doc_number: string | null;
  status: string;
  parse_error_code: string | null;
  is_technical: boolean;
  validation: { warnings?: { name: string }[] } | null;
};

suite('нарезка по номеру и аудит нумерации (реальный PostgreSQL)', () => {
  const siteId = randomUUID();
  const db = sql!;

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name)
      VALUES (${siteId}, ${`AUD${Date.now() % 10000}`}, 'Аудит нумерации')`;
    await db`DELETE FROM llm_provider_credentials WHERE kind = 'openrouter'`;
    await db`DELETE FROM llm_providers WHERE name = 'audit-openrouter'`;
    await db`UPDATE llm_providers SET is_default = false WHERE is_default = true`;
    await db`INSERT INTO llm_providers (name, kind, model, api_base_url, is_default)
      VALUES ('audit-openrouter', 'openrouter', 'test/model', 'https://openrouter.test/api/v1', true)`;
    const envelope = encryptField('test-key', buildAad('llm_provider_credentials', 'openrouter'));
    await db`INSERT INTO llm_provider_credentials (kind, api_base_url, api_key_encrypted)
      VALUES ('openrouter', 'https://openrouter.test/api/v1', ${JSON.stringify(envelope)})`;
  });

  async function cleanup(): Promise<void> {
    const docs = await db<{ id: string }[]>`
      SELECT id FROM source_documents WHERE site_id = ${siteId}`;
    const bundles = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE site_id = ${siteId}`;
    const ids = [...docs.map((d) => d.id), ...bundles.map((b) => b.id)];
    if (ids.length > 0) {
      await db`DELETE FROM job_outbox
         WHERE payload->>'sourceDocumentId' = ANY(${ids})
            OR payload->>'bundleId' = ANY(${ids})`;
    }
    if (bundles.length > 0) {
      await db`DELETE FROM llm_calls WHERE response_parsed->>'bundleId' = ANY(${bundles.map((b) => b.id)})`;
      await db`DELETE FROM recognition_evidence_events WHERE bundle_id = ANY(${bundles.map((b) => b.id)})`;
    }
    await db`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await db`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  }

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db`DELETE FROM llm_provider_credentials WHERE kind = 'openrouter'`;
    await db`DELETE FROM llm_providers WHERE name = 'audit-openrouter'`;
    await db`DELETE FROM sites WHERE id = ${siteId}`;
    await db.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await cleanup();
    flags.splitByDocNumber = 'off';
    flags.numberAudit = false;
    flags.rollbackKind = 'off';
    classifyFile.mockReset().mockResolvedValue({
      detectedKind: 'upd',
      confidence: 0.95,
      needsVision: true,
      parserUsed: 'none',
      signals: ['test'],
    });
    classifyPages.mockReset();
    extractUpdSegment.mockReset();
  });

  async function publicBundle(files: string[]): Promise<string> {
    const hash = createHash('sha256').update(randomUUID()).digest('hex');
    const [bundle] = await db<{ id: string }[]>`
      INSERT INTO source_bundles
        (bundle_hash, kind, direction, site_id, status, origin, expected_date)
      VALUES (${hash}, 'mixed', 'inbound', ${siteId}, 'queued', 'manual_pdf', now())
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

  /** Ответ классификатора: тип и номер каждой страницы. */
  function pagesAre(...pages: Array<[type: string, docNumber?: string]>): void {
    classifyPages.mockResolvedValue({
      classification: pages.map(([type, docNumber], i) => ({
        page: i + 1,
        type,
        use: type !== 'certificate' && type !== 'transport_waybill',
        ...(docNumber !== undefined ? { docNumber } : {}),
      })),
      raw: '{"pages":[]}',
      promptTokens: 10,
      completionTokens: 10,
      finishReason: 'stop',
    });
  }

  function updResult(docNumber: string) {
    return {
      parsed: {
        docNumber,
        docDate: '2026-09-02',
        totalSum: 1000,
        // НДС не заявляем: набор про границы документов и пометки, а не про
        // арифметику. С заявленным НДС документ получил бы честный
        // validation_mismatch, и проверка «пометка не меняет исход» смотрела
        // бы на расхождение сумм вместо аудита.
        vatSum: null,
        itemsCount: 1,
        supplier: { name: 'ООО Поставщик', inn: '7743429410' },
        recipient: { name: 'ООО СУ-10', inn: '7736255508' },
        items: [{ nameRaw: `Материал ${docNumber}`, qty: 2, unit: 'шт', price: 500, sum: 1000 }],
        confidence: 0.9,
      },
      llmProviderId: null as string | null,
    };
  }

  /** Прогоняет пакет целиком: router → сборка → разбор каждого сегмента. */
  async function runBundle(bundleId: string): Promise<void> {
    await handleDocumentRouterJob(bundleId, log);
    const [sub] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundleId}`;
    if (!sub) return;
    await handleUpdAssemblyJob(sub.id, 0, log);
    const segments = await db<{ id: string; source_document_id: string; segment_index: number }[]>`
      SELECT s.id, s.source_document_id, s.segment_index FROM bundle_segments s
      JOIN source_bundles b ON b.id = s.bundle_id
      WHERE b.site_id = ${siteId} AND s.source_document_id IS NOT NULL
      ORDER BY s.segment_index`;
    for (const seg of segments) {
      // Задание сегмента адресуется segmentId + generation: без них worker
      // считает документ обычным одиночным УПД и до публикации не доходит.
      await handleJob({
        id: `seg-${seg.segment_index}`,
        data: {
          sourceDocumentId: seg.source_document_id,
          segmentId: seg.id,
          generation: 0,
        },
      } as never);
    }
  }

  /**
   * Тот же предикат, которым выдача /sync решает, что видит инспектор.
   * Проверять статусом нельзя: «parsed» ещё не значит «доехал до планшета».
   */
  async function visibleOnTablet(documentId: string): Promise<boolean> {
    const [row] = await drizzleDb
      .select({ visible: drSql<boolean>`${mobileVisibleSourceDocumentSql()}` })
      .from(sourceDocuments)
      .where(drEq(sourceDocuments.id, documentId));
    return row?.visible ?? false;
  }

  const docsOfSite = () => db<DocRow[]>`
    SELECT id, doc_number, status, parse_error_code, is_technical, validation
    FROM source_documents
    WHERE site_id = ${siteId} AND is_technical = false
    ORDER BY doc_number`;

  it('боевой случай: шапка на странице-«обороте» больше не съедает документ', async () => {
    flags.splitByDocNumber = 'on';
    // Хвост боевого файла: УТ-4309 на стр. 7, УТ-4308 на стр. 8 (прочитана
    // как продолжение), УТ-4307 на стр. 9. В тесте страница = файл: рендер
    // замокан «одна страница на вход».
    const bundleId = await publicBundle(['p7.jpg', 'p8.jpg', 'p9.jpg']);
    pagesAre(['upd_main', 'УТ-4309'], ['upd_continuation', 'УТ-4308'], ['upd_main', 'УТ-4307']);
    extractUpdSegment
      .mockResolvedValueOnce(updResult('УТ-4309'))
      .mockResolvedValueOnce(updResult('УТ-4308'))
      .mockResolvedValueOnce(updResult('УТ-4307'));

    await runBundle(bundleId);

    const docs = await docsOfSite();
    expect(docs.map((d) => d.doc_number)).toEqual(['УТ-4307', 'УТ-4308', 'УТ-4309']);
    // Опубликованы — то есть поедут инспектору обычным порядком.
    expect(docs.every((d) => d.status === 'parsed')).toBe(true);
  });

  it('при выключенном рубильнике тот же пакет теряет документ, как сегодня', async () => {
    // Характеризация прежнего поведения: без него нельзя утверждать, что фикс
    // не холостой, и что выключенный флаг ничего не меняет.
    const bundleId = await publicBundle(['p7.jpg', 'p8.jpg', 'p9.jpg']);
    pagesAre(['upd_main', 'УТ-4309'], ['upd_continuation', 'УТ-4308'], ['upd_main', 'УТ-4307']);
    extractUpdSegment
      .mockResolvedValueOnce(updResult('УТ-4309'))
      .mockResolvedValueOnce(updResult('УТ-4307'));

    await runBundle(bundleId);

    const docs = await docsOfSite();
    expect(docs.map((d) => d.doc_number)).toEqual(['УТ-4307', 'УТ-4309']);
  });

  it('аудит помечает пропуск в нумерации, не трогая статус и видимость', async () => {
    flags.numberAudit = true;
    const bundleId = await publicBundle(['p1.jpg', 'p2.jpg', 'p3.jpg']);
    pagesAre(['upd_main'], ['upd_main'], ['upd_main']);
    extractUpdSegment
      .mockResolvedValueOnce(updResult('УТ-4304'))
      .mockResolvedValueOnce(updResult('УТ-4306'))
      .mockResolvedValueOnce(updResult('УТ-4307'));

    await runBundle(bundleId);

    const docs = await docsOfSite();
    expect(docs).toHaveLength(3);
    for (const doc of docs) {
      expect(doc.validation?.warnings?.map((w) => w.name)).toContain('sibling_number_gap');
      // Главный запрет выпуска: пометка не меняет ни статус, ни исход разбора,
      // ни техничность — документ едет на планшет как обычно.
      expect(doc.status).toBe('parsed');
      expect(doc.parse_error_code).toBeNull();
      expect(doc.is_technical).toBe(false);
    }
  });

  it('выброшенные страницы перестают исчезать: пакет помечен, документы опубликованы', async () => {
    flags.numberAudit = true;
    const bundleId = await publicBundle(['p1.jpg', 'tn.jpg', 'p3.jpg']);
    pagesAre(['upd_main'], ['transport_waybill'], ['upd_main']);
    extractUpdSegment
      .mockResolvedValueOnce(updResult('УТ-4304'))
      .mockResolvedValueOnce(updResult('УТ-4305'));

    await runBundle(bundleId);

    const docs = await docsOfSite();
    expect(docs).toHaveLength(2);
    expect(docs[0]!.validation?.warnings?.map((w) => w.name)).toContain('dropped_pages_not_parsed');
    expect(docs.every((d) => d.status === 'parsed')).toBe(true);
  });

  it('без рубильника аудита пометок не появляется', async () => {
    const bundleId = await publicBundle(['p1.jpg', 'tn.jpg', 'p3.jpg']);
    pagesAre(['upd_main'], ['transport_waybill'], ['upd_main']);
    extractUpdSegment
      .mockResolvedValueOnce(updResult('УТ-4304'))
      .mockResolvedValueOnce(updResult('УТ-4306'));

    await runBundle(bundleId);

    const docs = await docsOfSite();
    for (const doc of docs) {
      const names = doc.validation?.warnings?.map((w) => w.name) ?? [];
      expect(names).not.toContain('sibling_number_gap');
      expect(names).not.toContain('dropped_pages_not_parsed');
    }
  });

  it('однородная накладная после отката уходит в waybill-парсер, а не в УПД', async () => {
    // 50 файлов за две недели ушли в УПД-парсер именно так: классификатор
    // честно сказал «здесь нет ни одной УПД-страницы», а откат всё равно
    // создавал документ вида «УПД». Серия ТТН «Боневит» так и лежит в системе
    // как УПД.
    flags.rollbackKind = 'on';
    const bundleId = await publicBundle(['tn1.jpg', 'tn2.jpg']);
    pagesAre(['transport_waybill'], ['transport_waybill']);

    await runBundle(bundleId);

    const [sub] = await db<{ id: string; kind: string | null }[]>`
      SELECT id, kind FROM source_bundles
      WHERE parent_bundle_id = ${bundleId} AND kind = 'waybill'`;
    expect(sub).toBeTruthy();
    const kinds = await db<{ kind: string }[]>`
      SELECT kind FROM source_documents WHERE bundle_id = ${sub!.id}`;
    expect(kinds.map((k) => k.kind)).toEqual(['transport_waybill']);
    // Строка реестра закрыта и указывает на дочерний пакет — файл не потерян.
    const [item] = await db<{ status: string; sub_bundle_id: string | null }[]>`
      SELECT status, sub_bundle_id FROM bundle_import_items
      WHERE bundle_id = ${bundleId} AND source_filename = 'tn1.jpg'`;
    expect(item?.status).toBe('created');
    expect(item?.sub_bundle_id).toBeTruthy();
  });

  it('при выключенном рубильнике та же накладная идёт прежним путём — в УПД', async () => {
    const bundleId = await publicBundle(['tn1.jpg', 'tn2.jpg']);
    pagesAre(['transport_waybill'], ['transport_waybill']);

    await runBundle(bundleId);

    const waybillBundles = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundleId} AND kind = 'waybill'`;
    expect(waybillBundles).toHaveLength(0);
    const kinds = await db<{ kind: string }[]>`
      SELECT DISTINCT kind FROM source_documents
      WHERE site_id = ${siteId} AND is_technical = false`;
    expect(kinds.map((k) => k.kind)).toEqual(['upd']);
  });

  it('планшет: документ с материалами, но без цен и сумм, доезжает до приёмки', async () => {
    // Требование КПП: машину не впустят, пока инспектор не оформит приёмку.
    // Поэтому документ без стоимостной части, но с материалами обязан быть
    // виден на планшете — это поведение уже менялось ради него однажды.
    const bundleId = await publicBundle(['p1.jpg']);
    pagesAre(['upd_main']);
    extractUpdSegment.mockResolvedValueOnce({
      parsed: {
        docNumber: 'УТ-5000',
        docDate: '2026-09-02',
        totalSum: null,
        vatSum: null,
        itemsCount: 1,
        pricing: 'absent',
        supplier: { name: 'ООО Поставщик', inn: '7743429410' },
        recipient: { name: 'ООО СУ-10', inn: '7736255508' },
        items: [{ nameRaw: 'Щебень 20-40', qty: 12, unit: 'т' }],
        confidence: 0.9,
      },
      llmProviderId: null,
    });

    await runBundle(bundleId);

    const [doc] = await docsOfSite();
    expect(doc?.doc_number).toBe('УТ-5000');
    expect(await visibleOnTablet(doc!.id)).toBe(true);
  });

  it('планшет: пакетное предупреждение не мешает документу доехать до приёмки', async () => {
    flags.numberAudit = true;
    const bundleId = await publicBundle(['p1.jpg', 'tn.jpg', 'p3.jpg']);
    pagesAre(['upd_main'], ['transport_waybill'], ['upd_main']);
    extractUpdSegment
      .mockResolvedValueOnce(updResult('УТ-4304'))
      .mockResolvedValueOnce(updResult('УТ-4305'));

    await runBundle(bundleId);

    const docs = await docsOfSite();
    expect(docs[0]!.validation?.warnings?.map((w) => w.name)).toContain('dropped_pages_not_parsed');
    for (const doc of docs) {
      expect(await visibleOnTablet(doc.id)).toBe(true);
    }
  });

  it('классификация страниц сборки попадает в журнал llm_calls', async () => {
    const bundleId = await publicBundle(['p1.jpg', 'p2.jpg']);
    pagesAre(['upd_main'], ['upd_main']);
    extractUpdSegment
      .mockResolvedValueOnce(updResult('УТ-4304'))
      .mockResolvedValueOnce(updResult('УТ-4305'));

    await runBundle(bundleId);

    const [call] = await db<{ doc_kind: string; response_raw: string | null }[]>`
      SELECT doc_kind, response_raw FROM llm_calls
      WHERE response_parsed->>'bundleId' = ${bundleId}`;
    expect(call?.doc_kind).toBe('upd_page_classify');
    expect(call?.response_raw).toBe('{"pages":[]}');
  });
});
