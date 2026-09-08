/**
 * Relaxed-склейка на живом конвейере: фрагмент с чужой датой не становится
 * вторым документом.
 *
 * Воспроизводится приёмка 13776 (пакет a29e2812…, номер 201/21126719-1 одного
 * поставщика): страница со строками 1–2 и итогом 23 404,53, страница со
 * строкой 1 и итогом 8 177,00 — их сводит строгая склейка, — и третья страница
 * со строкой 2 и тем же итогом 23 404,53, но с датой 2025-11-25. Именно она
 * публиковалась отдельным документом, привязывалась к той же приёмке, и
 * «Соединитель пруток — полоса, 80х80» учитывался дважды: 47 шт вместо 47
 * превращались в 94, лишние 12 482 ₽.
 *
 * Модульные тесты планировщика — upd-assembly-relaxed.test.ts. Здесь проверяется
 * то, чего на них не видно: какие документы реально остались опубликованными,
 * сколько строк у победителя и что при выключенном рубильнике всё в точности
 * как было.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Типы модулей, которые подменяются частично: importOriginal должен вернуть
// типизированный объект, а инлайновый import() в аннотации запрещён линтом.
import type * as EnvModule from '../../src/lib/env.js';
import type * as PrefilterModule from '../../src/domain/edo/upd-page-prefilter.js';
import type * as PageRenderModule from '../../src/domain/edo/page-render.js';
import type * as SegmentExtractModule from '../../src/domain/edo/upd-segment-extract.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const sql = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 4 }) : null;

// Флаг включается ТОЛЬКО для этого файла. Через process.env так делать нельзя:
// vitest гоняет наборы в общем процессе, и глобальная правка включала бы сборку
// в соседних наборах — там она ломает ожидания (router перестаёт создавать
// документ на файл).
// Режим relaxed-прохода меняется прямо в тесте: только так «off» и «on»
// сравниваются на одном и том же входе. vi.hoisted — потому что vi.mock
// поднимается выше объявлений.
const flags = vi.hoisted(() => ({ relaxed: 'off' as 'off' | 'shadow' | 'on' }));

vi.mock('../../src/lib/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return {
    ...actual,
    loadEnv: () => ({
      ...actual.loadEnv(),
      UPD_ASSEMBLY_V1: true,
      UPD_ASSEMBLY_COPY_DEDUP_V1: true,
      UPD_ASSEMBLY_RELAXED_COPY: flags.relaxed,
    }),
  };
});

// SSE идёт через Redis, которого в тестовом окружении нет: ioredis честно
// отрабатывает свои ретраи по несколько секунд на каждый документ. На результат
// это не влияет (ошибка публикации проглатывается), но набор из-за неё шёл
// полторы минуты вместо трёх секунд.
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
  // Байты не важны: рендер и классификация замоканы. Важно, что файл читается.
  getObject: vi.fn().mockResolvedValue(Buffer.from('fake-image-bytes')),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  presign: vi.fn().mockResolvedValue('https://s3.example/signed'),
}));

const classifyFile = vi.fn();
vi.mock('../../src/domain/edo/document-router.js', () => ({
  classifyFile: (...args: unknown[]) => classifyFile(...args),
}));

// Классификация страниц пакета — единственный LLM-вызов фазы сборки.
const classifyPages = vi.fn();
vi.mock('../../src/domain/edo/upd-page-prefilter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PrefilterModule>();
  return { ...actual, classifyPages: (...args: unknown[]) => classifyPages(...args) };
});

// Подготовка страниц: настоящий pdftoppm/jimp здесь не нужен — проверяется
// логика сборки, а не рендер (он покрыт page-render-image.test.ts).
vi.mock('../../src/domain/edo/page-render.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PageRenderModule>();
  return {
    ...actual,
    renderPdf: vi.fn().mockResolvedValue([Buffer.from('page-1')]),
    imageToPng: vi.fn().mockResolvedValue(Buffer.from('png')),
    // Сборка готовит страницы через imageToVisionPage (тот же PNG, но с
    // потолком разрешения). Без подмены сюда приехал бы настоящий Jimp и
    // споткнулся о Buffer.from('png').
    imageToVisionPage: vi.fn().mockResolvedValue(Buffer.from('png')),
    toClassifyThumb: vi.fn().mockResolvedValue(Buffer.from('thumb')),
  };
});

const extractUpdSegment = vi.fn();
vi.mock('../../src/domain/edo/upd-segment-extract.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SegmentExtractModule>();
  return { ...actual, extractUpdSegment: (...args: unknown[]) => extractUpdSegment(...args) };
});

const { handleDocumentRouterJob, handleUpdAssemblyJob, handleJob } = await import(
  '../../src/worker.js'
);
const { encryptField, buildAad } = await import('../../src/domain/auth/crypto.js');

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

suite('relaxed-склейка сегментов (реальный PostgreSQL)', () => {
  const siteId = randomUUID();
  const db = sql!;

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name)
      VALUES (${siteId}, ${`RLX${Date.now() % 10000}`}, 'Relaxed-склейка')`;
    // Провайдер по умолчанию: сборка работает только на image-пути OpenRouter
    // и без него сразу уходит в откат. Сам вызов модели замокан, но гейт
    // «есть провайдер и ключ» проверяется настоящий — как в бою.
    await db`DELETE FROM llm_provider_credentials WHERE kind = 'openrouter'`;
    await db`DELETE FROM llm_providers WHERE name = 'test-openrouter'`;
    await db`UPDATE llm_providers SET is_default = false WHERE is_default = true`;
    await db`INSERT INTO llm_providers (name, kind, model, api_base_url, is_default)
      VALUES ('test-openrouter', 'openrouter', 'test/model', 'https://openrouter.test/api/v1', true)`;
    const envelope = encryptField('test-key', buildAad('llm_provider_credentials', 'openrouter'));
    await db`INSERT INTO llm_provider_credentials (kind, api_base_url, api_key_encrypted)
      VALUES ('openrouter', 'https://openrouter.test/api/v1', ${JSON.stringify(envelope)})`;
  });

  /**
   * Убирает и записи, и их задания.
   *
   * Задания удаляются по payload, а не по ключу: у сборки ключей три вида
   * (документ, пакет, сегмент), и достаточно забыть один, чтобы строка
   * осталась в общей job_outbox. Соседние наборы считают её своей — на этом
   * уже падал router-provenance, который проверяет ГЛОБАЛЬНОЕ число заданий с
   * sourceDocumentId.
   */
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
    // Провайдера убираем обязательно: таблица общая для всех наборов, и
    // оставленный is_default=true включает vision-пути в соседних тестах —
    // router начинает доклассифицировать файлы, а pdftoppm получает мусорные
    // байты из чужого мока S3. Ровно на это набор и напоролся.
    await db`DELETE FROM llm_provider_credentials WHERE kind = 'openrouter'`;
    await db`DELETE FROM llm_providers WHERE name = 'test-openrouter'`;
    await db`DELETE FROM sites WHERE id = ${siteId}`;
    await db.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await cleanup();
    classifyFile.mockReset().mockResolvedValue({
      detectedKind: 'upd',
      confidence: 0.95,
      needsVision: true,
      parserUsed: 'none',
      signals: ['test'],
    });
    classifyPages.mockReset();
    extractUpdSegment.mockReset();
    flags.relaxed = 'off';
  });

  /**
   * Пакет публичной формы с N фотографиями: реестр, служебная запись,
   * вложения — ровно то состояние, в котором его застаёт router.
   */
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

  /** Ответ классификатора: типы страниц по порядку. */
  function pagesAre(...types: string[]): void {
    classifyPages.mockResolvedValue({
      classification: types.map((type, i) => ({
        page: i + 1,
        type,
        use: type !== 'certificate' && type !== 'transport_waybill',
      })),
      raw: '{}',
      promptTokens: 10,
      completionTokens: 10,
    });
  }


  const docsOf = () => db<
    {
      id: string;
      doc_number: string | null;
      is_technical: boolean;
      status: string;
      bundle_id: string;
    }[]
  >`SELECT id, doc_number, is_technical, status, bundle_id FROM source_documents
      WHERE site_id = ${siteId} ORDER BY created_at`;

  const segmentsOf = (bundleId: string) => db<
    {
      id: string;
      segment_index: number;
      source_document_id: string | null;
      published_at: Date | null;
    }[]
  >`SELECT id, segment_index, source_document_id, published_at FROM bundle_segments
      WHERE bundle_id = ${bundleId} ORDER BY segment_index`;

  /** Прогоняет сегментные задания, как это делал бы воркер очереди. */
  async function runSegmentJobs(bundleId: string): Promise<void> {
    const segs = await segmentsOf(bundleId);
    for (const seg of segs) {
      if (!seg.source_document_id) continue;
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

  /** Сегмент боевого пакета 13776: номер один, различаются дата и состав строк. */
  function segment(
    docDate: string,
    totalSum: number,
    items: Array<{ nameRaw: string; qty: number; price: number; sum: number }>,
  ) {
    return {
      parsed: {
        docNumber: '201/21126719-1',
        docDate,
        totalSum,
        vatSum: null,
        itemsCount: items.length,
        supplier: { name: 'ООО Поставщик', inn: '7743429410' },
        recipient: { name: 'ООО СУ-10', inn: '7736255508' },
        items: items.map((i) => ({ ...i, unit: 'шт' })),
        confidence: 0.9,
      },
      llmProviderId: null as string | null,
    };
  }

  const ZAZHIM = { nameRaw: 'Зажим фальцевый', qty: 17, price: 394.26, sum: 8177 };
  const SOEDINITEL = {
    nameRaw: 'Соединитель пруток - полоса, 80х80 мм',
    qty: 47,
    price: 265.57,
    sum: 15227.53,
  };

  /** Три страницы боевого пакета: две своей датой, третья — чужой. */
  async function bundle13776(): Promise<string> {
    const bundleId = await publicBundle(['1.jpg', '2.jpg', '3.jpg']);
    pagesAre('upd_main', 'upd_main', 'upd_main');
    extractUpdSegment
      .mockResolvedValueOnce(segment('2026-09-04', 23404.53, [ZAZHIM, SOEDINITEL]))
      .mockResolvedValueOnce(segment('2026-09-04', 8177, [ZAZHIM]))
      .mockResolvedValueOnce(segment('2025-11-25', 23404.53, [SOEDINITEL]));
    await handleDocumentRouterJob(bundleId, log);
    const [sub] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundleId}`;
    await handleUpdAssemblyJob(sub!.id, 0, log);
    await runSegmentJobs(bundleId);
    return bundleId;
  }

  const itemsOf = (docId: string) => db<{ name_raw: string; qty: string }[]>`
    SELECT name_raw, qty FROM source_document_items
     WHERE source_document_id = ${docId} ORDER BY line_no`;

  it('off — обрезок с чужой датой публикуется вторым документом (сегодняшнее поведение)', async () => {
    // Характеризационный тест: фиксирует дефект, ради которого писался проход.
    // Он же — замок на обещание «выключенный рубильник ничего не меняет».
    flags.relaxed = 'off';
    await bundle13776();

    const published = (await docsOf()).filter((doc) => !doc.is_technical);
    expect(published).toHaveLength(2);
    // Позиция «Соединитель» лежит в двух документах сразу — оба привязались бы
    // к одной приёмке, и 47 шт стали бы 94.
    const names = (
      await Promise.all(published.map(async (doc) => (await itemsOf(doc.id)).map((i) => i.name_raw)))
    ).flat();
    expect(names.filter((n) => n.startsWith('Соединитель'))).toHaveLength(2);
  });

  it('on — обрезок присоединяется к своей УПД, позиция остаётся одна', async () => {
    flags.relaxed = 'on';
    await bundle13776();

    const all = await docsOf();
    const published = all.filter((doc) => !doc.is_technical);
    expect(published).toHaveLength(1);

    const rows = await itemsOf(published[0]!.id);
    expect(rows.map((r) => r.name_raw)).toEqual([ZAZHIM.nameRaw, SOEDINITEL.nameRaw]);
    // Ровно одна строка «Соединитель», и количество не удвоено.
    expect(rows.filter((r) => r.name_raw.startsWith('Соединитель'))).toHaveLength(1);
    expect(Number(rows[1]!.qty)).toBe(47);

    // Дата берётся от keeper строгой группы, а не от обрезка: иначе документ
    // уехал бы в приёмку с датой на год мимо при верных строках.
    const [header] = await db<{ doc_date: string; total_sum: string }[]>`
      SELECT to_char(doc_date, 'YYYY-MM-DD') AS doc_date, total_sum
        FROM source_documents WHERE id = ${published[0]!.id}`;
    expect(header!.doc_date).toBe('2026-09-04');
    expect(header!.total_sum).toBe('23404.53');

    // Присоединённый документ не удалён, а помечен архивным со ссылкой на
    // победителя — след для разбора остаётся.
    const archived = all.filter((doc) => doc.is_technical && doc.status === 'archived');
    expect(archived.length).toBeGreaterThanOrEqual(2);
  });

  it('shadow — состав пакета прежний, но случай записан в улику', async () => {
    flags.relaxed = 'shadow';
    const bundleId = await bundle13776();

    const published = (await docsOf()).filter((doc) => !doc.is_technical);
    expect(published).toHaveLength(2);

    // Улика адресуется КОРНЕВОМУ пакету — тому же, что и классификация страниц.
    const [evidence] = await db<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM recognition_evidence_events
       WHERE bundle_id = ${bundleId} AND evidence_type = 'assembly_relaxed_copy'
       ORDER BY created_at DESC LIMIT 1`;
    expect(evidence).toBeTruthy();
    expect(evidence!.payload).toMatchObject({ mode: 'shadow', applied: false, documentsWouldJoin: 1 });
  });

  it('другой поставщик при том же номере не склеивается ни в одном режиме', async () => {
    // Один номер у разных поставщиков законен: проход обязан оставить их
    // раздельными, иначе склеит чужие документы.
    flags.relaxed = 'on';
    const bundleId = await publicBundle(['1.jpg', '2.jpg', '3.jpg']);
    pagesAre('upd_main', 'upd_main', 'upd_main');
    const foreign = segment('2025-11-25', 23404.53, [SOEDINITEL]);
    foreign.parsed.supplier = { name: 'ООО Другой поставщик', inn: '7707083893' };
    extractUpdSegment
      .mockResolvedValueOnce(segment('2026-09-04', 23404.53, [ZAZHIM, SOEDINITEL]))
      .mockResolvedValueOnce(segment('2026-09-04', 8177, [ZAZHIM]))
      .mockResolvedValueOnce(foreign);
    await handleDocumentRouterJob(bundleId, log);
    const [sub] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundleId}`;
    await handleUpdAssemblyJob(sub!.id, 0, log);
    await runSegmentJobs(bundleId);

    const published = (await docsOf()).filter((doc) => !doc.is_technical);
    expect(published).toHaveLength(2);
  });
});
