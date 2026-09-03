/**
 * Сквозной путь поставщика: загрузка на портале → нарезка → публикация →
 * выдача на планшет.
 *
 * Существующие наборы проверяют этот путь по кускам: public-upload — приём
 * файлов, upd-assembly — сборку. Между ними оставалась щель, в которую и
 * провалился боевой случай: файл принят, документы созданы, счётчики сходятся,
 * а одного документа нет. Здесь цепочка проходится целиком и на реальном
 * HTTP-приёме.
 *
 * Главная проверка выпуска — последняя: документы обязаны доехать до
 * инспектора. Пометки о сомнениях («в файле были неразобранные страницы»)
 * ничего не блокируют — иначе машину не впустят на КПП.
 *
 * Запуск: см. заголовок public-upload.int.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq as drEq, sql as drSql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EnvModule from '../../src/lib/env.js';
import type * as PrefilterModule from '../../src/domain/edo/upd-page-prefilter.js';
import type * as PageRenderModule from '../../src/domain/edo/page-render.js';
import type * as SegmentExtractModule from '../../src/domain/edo/upd-segment-extract.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;
const sql = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 4 }) : null;

const flags = { splitByDocNumber: 'on' as 'off' | 'shadow' | 'on', numberAudit: true };

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
    }),
  };
});

const mocks = vi.hoisted(() => ({
  putObject: vi.fn(),
  presign: vi.fn(),
  getObject: vi.fn(),
  queueAdd: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  putObject: mocks.putObject,
  presign: mocks.presign,
  getObject: mocks.getObject,
  deleteObject: vi.fn().mockResolvedValue(undefined),
}));
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

const { publicUploadRoutes } = await import('../../src/routes/public-upload.js');
const { handleDocumentRouterJob, handleUpdAssemblyJob, handleJob } =
  await import('../../src/worker.js');
const { mobileVisibleSourceDocumentSql } =
  await import('../../src/domain/sourceDocuments/mobile-visibility.js');
const { sourceDocuments } = await import('../../src/db/schema.js');
const { encryptField, buildAad } = await import('../../src/domain/auth/crypto.js');

const BOUNDARY = '----matcheckE2E';
const RATE_LIMIT_OK = {
  isAllowed: false,
  key: 'public-upload:global',
  max: 200,
  timeWindow: 3_600_000,
  remaining: 199,
  ttl: 3_600_000,
  ttlInSeconds: 3600,
  isExceeded: false,
  isBanned: false,
} as const;

function multipartBody(
  fields: Record<string, string>,
  files: Array<{ filename: string; content: Buffer }>,
): { body: Buffer; headers: Record<string, string> } {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="${f.filename}"\r\n` +
          `Content-Type: application/pdf\r\n\r\n`,
      ),
      f.content,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return {
    body: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

/**
 * Минимальный PDF: публичный вход проверяет тип по СОДЕРЖИМОМУ, а не по
 * заголовку части, поэтому подделать «фото» пустыми байтами нельзя.
 */
const pdf = (marker: string) =>
  Buffer.from(`%PDF-1.4\n%${marker}\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n`);

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

suite('сквозной путь: загрузка на портале → планшет (реальный PostgreSQL)', () => {
  const db = sql!;
  const drizzleDb = drizzle(sql!);
  const siteId = randomUUID();
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 10 } });
    app.decorate('db', drizzleDb as never);
    app.decorate('queues', { updParse: { add: mocks.queueAdd } } as never);
    app.decorate('createRateLimit', () => mocks.rateLimit as never);
    await app.register(publicUploadRoutes);
    await app.ready();

    await db`INSERT INTO sites (id, code, name)
      VALUES (${siteId}, ${`E2E${Date.now() % 10000}`}, 'Сквозной путь')`;
    await db`DELETE FROM llm_provider_credentials WHERE kind = 'openrouter'`;
    await db`DELETE FROM llm_providers WHERE name = 'e2e-openrouter'`;
    await db`UPDATE llm_providers SET is_default = false WHERE is_default = true`;
    await db`INSERT INTO llm_providers (name, kind, model, api_base_url, is_default)
      VALUES ('e2e-openrouter', 'openrouter', 'test/model', 'https://openrouter.test/api/v1', true)`;
    const envelope = encryptField('test-key', buildAad('llm_provider_credentials', 'openrouter'));
    await db`INSERT INTO llm_provider_credentials (kind, api_base_url, api_key_encrypted)
      VALUES ('openrouter', 'https://openrouter.test/api/v1', ${JSON.stringify(envelope)})`;
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await app.close();
    await db`DELETE FROM llm_provider_credentials WHERE kind = 'openrouter'`;
    await db`DELETE FROM llm_providers WHERE name = 'e2e-openrouter'`;
    await db`DELETE FROM sites WHERE id = ${siteId}`;
    await db.end({ timeout: 5 });
  });

  async function cleanup(): Promise<void> {
    const bundles = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE site_id = ${siteId}`;
    const docs = await db<{ id: string }[]>`
      SELECT id FROM source_documents WHERE site_id = ${siteId}`;
    const ids = [...bundles.map((b) => b.id), ...docs.map((d) => d.id)];
    if (ids.length > 0) {
      await db`DELETE FROM job_outbox
        WHERE payload->>'bundleId' = ANY(${ids}) OR payload->>'sourceDocumentId' = ANY(${ids})`;
    }
    if (bundles.length > 0) {
      const bundleIds = bundles.map((b) => b.id);
      await db`DELETE FROM llm_calls WHERE response_parsed->>'bundleId' = ANY(${bundleIds})`;
      await db`DELETE FROM recognition_evidence_events WHERE bundle_id = ANY(${bundleIds})`;
    }
    await db`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await db`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  }

  beforeEach(async () => {
    await cleanup();
    mocks.putObject.mockReset().mockResolvedValue(undefined);
    mocks.presign.mockReset().mockResolvedValue('https://s3.example/signed');
    mocks.getObject.mockReset().mockResolvedValue(Buffer.from('fake-image-bytes'));
    mocks.queueAdd.mockReset().mockResolvedValue(undefined);
    mocks.rateLimit.mockReset().mockResolvedValue(RATE_LIMIT_OK);
    classifyFile.mockReset().mockResolvedValue({
      detectedKind: 'upd',
      confidence: 0.95,
      needsVision: true,
      parserUsed: 'none',
      signals: ['e2e'],
    });
    classifyPages.mockReset();
    extractUpdSegment.mockReset();
  });

  function updResult(docNumber: string) {
    return {
      parsed: {
        docNumber,
        docDate: '2026-09-02',
        totalSum: 1000,
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

  it('шесть УПД в одном файле доезжают до планшета все, включая «съеденный» ранее', async () => {
    // Классификатор повторяет боевую ошибку: шапку УТ-4308 на третьей странице
    // он считает продолжением УТ-4309. Спасает только номер документа.
    classifyPages.mockResolvedValue({
      classification: [
        { page: 1, type: 'upd_main', use: true, docNumber: 'УТ-4309' },
        { page: 2, type: 'upd_continuation', use: true, docNumber: 'УТ-4309' },
        { page: 3, type: 'upd_continuation', use: true, docNumber: 'УТ-4308' },
      ],
      raw: '{"pages":[]}',
      promptTokens: 10,
      completionTokens: 10,
      finishReason: 'stop',
    });
    extractUpdSegment
      .mockResolvedValueOnce(updResult('УТ-4309'))
      .mockResolvedValueOnce(updResult('УТ-4308'));

    const { body, headers } = multipartBody(
      { siteId, expectedDate: '2026-09-03', comment: 'Инстракт' },
      [
        { filename: 'p1.pdf', content: pdf('page-1') },
        { filename: 'p2.pdf', content: pdf('page-2') },
        { filename: 'p3.pdf', content: pdf('page-3') },
      ],
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/public/upload-documents',
      headers,
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ filesAccepted: 3, filesRejected: [] });

    const [bundle] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE site_id = ${siteId} AND parent_bundle_id IS NULL`;
    const bundleId = bundle!.id;

    await handleDocumentRouterJob(bundleId, log);
    const [sub] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundleId}`;
    await handleUpdAssemblyJob(sub!.id, 0, log);

    const segments = await db<{ id: string; source_document_id: string; segment_index: number }[]>`
      SELECT s.id, s.source_document_id, s.segment_index FROM bundle_segments s
      WHERE s.bundle_id = ${bundleId} AND s.source_document_id IS NOT NULL
      ORDER BY s.segment_index`;
    // Ровно то, ради чего выпуск: два документа вместо одного.
    expect(segments).toHaveLength(2);
    for (const seg of segments) {
      await handleJob({
        id: `seg-${seg.segment_index}`,
        data: { sourceDocumentId: seg.source_document_id, segmentId: seg.id, generation: 0 },
      } as never);
    }

    const docs = await db<{ id: string; doc_number: string; status: string }[]>`
      SELECT id, doc_number, status FROM source_documents
      WHERE site_id = ${siteId} AND is_technical = false ORDER BY doc_number`;
    expect(docs.map((d) => d.doc_number)).toEqual(['УТ-4308', 'УТ-4309']);

    // И главное: оба доезжают до инспектора — тем же предикатом, которым
    // отбирает документы выдача /sync.
    for (const doc of docs) {
      const [row] = await drizzleDb
        .select({ visible: drSql<boolean>`${mobileVisibleSourceDocumentSql()}` })
        .from(sourceDocuments)
        .where(drEq(sourceDocuments.id, doc.id));
      expect(row?.visible).toBe(true);
    }

    // Ни один принятый файл не остался без исхода.
    const items = await db<{ status: string; effective_status: string | null }[]>`
      SELECT status, effective_status FROM bundle_import_items WHERE bundle_id = ${bundleId}`;
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.effective_status !== null)).toBe(true);
  });
});
