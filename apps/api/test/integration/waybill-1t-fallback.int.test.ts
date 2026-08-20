/**
 * Второй проход накладных промптом формы 1-Т.
 *
 * Действующий промпт накладных распознаёт ровно две формы — ТН-2116 и ОС-2 —
 * и по собственной инструкции обязан игнорировать всё остальное. Форма 1-Т
 * (Госкомстат №78, ОКУД 0345009) в его перечне отсутствует, поэтому боевые
 * товарно-транспортные накладные получали `{"documents": []}`: у документа
 * «Товарно-транспортная накладная № БП-1414» шесть вызовов подряд вернули
 * ноль документов.
 *
 * Здесь проверяется главное свойство правки: первый проход остаётся прежним.
 * Пока он находит документ, второго не существует; пока флаг выключен, второго
 * не существует тоже. И только когда первый вернул пусто, а флаг включён,
 * запускается прицельный разбор своим промптом.
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

// Каждый handleJob в конце публикует SSE-событие, а Redis в тестовой среде нет.
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
vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  getObject: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4\n%%EOF\n')),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  presign: vi.fn().mockResolvedValue('https://s3.example/signed'),
}));

// Флаг второго прохода переключается между кейсами: loadEnv кеширует значение
// на весь процесс, а набору нужно проверить оба состояния.
let fallbackEnabled = false;
// Прицельный маршрут: файл с признаками бланка 1-Т уходит к своему промпту
// СРАЗУ, не тратя вызов на промпт ТН-2116.
let routeEnabled = false;
vi.mock('../../src/lib/env.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/lib/env.js');
  const realLoad = actual.loadEnv as () => Record<string, unknown>;
  return {
    ...actual,
    loadEnv: () => ({
      ...realLoad(),
      WAYBILL_1T_FALLBACK: fallbackEnabled,
      WAYBILL_1T_ROUTE: routeEnabled,
    }),
  };
});

// Детектор формы: в тесте вместо PDF лежит заглушка без текстового слоя,
// поэтому вердикт задаём напрямую — проверяем маршрут, а не разбор PDF.
const detect1t = vi.fn<(buffer: Buffer, mime: string) => Promise<boolean>>();
vi.mock('../../src/domain/edo/waybill-1t-detect.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/edo/waybill-1t-detect.js',
  );
  return { ...actual, detectWaybill1t: (b: Buffer, m: string) => detect1t(b, m) };
});

// Провайдер не openrouter: рендер PDF в PNG для теста не нужен, а предел
// страниц второго прохода проверяется отдельным юнит-тестом waybill-pdf.
vi.mock('../../src/domain/llm/registry.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/domain/llm/registry.js');
  return { ...actual, getDefaultProviderKind: vi.fn().mockResolvedValue('google_ai_studio') };
});

const parseWaybillBatch = vi.fn();
vi.mock('../../src/domain/edo/waybill-batch.parser.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/edo/waybill-batch.parser.js',
  );
  return { ...actual, parseWaybillBatch: (...args: unknown[]) => parseWaybillBatch(...args) };
});
vi.mock('../../src/domain/jobs/job-outbox.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/jobs/job-outbox.js',
  );
  return { ...actual, processJobOutbox: vi.fn().mockResolvedValue({ dispatched: 0, failed: 0 }) };
});

const { handleJob } = await import('../../src/worker.js');

/** Ответ промпта: одна накладная указанной формы. */
function waybill(form: 'tn_2116' | 'tn_1t', docNumber: string) {
  return {
    parsed: {
      documents: [
        {
          form,
          docNumber,
          docDate: '2026-08-18',
          shipper: { inn: '7727447845', name: 'ООО «АРМОДРЕЙН»' },
          consignee: { inn: '7736255508', name: 'ООО «СУ-10»' },
          items: [{ nameRaw: 'Геотекстиль нетканый пэ', qty: 1800, unit: 'м2', sum: 116820 }],
          confidence: 0.9,
        },
      ],
    },
    llmProviderId: null,
  };
}
const empty = { parsed: { documents: [] }, llmProviderId: null };

suite('второй проход накладных: форма 1-Т', () => {
  const db = sql!;
  const siteId = randomUUID();

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name, is_active)
             VALUES (${siteId}, ${'1T'}, 'Объект 1-Т', true)`;
  });

  afterAll(async () => {
    await db`DELETE FROM sites WHERE id = ${siteId}`;
    await db.end({ timeout: 5 });
  });

  beforeEach(() => {
    parseWaybillBatch.mockReset();
    fallbackEnabled = false;
    routeEnabled = false;
    detect1t.mockReset();
    detect1t.mockResolvedValue(false);
  });

  /** Пакет накладных с техзаписью и оригиналом — как его заводит router. */
  async function makeBundle(): Promise<{ bundleId: string; docId: string; s3Key: string }> {
    const bundleId = randomUUID();
    const docId = randomUUID();
    await db`INSERT INTO source_bundles
        (id, site_id, direction, status, bundle_hash, dispatch_generation)
      VALUES (${bundleId}, ${siteId}, 'inbound', 'queued', ${bundleId}, 0)`;
    await db`INSERT INTO source_documents
        (id, kind, is_technical, direction, status, origin, site_id, bundle_id, queued_at)
      VALUES (${docId}, 'transport_waybill', true, 'inbound', 'queued', 'manual_pdf',
              ${siteId}, ${bundleId}, now())`;
    const s3Key = `test/${docId}/ttn.pdf`;
    await db`INSERT INTO source_document_attachments
        (source_document_id, s3_key, filename, mime_type, role)
      VALUES (${docId}, ${s3Key}, 'ttn.pdf', 'application/pdf', 'original')`;
    return { bundleId, docId, s3Key };
  }

  const docsOf = (bundleId: string) =>
    db<{ id: string; kind: string; status: string; doc_number: string | null }[]>`
      SELECT id, kind, status, doc_number FROM source_documents
       WHERE bundle_id = ${bundleId} AND is_technical = false`;

  it('первый проход нашёл ТН-2116 — второго не происходит', async () => {
    const { bundleId } = await makeBundle();
    parseWaybillBatch.mockResolvedValue(waybill('tn_2116', 'ТН-500'));
    fallbackEnabled = true; // даже при включённом флаге

    await handleJob({ id: 'b1', data: { bundleId, bundleGeneration: 0 } } as never);

    // Ровно один вызов: успех первого прохода второй не запускает.
    expect(parseWaybillBatch).toHaveBeenCalledTimes(1);
    const docs = await docsOf(bundleId);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ kind: 'transport_waybill', doc_number: 'ТН-500' });
  });

  it('флаг выключен — пустой ответ идёт прежним путём, второго прохода нет', async () => {
    const { bundleId, docId } = await makeBundle();
    parseWaybillBatch.mockResolvedValue(empty);

    await handleJob({ id: 'b2', data: { bundleId, bundleGeneration: 0 } } as never);

    expect(parseWaybillBatch).toHaveBeenCalledTimes(1);
    // Прежнее поведение: запись становится видимым документом и уходит в общий
    // разбор — это ветка, существовавшая до второго прохода.
    const [row] = await db<{ status: string; is_technical: boolean }[]>`
      SELECT status, is_technical FROM source_documents WHERE id = ${docId}`;
    expect(row).toMatchObject({ status: 'queued', is_technical: false });
  });

  it('флаг включён и первый пуст — 1-Т распознаётся вторым проходом', async () => {
    const { bundleId } = await makeBundle();
    fallbackEnabled = true;
    parseWaybillBatch.mockResolvedValueOnce(empty).mockResolvedValueOnce(waybill('tn_1t', 'БП-1414'));

    await handleJob({ id: 'b3', data: { bundleId, bundleGeneration: 0 } } as never);

    expect(parseWaybillBatch).toHaveBeenCalledTimes(2);
    // Второй вызов идёт СВОИМ промптом, а не общим УПД.
    expect(parseWaybillBatch.mock.calls[1]?.[1]).toMatchObject({
      promptDocKind: 'transport_waybill_1t',
    });

    const docs = await docsOf(bundleId);
    expect(docs).toHaveLength(1);
    // Тип документа прежний — на портале и планшете это «Накладная».
    expect(docs[0]).toMatchObject({
      kind: 'transport_waybill',
      status: 'parsed',
      doc_number: 'БП-1414',
    });

    // Стороны сохранены: у 1-Т они те же внешние, что у 2116.
    const [saved] = await db<{ supplier_inn_raw: string | null; consignee_name_raw: string | null }[]>`
      SELECT supplier_inn_raw, consignee_name_raw FROM source_documents WHERE id = ${docs[0]!.id}`;
    expect(saved?.supplier_inn_raw).toBe('7727447845');
    expect(saved?.consignee_name_raw).toContain('СУ-10');

    const items = await db<{ name_raw: string }[]>`
      SELECT name_raw FROM source_document_items WHERE source_document_id = ${docs[0]!.id}`;
    expect(items).toHaveLength(1);
  });

  it('маршрут включён и бланк опознан — 1-Т разбирается СРАЗУ своим промптом', async () => {
    // Ради этого фаза и делалась: промпт ТН-2116 форму 1-Т игнорировать обязан,
    // но на практике читает её по своим колонкам — в количество попадает графа
    // «Кол-во мест». Вызов чужого промпта больше не тратится.
    const { bundleId } = await makeBundle();
    routeEnabled = true;
    detect1t.mockResolvedValue(true);
    parseWaybillBatch.mockResolvedValue(waybill('tn_1t', '16 674'));

    await handleJob({ id: 'r1', data: { bundleId, bundleGeneration: 0 } } as never);

    expect(parseWaybillBatch).toHaveBeenCalledTimes(1);
    expect(parseWaybillBatch.mock.calls[0]?.[1]).toMatchObject({
      promptDocKind: 'transport_waybill_1t',
    });
    const docs = await docsOf(bundleId);
    expect(docs[0]).toMatchObject({ kind: 'transport_waybill', doc_number: '16 674' });
    // Промпт запомнен: повтор обязан пойти тем же путём, иначе выберет «свой»
    // документ по batch_index из чужого набора.
    const [saved] = await db<{ waybill_prompt_kind: string | null }[]>`
      SELECT waybill_prompt_kind FROM source_documents WHERE id = ${docs[0]!.id}`;
    expect(saved?.waybill_prompt_kind).toBe('transport_waybill_1t');
  });

  it('маршрут выключен — бланк 1-Т идёт прежним путём', async () => {
    const { bundleId } = await makeBundle();
    detect1t.mockResolvedValue(true); // детектор бы сработал…
    parseWaybillBatch.mockResolvedValue(waybill('tn_2116', 'ТН-777'));

    await handleJob({ id: 'r2', data: { bundleId, bundleGeneration: 0 } } as never);

    // …но без рубильника маршрут не меняется: первый вызов активным промптом.
    expect(parseWaybillBatch).toHaveBeenCalledTimes(1);
    expect(parseWaybillBatch.mock.calls[0]?.[1]?.promptDocKind).toBeUndefined();
  });

  it('модель сама назвала форму 1-Т на фото — пакет пере-разбирается её промптом', async () => {
    // Второй триггер: у фотографии текстового слоя нет и детектор молчит, но
    // форму называет сам ответ модели. Боевой случай — ТТН № 16 со снимка.
    const { bundleId } = await makeBundle();
    routeEnabled = true;
    parseWaybillBatch
      .mockResolvedValueOnce(waybill('tn_1t', '16'))
      .mockResolvedValueOnce(waybill('tn_1t', '16'));

    await handleJob({ id: 'r3', data: { bundleId, bundleGeneration: 0 } } as never);

    expect(parseWaybillBatch).toHaveBeenCalledTimes(2);
    expect(parseWaybillBatch.mock.calls[1]?.[1]).toMatchObject({
      promptDocKind: 'transport_waybill_1t',
    });
  });

  it('оба прохода пусты — документ идёт прежним путём, а не теряется', async () => {
    const { bundleId, docId } = await makeBundle();
    fallbackEnabled = true;
    parseWaybillBatch.mockResolvedValue(empty);

    await handleJob({ id: 'b4', data: { bundleId, bundleGeneration: 0 } } as never);

    expect(parseWaybillBatch).toHaveBeenCalledTimes(2);
    const [row] = await db<{ status: string; is_technical: boolean }[]>`
      SELECT status, is_technical FROM source_documents WHERE id = ${docId}`;
    expect(row).toMatchObject({ status: 'queued', is_technical: false });
  });

  /**
   * Уже созданная накладная под кнопкой «Распознать повторно»: строка с
   * dispatch_generation и снимком в reparse — ровно то, что оставляет маршрут
   * перед постановкой задания.
   */
  async function makeReparsedDoc(docNumber: string): Promise<string> {
    const docId = randomUUID();
    await db`INSERT INTO source_documents
        (id, kind, is_technical, direction, status, origin, site_id, doc_number, doc_date,
         parse_mode, batch_index, dispatch_generation, queued_at, reparse)
      VALUES (${docId}, 'transport_waybill', false, 'inbound', 'queued', 'manual_pdf',
              ${siteId}, ${docNumber}, '2026-08-18', 'waybill_batch', 0, 0, now(),
              ${JSON.stringify({ generation: 0, state: 'queued', snapshot: { status: 'parsed' } })}::jsonb)`;
    await db`INSERT INTO source_document_attachments
        (source_document_id, s3_key, filename, mime_type, role)
      VALUES (${docId}, ${`test/${docId}/ttn.pdf`}, 'ttn.pdf', 'application/pdf', 'original')`;
    return docId;
  }

  const reparseJob = (id: string, sourceDocumentId: string) =>
    ({ id, data: { mode: 'waybill_single', sourceDocumentId, docGeneration: 0 } }) as never;

  it('повтор накладной: флаг выключен — пустой ответ откатывает документ как раньше', async () => {
    const docId = await makeReparsedDoc('51160834');
    parseWaybillBatch.mockResolvedValue(empty);

    await handleJob(reparseJob('r1', docId));

    expect(parseWaybillBatch).toHaveBeenCalledTimes(1);
    const [row] = await db<{ status: string; doc_number: string | null; reparse: { state: string } }[]>`
      SELECT status, doc_number, reparse FROM source_documents WHERE id = ${docId}`;
    // Прежнее поведение: сопоставлять не с чем — документ возвращён как был.
    expect(row).toMatchObject({ status: 'parsed', doc_number: '51160834' });
    expect(row?.reparse?.state).toBe('failed');
  });

  it('повтор накладной: флаг включён — 1-Т разбирается вторым проходом', async () => {
    const docId = await makeReparsedDoc('51160834');
    fallbackEnabled = true;
    parseWaybillBatch.mockResolvedValueOnce(empty).mockResolvedValueOnce(waybill('tn_1t', '8462'));

    await handleJob(reparseJob('r2', docId));

    expect(parseWaybillBatch).toHaveBeenCalledTimes(2);
    expect(parseWaybillBatch.mock.calls[1]?.[1]).toMatchObject({
      promptDocKind: 'transport_waybill_1t',
    });
    const [row] = await db<{ status: string; kind: string; doc_number: string | null }[]>`
      SELECT status, kind, doc_number FROM source_documents WHERE id = ${docId}`;
    // Номер из графы «№» заменил код по ОКПО, тип документа не изменился.
    expect(row).toMatchObject({ status: 'parsed', kind: 'transport_waybill', doc_number: '8462' });
    const items = await db<{ name_raw: string }[]>`
      SELECT name_raw FROM source_document_items WHERE source_document_id = ${docId}`;
    expect(items).toHaveLength(1);
  });

  it('сбой второго прохода не отнимает у файла прежний исход', async () => {
    const { bundleId, docId } = await makeBundle();
    fallbackEnabled = true;
    parseWaybillBatch
      .mockResolvedValueOnce(empty)
      .mockRejectedValueOnce(new Error('vision timeout'));

    await handleJob({ id: 'b5', data: { bundleId, bundleGeneration: 0 } } as never);

    const [row] = await db<{ status: string; is_technical: boolean }[]>`
      SELECT status, is_technical FROM source_documents WHERE id = ${docId}`;
    expect(row).toMatchObject({ status: 'queued', is_technical: false });
  });
});
