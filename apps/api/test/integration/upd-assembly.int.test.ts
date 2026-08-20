/**
 * Сборка логических УПД: страницы одной УПД становятся ОДНИМ документом.
 *
 * Зачем интеграционные. Всё ценное здесь — про состояние в БД и порядок
 * операций: до публикации документов не должно быть видно, публикация обязана
 * быть атомарной, а любой сбой — разворачиваться в прежнее «файл = документ»
 * без потери файлов. На моках это не воспроизводится: там нет ни манифеста, ни
 * реестра, ни блокировок.
 *
 * Боевой сценарий, ради которого всё писалось: поставщик прислал шесть
 * фотографий одной машины — три УПД, две из которых на двух страницах. Раньше
 * получалось шесть документов, два из них пустые обрубки.
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
vi.mock('../../src/lib/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return {
    ...actual,
    loadEnv: () => ({
      ...actual.loadEnv(),
      UPD_ASSEMBLY_V1: true,
      // Сопоставление строк вместо дедупа по тексту наименования: набор
      // описывает поведение, ради которого рубильник и заводился.
      UPD_ASSEMBLY_COPY_DEDUP_V1: true,
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
const { encryptField, buildAad } = await import('../../src/domain/auth/crypto.js');

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

suite('сборка логических УПД (реальный PostgreSQL)', () => {
  const siteId = randomUUID();
  const db = sql!;

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name)
      VALUES (${siteId}, ${`ASM${Date.now() % 10000}`}, 'Сборка УПД')`;
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

  /** Распознанный УПД — минимальный валидный результат. */
  function updResult(docNumber: string, itemName: string) {
    return {
      parsed: {
        docNumber,
        docDate: '2026-08-01',
        totalSum: 1000,
        vatSum: 200,
        itemsCount: 1,
        supplier: { name: 'ООО Поставщик', inn: '7743429410' },
        recipient: { name: 'ООО СУ-10', inn: '7736255508' },
        items: [{ nameRaw: itemName, qty: 2, unit: 'шт', price: 500, sum: 1000 }],
        confidence: 0.9,
      },
      llmProviderId: null as string | null,
    };
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

  it('шесть фотографий трёх УПД дают три документа, а не шесть', async () => {
    const bundleId = await publicBundle(['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg', '6.jpg']);
    pagesAre(
      'upd_main',
      'upd_continuation',
      'upd_main',
      'upd_continuation',
      'upd_continuation',
      'upd_main',
    );
    extractUpdSegment
      .mockResolvedValueOnce(updResult('1691', 'Арматура 12'))
      .mockResolvedValueOnce(updResult('1736', 'Плита ПК 60'))
      .mockResolvedValueOnce(updResult('1381', 'Цемент М500'));

    await handleDocumentRouterJob(bundleId, log);

    // После router'а видимых документов ещё нет: сборка только запущена.
    const afterRouter = await docsOf();
    expect(afterRouter.filter((d) => !d.is_technical)).toHaveLength(0);

    const [sub] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundleId}`;
    expect(sub).toBeTruthy();

    await handleUpdAssemblyJob(sub!.id, 0, log);
    const segs = await segmentsOf(bundleId);
    expect(segs).toHaveLength(3);
    // Документы сегментов созданы, но наружу не видны.
    const beforePublish = await docsOf();
    expect(beforePublish.filter((d) => !d.is_technical)).toHaveLength(0);

    await runSegmentJobs(bundleId);

    const published = (await docsOf()).filter((d) => !d.is_technical);
    expect(published).toHaveLength(3);
    expect(published.map((d) => d.doc_number).sort()).toEqual(['1381', '1691', '1736']);
  });

  it('повторные страницы одной УПД публикуются одним документом', async () => {
    const bundleId = await publicBundle(['1.jpg', '2.jpg']);
    pagesAre('upd_main', 'upd_main');
    extractUpdSegment.mockResolvedValue(updResult('COPY-1', 'Плита ПК 60'));

    await handleDocumentRouterJob(bundleId, log);
    const [sub] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundleId}`;
    await handleUpdAssemblyJob(sub!.id, 0, log);
    await runSegmentJobs(bundleId);

    const published = (await docsOf()).filter((doc) => !doc.is_technical);
    expect(published).toHaveLength(1);
    const rows = await db<{ name_raw: string }[]>`
      SELECT name_raw FROM source_document_items
       WHERE source_document_id = ${published[0]!.id}
       ORDER BY line_no`;
    expect(rows.map((row) => row.name_raw)).toEqual(['Плита ПК 60']);

    // Исходный второй сегмент не удалён: он скрыт, архивирован и указывает на
    // канонический документ — склейку можно расследовать и откатить вручную.
    const [archived] = await db<
      { is_technical: boolean; status: string; parse_error_details: { mergedInto: string } }[]
    >`SELECT is_technical, status, parse_error_details
        FROM source_documents
       WHERE site_id = ${siteId} AND status = 'archived'`;
    expect(archived).toMatchObject({
      is_technical: true,
      status: 'archived',
      parse_error_details: { mergedInto: published[0]!.id },
    });
  });

  it('экземпляры с расхождениями OCR не задваивают позиции и не удваивают итог', async () => {
    // Боевой случай УПД 201/21127213-2: поставщик отсканировал оба экземпляра,
    // модель прочла тире по-разному («МК-103» и «МК --103»). Прежний дедуп по
    // тексту оставлял обе строки — 4 позиции вместо 2 — а итог документа
    // подменялся их суммой: 18 800 ₽ вместо заявленных 9 400 ₽.
    const bundleId = await publicBundle(['1.jpg', '2.jpg']);
    pagesAre('upd_main', 'upd_main');
    extractUpdSegment
      .mockResolvedValueOnce(updResult('OCR-1', 'Контактор модульный 2НО 20А 230В МК --103'))
      .mockResolvedValueOnce(updResult('OCR-1', 'Контактор модульный 2НО 20А 230В МК-103'));

    await handleDocumentRouterJob(bundleId, log);
    const [sub] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundleId}`;
    await handleUpdAssemblyJob(sub!.id, 0, log);
    await runSegmentJobs(bundleId);

    const published = (await docsOf()).filter((doc) => !doc.is_technical);
    expect(published).toHaveLength(1);
    const rows = await db<{ name_raw: string }[]>`
      SELECT name_raw FROM source_document_items
       WHERE source_document_id = ${published[0]!.id}
       ORDER BY line_no`;
    expect(rows).toHaveLength(1);
    const [header] = await db<{ total_sum: string; status: string }[]>`
      SELECT total_sum, status FROM source_documents WHERE id = ${published[0]!.id}`;
    // Итог остаётся заявленным в шапке, а не суммой задвоенных строк.
    expect(header!.total_sum).toBe('1000.00');
    // Документ по-прежнему доезжает до планшета: расхождение сумм — жёлтая
    // плашка, а не «требует решения».
    expect(header!.status).toBe('parsed');
  });

  it('разные части одной УПД объединяют уникальные позиции', async () => {
    const bundleId = await publicBundle(['1.jpg', '2.jpg']);
    pagesAre('upd_main', 'upd_main');
    extractUpdSegment
      .mockResolvedValueOnce(updResult('PARTS-1', 'Арматура 12'))
      .mockResolvedValueOnce(updResult('PARTS-1', 'Цемент М500'));

    await handleDocumentRouterJob(bundleId, log);
    const [sub] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundleId}`;
    await handleUpdAssemblyJob(sub!.id, 0, log);
    await runSegmentJobs(bundleId);

    const published = (await docsOf()).filter((doc) => !doc.is_technical);
    expect(published).toHaveLength(1);
    const rows = await db<{ name_raw: string; line_no: number }[]>`
      SELECT name_raw, line_no FROM source_document_items
       WHERE source_document_id = ${published[0]!.id}
       ORDER BY line_no`;
    expect(rows.map((row) => row.name_raw)).toEqual(['Арматура 12', 'Цемент М500']);
    const [header] = await db<{ total_sum: string }[]>`
      SELECT total_sum FROM source_documents WHERE id = ${published[0]!.id}`;
    expect(header!.total_sum).toBe('2000.00');
  });

  it('тот же документ из другой загрузки по-прежнему считается дубликатом', async () => {
    pagesAre('upd_main');
    extractUpdSegment.mockResolvedValue(updResult('EXTERNAL-DUP', 'Балка'));

    const firstBundle = await publicBundle(['first.jpg']);
    await handleDocumentRouterJob(firstBundle, log);
    const [firstSub] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${firstBundle}`;
    await handleUpdAssemblyJob(firstSub!.id, 0, log);
    await runSegmentJobs(firstBundle);

    const secondBundle = await publicBundle(['second.jpg']);
    await handleDocumentRouterJob(secondBundle, log);
    const [secondSub] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${secondBundle}`;
    await handleUpdAssemblyJob(secondSub!.id, 0, log);
    await runSegmentJobs(secondBundle);

    const visible = await db<{ status: string; parse_error_code: string | null }[]>`
      SELECT status, parse_error_code FROM source_documents
       WHERE site_id = ${siteId} AND is_technical = false
       ORDER BY created_at`;
    expect(visible).toHaveLength(2);
    expect(visible.some((doc) => doc.parse_error_code === 'duplicate_upd')).toBe(true);
  });

  it('до последнего сегмента наружу не виден ни один документ', async () => {
    const bundleId = await publicBundle(['1.jpg', '2.jpg']);
    pagesAre('upd_main', 'upd_main');
    extractUpdSegment
      .mockResolvedValueOnce(updResult('500', 'Труба'))
      .mockResolvedValueOnce(updResult('501', 'Швеллер'));

    await handleDocumentRouterJob(bundleId, log);
    const [sub] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundleId}`;
    await handleUpdAssemblyJob(sub!.id, 0, log);

    // Распознаём ТОЛЬКО первый сегмент.
    const segs = await segmentsOf(bundleId);
    await handleJob({
      id: 'seg-0',
      data: {
        sourceDocumentId: segs[0]!.source_document_id!,
        segmentId: segs[0]!.id,
        generation: 0,
      },
    } as never);

    const visible = (await docsOf()).filter((d) => !d.is_technical);
    expect(visible).toHaveLength(0);

    // Второй сегмент закрывает комплект — публикуются оба разом.
    await handleJob({
      id: 'seg-1',
      data: {
        sourceDocumentId: segs[1]!.source_document_id!,
        segmentId: segs[1]!.id,
        generation: 0,
      },
    } as never);
    expect((await docsOf()).filter((d) => !d.is_technical)).toHaveLength(2);
  });

  it('публикация проставляет поколение и не бампает ревизию дважды', async () => {
    const bundleId = await publicBundle(['1.jpg']);
    pagesAre('upd_main');
    extractUpdSegment.mockResolvedValue(updResult('777', 'Балка'));

    await handleDocumentRouterJob(bundleId, log);
    const [sub] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundleId}`;
    await handleUpdAssemblyJob(sub!.id, 0, log);
    await runSegmentJobs(bundleId);

    const [root] = await db<
      { assembly_version: string; published_generation: number | null; group_revision: number }[]
    >`SELECT assembly_version, published_generation, group_revision
        FROM source_bundles WHERE id = ${bundleId}`;
    expect(root).toMatchObject({ assembly_version: 'logical_v1', published_generation: 0 });
    const revisionAfterPublish = root!.group_revision;

    // Повторный прогон сегмента: комплект уже опубликован, финализатор обязан
    // выйти no-op, иначе ревизия росла бы на каждом лишнем вызове.
    await runSegmentJobs(bundleId);
    const [again] = await db<{ group_revision: number }[]>`
      SELECT group_revision FROM source_bundles WHERE id = ${bundleId}`;
    expect(again!.group_revision).toBe(revisionAfterPublish);
  });

  it('повторный запуск сборки не создаёт второй комплект', async () => {
    const bundleId = await publicBundle(['1.jpg', '2.jpg']);
    pagesAre('upd_main', 'upd_main');
    extractUpdSegment.mockResolvedValue(updResult('900', 'Швеллер'));

    await handleDocumentRouterJob(bundleId, log);
    const [sub] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundleId}`;
    await handleUpdAssemblyJob(sub!.id, 0, log);
    await handleUpdAssemblyJob(sub!.id, 0, log);

    expect(await segmentsOf(bundleId)).toHaveLength(2);
    // Классификация вызвана один раз: манифест поколения уже есть, и повторный
    // LLM-вызов дал бы другую нарезку.
    expect(classifyPages).toHaveBeenCalledTimes(1);
    const technicalDocs = (await docsOf()).filter((d) => d.is_technical);
    // Служебная запись пакета + по одному документу на сегмент.
    expect(technicalDocs).toHaveLength(3);
  });

  it('повторный router не заводит второй дочерний пакет', async () => {
    const bundleId = await publicBundle(['1.jpg']);
    pagesAre('upd_main');
    await handleDocumentRouterJob(bundleId, log);
    await handleDocumentRouterJob(bundleId, log);

    const subs = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundleId}`;
    expect(subs).toHaveLength(1);
  });

  it('оборот документа («other» при распознанной шапке) сборку не отменяет', async () => {
    // Боевой случай: у каждой УПД есть оборот с подписями, классификатор
    // относит его к «other». Границы документов определены по шапкам, поэтому
    // машина должна собраться, а не развалиться на отдельные файлы. До правки
    // это была самая частая причина отката: 18 из 52 за месяц.
    const bundleId = await publicBundle(['1.jpg', '2.jpg', '3.jpg']);
    pagesAre('upd_main', 'other', 'upd_main');

    await handleDocumentRouterJob(bundleId, log);
    const [subOk] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundleId}`;
    await handleUpdAssemblyJob(subOk!.id, 0, log);

    // Два сегмента: страницы 1-2 (шапка + оборот) и страница 3. Манифест на
    // месте — значит нарезке доверились и пакет пошёл путём машины.
    // (`logical_v1` проставит публикация, когда сегменты будут разобраны.)
    const segments = await segmentsOf(bundleId);
    expect(segments).toHaveLength(2);
    const [rootOk] = await db<{ parse_error_message: string | null }[]>`
      SELECT parse_error_message FROM source_bundles WHERE id = ${bundleId}`;
    expect(rootOk!.parse_error_message).toBeNull();
    // У каждого сегмента появился свой документ, и оба технические — наружу
    // до публикации они не видны. Считаем именно по манифесту: в дочернем
    // пакете лежит ещё и служебная запись router'а.
    expect(segments.every((seg) => seg.source_document_id != null)).toBe(true);
    const segmentDocIds = segments.map((seg) => seg.source_document_id);
    const created = (await docsOf()).filter((d) => segmentDocIds.includes(d.id));
    expect(created).toHaveLength(2);
    expect(created.every((d) => d.is_technical)).toBe(true);
  });

  it('сегмент без шапки по-прежнему откатывает пакет на «файл = документ»', async () => {
    const bundleId = await publicBundle(['1.jpg', '2.jpg']);
    // Ни одной страницы `upd_main`: продолжение без начала — границы
    // документов неизвестны, доверять нарезке нельзя.
    pagesAre('upd_continuation', 'upd_continuation');

    await handleDocumentRouterJob(bundleId, log);
    const [sub] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundleId}`;
    await handleUpdAssemblyJob(sub!.id, 0, log);

    const docs = await docsOf();
    const real = docs.filter((d) => !d.is_technical);
    // Файл = документ: два файла → два документа, оба видимы и ждут разбора.
    expect(real).toHaveLength(2);
    expect(real.every((d) => d.status === 'queued')).toBe(true);
    // Манифест снят, поколение не опубликовано, сборка помечена legacy.
    expect(await segmentsOf(bundleId)).toHaveLength(0);
    const [root] = await db<
      {
        assembly_version: string;
        published_generation: number | null;
        parse_error_message: string | null;
        status: string;
      }[]
    >`SELECT assembly_version, published_generation, parse_error_message, status
        FROM source_bundles WHERE id = ${bundleId}`;
    expect(root).toMatchObject({ assembly_version: 'legacy', published_generation: null });
    expect(root!.parse_error_message).toContain('сборка УПД отменена');
    // Пакет обязан выйти из processing. Раньше откат его там и оставлял: до
    // терминала пакет доводила только публикация, а repairStuckJobs смотрит
    // лишь на `queued`. По бою так зависли 7 пакетов — ровно все откаты.
    expect(root!.status).toBe('parsed');
    // Технических документов у дочернего пакета не осталось.
    const techInSub = docs.filter((d) => d.is_technical && d.bundle_id === sub!.id);
    expect(techInSub).toHaveLength(0);
    const evidence = await db<
      {
        evidence_type: string;
        payload: { pageMap?: unknown[]; reason?: string };
      }[]
    >`
      SELECT evidence_type, payload
        FROM recognition_evidence_events
       WHERE bundle_id = ${bundleId}
       ORDER BY created_at`;
    expect(evidence.map((e) => e.evidence_type)).toEqual([
      'file_classification',
      'file_classification',
      'page_classification',
      'assembly_rollback',
    ]);
    expect(
      evidence.find((e) => e.evidence_type === 'page_classification')!.payload.pageMap,
    ).toHaveLength(2);
    expect(evidence.find((e) => e.evidence_type === 'assembly_rollback')!.payload.reason).toContain(
      'нарезке нельзя доверять',
    );
  });

  it('страница, пропущенная классификатором, не теряется — пакет откатывается', async () => {
    const bundleId = await publicBundle(['1.jpg', '2.jpg', '3.jpg']);
    // Модель ответила только про 1 и 3: страница 2 в JSON отсутствует.
    classifyPages.mockResolvedValue({
      classification: [
        { page: 1, type: 'upd_main', use: true },
        { page: 3, type: 'upd_main', use: true },
      ],
      raw: '{}',
      promptTokens: 10,
      completionTokens: 10,
    });

    await handleDocumentRouterJob(bundleId, log);
    const [sub] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundleId}`;
    await handleUpdAssemblyJob(sub!.id, 0, log);

    const real = (await docsOf()).filter((d) => !d.is_technical);
    expect(real).toHaveLength(3); // все три файла на месте
    expect(await segmentsOf(bundleId)).toHaveLength(0);
  });

  it('провал сегмента откатывает весь комплект', async () => {
    const bundleId = await publicBundle(['1.jpg', '2.jpg']);
    pagesAre('upd_main', 'upd_main');
    extractUpdSegment
      .mockResolvedValueOnce(updResult('111', 'Кирпич'))
      // Второй сегмент распознался пустым — partial_parse.
      .mockResolvedValueOnce({
        parsed: {
          docNumber: null,
          docDate: null,
          totalSum: null,
          vatSum: null,
          itemsCount: null,
          supplier: null,
          recipient: null,
          items: [],
          confidence: 0.1,
        },
        llmProviderId: null,
      });

    await handleDocumentRouterJob(bundleId, log);
    const [sub] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundleId}`;
    await handleUpdAssemblyJob(sub!.id, 0, log);
    await runSegmentJobs(bundleId);

    const real = (await docsOf()).filter((d) => !d.is_technical);
    expect(real).toHaveLength(2);
    expect(real.every((d) => d.status === 'queued')).toBe(true);
    const [root] = await db<{ published_generation: number | null }[]>`
      SELECT published_generation FROM source_bundles WHERE id = ${bundleId}`;
    expect(root!.published_generation).toBeNull();
  });

  it('реестр закрывается только после публикации', async () => {
    const bundleId = await publicBundle(['1.jpg']);
    pagesAre('upd_main');
    extractUpdSegment.mockResolvedValue(updResult('222', 'Профиль'));

    await handleDocumentRouterJob(bundleId, log);
    const midway = await db<{ status: string; effective_status: string | null }[]>`
      SELECT status, effective_status FROM bundle_import_items WHERE bundle_id = ${bundleId}`;
    // Файл принят и передан в сборку, но исход ещё не известен.
    expect(midway[0]).toMatchObject({ status: 'created', effective_status: null });

    const [sub] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundleId}`;
    await handleUpdAssemblyJob(sub!.id, 0, log);
    await runSegmentJobs(bundleId);

    const closed = await db<{ effective_status: string | null; created_document_ids: string[] }[]>`
      SELECT effective_status, created_document_ids FROM bundle_import_items
       WHERE bundle_id = ${bundleId}`;
    expect(closed[0]!.effective_status).toBe('created');
    expect(closed[0]!.created_document_ids).toHaveLength(1);
  });

  it('устаревшее поколение не трогает опубликованный комплект', async () => {
    const bundleId = await publicBundle(['1.jpg']);
    pagesAre('upd_main');
    extractUpdSegment.mockResolvedValue(updResult('333', 'Уголок'));

    await handleDocumentRouterJob(bundleId, log);
    const [sub] = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundleId}`;
    await handleUpdAssemblyJob(sub!.id, 0, log);
    const segs = await segmentsOf(bundleId);
    await runSegmentJobs(bundleId);

    extractUpdSegment.mockClear();
    // Задание того же сегмента, дождавшееся очереди после публикации.
    await handleJob({
      id: 'late',
      data: {
        sourceDocumentId: segs[0]!.source_document_id!,
        segmentId: segs[0]!.id,
        generation: 0,
      },
    } as never);
    // Ни одного повторного распознавания: fencing увидел снятый isTechnical.
    expect(extractUpdSegment).not.toHaveBeenCalled();
  });

  it('исходящий пакет и непубличная загрузка идут прежним путём', async () => {
    // Тот же набор файлов, но без записи о публичном канале.
    const hash = createHash('sha256').update(randomUUID()).digest('hex');
    const [bundle] = await db<{ id: string }[]>`
      INSERT INTO source_bundles (bundle_hash, kind, direction, site_id, status, origin)
      VALUES (${hash}, 'mixed', 'inbound', ${siteId}, 'queued', 'manual_pdf')
      RETURNING id`;
    const [tech] = await db<{ id: string }[]>`
      INSERT INTO source_documents
        (kind, is_technical, direction, origin, status, site_id, bundle_id, queued_at)
      VALUES ('upd', true, 'inbound', 'manual_pdf', 'queued', ${siteId}, ${bundle!.id}, now())
      RETURNING id`;
    const key = `upload/${bundle!.id}/x.jpg`;
    await db`INSERT INTO source_document_attachments
        (source_document_id, s3_key, filename, mime_type, size_bytes, role)
      VALUES (${tech!.id}, ${key}, 'x.jpg', 'image/jpeg', 1000, 'original')`;
    await db`INSERT INTO bundle_import_items
        (bundle_id, source_filename, input_s3_key, mime_type, size_bytes,
         upload_generation, input_order, processing_mode, status)
      VALUES (${bundle!.id}, 'x.jpg', ${key}, 'image/jpeg', 1000, 0, 0, 'auto', 'accepted')`;

    await handleDocumentRouterJob(bundle!.id, log);

    const subs = await db<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE parent_bundle_id = ${bundle!.id}`;
    expect(subs).toHaveLength(0);
    expect((await docsOf()).filter((d) => !d.is_technical)).toHaveLength(1);
  });
});
