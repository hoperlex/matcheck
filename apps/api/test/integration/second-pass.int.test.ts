/**
 * Второй проход распознавания: когда заказывается и что делает с документом.
 *
 * Юнит-тесты проверяют функции (dозаполнение сторон, арбитраж результатов), а
 * здесь — поведение воркера целиком: какие документы получают повтор, что
 * попадает в outbox, и главное — что второй проход НЕ разрушает сохранённый
 * разбор, если картинка отработала хуже или упала.
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

// Каждый handleJob в конце публикует SSE-событие, а Redis в тестовой среде нет:
// ioredis честно отрабатывает свои ретраи (~2-3 с на вызов). Сценарии второго
// прохода вызывают обработчик дважды, поэтому дефолтных 5 секунд не хватает.
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
vi.mock('../../src/db/client.js', () => ({ db: drizzle(sql!) }));
vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  getObject: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4\n%%EOF\n')),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  presign: vi.fn().mockResolvedValue('https://s3.example/signed'),
}));

const parseUpdPdf = vi.fn();
vi.mock('../../src/domain/edo/upd-pdf.parser.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/edo/upd-pdf.parser.js',
  );
  return { ...actual, parseUpdPdf: (...args: unknown[]) => parseUpdPdf(...args) };
});
const parseUpdVision = vi.fn();
vi.mock('../../src/domain/edo/upd-vision.parser.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/edo/upd-vision.parser.js',
  );
  return { ...actual, parseUpdVision: (...args: unknown[]) => parseUpdVision(...args) };
});
// Воркер при импорте поднимает периодический consumer outbox (раз в 15 с). Он
// бы вычищал строки, которые проверяет этот набор, — прогон длиннее интервала.
// Глушим только ДОСТАВКУ; запись (enqueueJob) остаётся настоящей.
vi.mock('../../src/domain/jobs/job-outbox.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/jobs/job-outbox.js',
  );
  return { ...actual, processJobOutbox: vi.fn().mockResolvedValue({ dispatched: 0, failed: 0 }) };
});
// Мульти-УПД пути в этом наборе не участвуют: их задача — вернуть null, чтобы
// документ пошёл обычным одиночным разбором.
vi.mock('../../src/domain/edo/upd-text-bundle.parser.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/edo/upd-text-bundle.parser.js',
  );
  return { ...actual, tryParseTextUpdBundle: vi.fn().mockResolvedValue(null) };
});

const { handleJob } = await import('../../src/worker.js');

type ItemInput = { nameRaw: string; qty: number; unit: string; price: number; sum: number };

function parsedResult(over: {
  docNumber?: string | null;
  totalSum?: number | null;
  items?: ItemInput[];
  confidence?: number;
  consigneeName?: string | null;
  consigneeInn?: string | null;
}) {
  const items = over.items ?? [
    { nameRaw: 'Труба стальная', qty: 2, unit: 'шт', price: 100, sum: 200 },
  ];
  return {
    parsed: {
      docNumber: over.docNumber === undefined ? 'UT-100' : over.docNumber,
      docDate: '2026-07-10',
      totalSum: over.totalSum === undefined ? items.reduce((s, i) => s + i.sum, 0) : over.totalSum,
      vatSum: null,
      itemsCount: items.length,
      supplier: { inn: '7722466900', kpp: '772201001', name: 'ООО "Компенсатор"' },
      recipient: { inn: '7736255508', kpp: '773601001', name: 'ООО «СУ-10»' },
      consignee:
        over.consigneeName === undefined
          ? null
          : over.consigneeName === null
            ? null
            : { inn: over.consigneeInn ?? null, kpp: null, name: over.consigneeName },
      items,
      confidence: over.confidence ?? 1,
    },
    textLength: 5000,
    llmProviderId: null,
  };
}

suite('второй проход распознавания (реальный PostgreSQL)', () => {
  const db = sql!;
  const siteId = randomUUID();
  // Грузополучатель с ИНН: воркер нормализует такую сторону в counterparties,
  // поэтому ИНН уникален (таблицу делят все интеграционные наборы), а запись
  // удаляется в cleanup вместе с документами.
  const consigneeInn = `77${String(Date.now()).slice(-8)}`;

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`SPS${Date.now() % 10000}`}, 'Второй проход')`;
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db`DELETE FROM sites WHERE id = ${siteId}`;
    await db.end({ timeout: 5 });
  });

  async function cleanup(): Promise<void> {
    await db`DELETE FROM job_outbox WHERE payload->>'sourceDocumentId' IN (
      SELECT id::text FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_document_items WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await db`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await db`DELETE FROM counterparties WHERE inn = ${consigneeInn}`;
  }

  beforeEach(async () => {
    parseUpdPdf.mockReset();
    parseUpdVision.mockReset();
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

  const job = (docId: string, pass?: 'vision') =>
    ({
      id: pass ? 'j-vision' : 'j-text',
      data: {
        sourceDocumentId: docId,
        s3Key: `test/${docId}/source.pdf`,
        ...(pass ? { pass } : {}),
      },
    }) as never;

  async function docRow(docId: string) {
    const [r] = await db<
      {
        status: string;
        doc_number: string | null;
        total_sum: string | null;
        consignee_name_raw: string | null;
        consignee_inn_raw: string | null;
        parse_error_code: string | null;
        second_pass: {
          state?: string;
          outcome?: string;
          restore?: { status?: string; parseErrorCode?: string | null };
        } | null;
      }[]
    >`SELECT status, doc_number, total_sum, consignee_name_raw, consignee_inn_raw,
             parse_error_code, second_pass
        FROM source_documents WHERE id = ${docId}`;
    return r!;
  }

  async function outboxRows(docId: string) {
    return db<{ dedupe_key: string; payload: { pass?: string } }[]>`
      SELECT dedupe_key, payload FROM job_outbox WHERE payload->>'sourceDocumentId' = ${docId}`;
  }

  async function itemCount(docId: string): Promise<number> {
    const [r] = await db<{ count: string }[]>`
      SELECT count(*) FROM source_document_items WHERE source_document_id = ${docId}`;
    return Number(r!.count);
  }

  it('слабый результат (нет позиций) → второй проход заказан через outbox', async () => {
    const docId = await seedDoc();
    parseUpdPdf.mockResolvedValue(parsedResult({ items: [], totalSum: null }));

    await handleJob(job(docId));

    const r = await docRow(docId);
    expect(r.second_pass?.state).toBe('queued');
    const rows = await outboxRows(docId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.payload.pass).toBe('vision');
    // Ключ адресует документ, а не загрузку: повторная доставка строки outbox
    // не создаст второе задание.
    expect(rows[0]!.dedupe_key).toBe(`doc~${docId}~parse~vision`);
  });

  it('ошибка текстового разбора → документ не падает, а уходит на второй проход', async () => {
    // Оба прод-parse_failed были именно такими: обрыв JSON по лимиту токенов.
    const docId = await seedDoc();
    parseUpdPdf.mockRejectedValue(
      new Error('OpenRouter: JSON.parse failed (likely truncated by max_tokens=16000)'),
    );

    await handleJob(job(docId));

    const r = await docRow(docId);
    expect(r.status).toBe('queued');
    expect(r.second_pass?.state).toBe('queued');
    expect((await outboxRows(docId)).length).toBe(1);
  });

  it('хороший результат → второй проход не заказывается', async () => {
    const docId = await seedDoc();
    parseUpdPdf.mockResolvedValue(parsedResult({}));

    await handleJob(job(docId));

    const r = await docRow(docId);
    expect(r.status).toBe('parsed');
    expect(r.second_pass).toBeNull();
    expect((await outboxRows(docId)).length).toBe(0);
  });

  it('второй проход лучше → данные заменяются, но грузополучатель из текста живёт', async () => {
    const docId = await seedDoc();
    // Первый проход: позиций нет, зато из текста добран грузополучатель.
    parseUpdPdf.mockResolvedValue(
      parsedResult({ items: [], totalSum: null, consigneeName: 'ООО "АЛЬЯНС"' }),
    );
    await handleJob(job(docId));
    expect((await docRow(docId)).consignee_name_raw).toBe('ООО "АЛЬЯНС"');

    // Второй проход: позиции есть, но промпт v8 грузополучателя не возвращает.
    parseUpdVision.mockResolvedValue({
      parsed: parsedResult({ consigneeName: null }).parsed,
      llmProviderId: null,
    });
    await handleJob(job(docId, 'vision'));

    const r = await docRow(docId);
    expect(r.second_pass?.outcome).toBe('replaced');
    expect(r.status).toBe('parsed');
    expect(await itemCount(docId)).toBe(1);
    // Ключевое: слияние сторон сохранило то, что нашёл первый проход.
    expect(r.consignee_name_raw).toBe('ООО "АЛЬЯНС"');
  });

  it('второй проход лучше, но вернул сторону без ИНН → ИНН из первого прохода живёт', async () => {
    // Отдельно от кейса выше: там сторона у победителя ПУСТАЯ и переносится
    // целиком, здесь она непустая (имя есть), и старое правило слияния её не
    // трогало — ИНН, добытый первым проходом, молча пропадал. На экране это
    // выглядело как пустеющая вторая строка ячейки после второго прохода.
    const docId = await seedDoc();
    parseUpdPdf.mockResolvedValue(
      parsedResult({
        items: [],
        totalSum: null,
        consigneeName: 'ООО "АЛЬЯНС"',
        consigneeInn: consigneeInn,
      }),
    );
    await handleJob(job(docId));
    expect((await docRow(docId)).consignee_inn_raw).toBe(consigneeInn);

    // Vision видит имя, но реквизитов не отдаёт — обычное поведение на сканах.
    parseUpdVision.mockResolvedValue({
      parsed: parsedResult({ consigneeName: 'ООО «АЛЬЯНС»' }).parsed,
      llmProviderId: null,
    });
    await handleJob(job(docId, 'vision'));

    const r = await docRow(docId);
    expect(r.second_pass?.outcome).toBe('replaced');
    expect(r.consignee_inn_raw).toBe(consigneeInn);
    // Имя — от победителя: он видел документ последним.
    expect(r.consignee_name_raw).toBe('ООО «АЛЬЯНС»');
  });

  it('второй проход хуже → сохранённый разбор остаётся нетронутым', async () => {
    const docId = await seedDoc();
    parseUpdPdf.mockResolvedValue(
      parsedResult({ confidence: 0.4 }), // слабый по confidence, но с позициями
    );
    await handleJob(job(docId));
    const before = await docRow(docId);
    expect(before.second_pass?.state).toBe('queued');

    // Картинка вернула пустоту — принимать такое нельзя.
    parseUpdVision.mockResolvedValue({
      parsed: parsedResult({ items: [], totalSum: null, docNumber: null }).parsed,
      llmProviderId: null,
    });
    await handleJob(job(docId, 'vision'));

    const r = await docRow(docId);
    expect(r.second_pass?.outcome).toBe('kept_baseline');
    expect(r.doc_number).toBe('UT-100');
    expect(await itemCount(docId)).toBe(1);

    // Главное: документ ВЫШЕЛ из «распознаётся». Перед вторым проходом его
    // перевели в processing, и закрытие попытки обязано вернуть статус — иначе
    // он висит «распознаётся» навсегда: задания больше нет, а сам себя документ
    // оттуда не выведет. На бою так зависли УПД 2851 и 2770/07.
    expect(r.status).not.toBe('processing');
    expect(r.status).toBe(before.second_pass?.restore?.status);
    expect(r.parse_error_code ?? null).toBe(before.second_pass?.restore?.parseErrorCode ?? null);

    // Снимок переживает закрытие попытки: если документ позже всё-таки
    // зависнет, восстановлению будет к чему возвращать.
    expect(r.second_pass?.restore?.status).toBe(before.second_pass?.restore?.status);
  });

  it('второй проход упал → baseline сохранён, документ не parse_failed', async () => {
    const docId = await seedDoc();
    parseUpdPdf.mockResolvedValue(parsedResult({ confidence: 0.4 }));
    await handleJob(job(docId));

    parseUpdVision.mockRejectedValue(new Error('vision provider is down'));
    await handleJob(job(docId, 'vision'));

    const r = await docRow(docId);
    expect(r.second_pass?.outcome).toBe('vision_failed');
    expect(r.status).not.toBe('parse_failed');
    expect(r.doc_number).toBe('UT-100');
    expect(await itemCount(docId)).toBe(1);
  });

  it('повторно слабый результат на втором проходе → третьего задания нет', async () => {
    const docId = await seedDoc();
    parseUpdPdf.mockResolvedValue(parsedResult({ items: [], totalSum: null }));
    await handleJob(job(docId));

    parseUpdVision.mockResolvedValue({
      parsed: parsedResult({ items: [], totalSum: null }).parsed,
      llmProviderId: null,
    });
    await handleJob(job(docId, 'vision'));

    const r = await docRow(docId);
    expect(r.second_pass?.state).toBe('done');
    // Ровно одно задание за всё время: иначе документ, который плохо читается
    // обоими путями, гонял бы повторы по кругу.
    expect((await outboxRows(docId)).length).toBe(1);
  });

  it('слабый дубль тоже получает второй проход', async () => {
    // Решение принимается ДО дедупликации: ветка дубля завершается своим
    // UPDATE и до конца обработчика не доходит.
    const firstId = await seedDoc();
    parseUpdPdf.mockResolvedValue(parsedResult({ docNumber: 'DUP-1' }));
    await handleJob(job(firstId));
    expect((await docRow(firstId)).status).toBe('parsed');

    const secondId = await seedDoc();
    parseUpdPdf.mockResolvedValue(parsedResult({ docNumber: 'DUP-1', items: [], totalSum: null }));
    await handleJob(job(secondId));

    const r = await docRow(secondId);
    expect(r.second_pass?.state).toBe('queued');
    expect((await outboxRows(secondId)).length).toBe(1);
  });
});
