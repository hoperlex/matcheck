/**
 * Границы сохранения сторон документа: что реально оказывается в БД после
 * разбора.
 *
 * Парсеры проверяются отдельно (upd-pdf-local.parser.test.ts) и знают только
 * «что распозналось». Здесь проверяется следующий шаг — какие колонки записал
 * воркер, и он ловит ровно те ошибки, которые парсерные тесты пропускают:
 *   * сторону без ИНН нельзя связать с counterparties (inn NOT NULL), поэтому
 *     имя обязано лечь в *_name_raw, а FK остаться пустым;
 *   * ветка дубликата (duplicate_upd) — отдельный терминальный UPDATE, до
 *     записи шапки выполнение не доходит, и новые поля туда легко забыть;
 *   * у накладных ТН-2116 грузополучатель должен попасть в consignee_id, а
 *     recipient_id (операционный получатель отгрузки) остаться пустым.
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

const sql = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 4 }) : null;

// Воркер при импорте поднимает BullMQ и Sentry — подменяем всё, что лезет
// наружу. База настоящая: проверяются именно записи, которые он создаёт.
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

// Распознавание замокано: тест про запись в БД, а не про качество разбора.
const parseUpdPdf = vi.fn();
vi.mock('../../src/domain/edo/upd-pdf.parser.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/edo/upd-pdf.parser.js',
  );
  return { ...actual, parseUpdPdf: (...args: unknown[]) => parseUpdPdf(...args) };
});
const parseWaybillBatch = vi.fn();
vi.mock('../../src/domain/edo/waybill-batch.parser.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/edo/waybill-batch.parser.js',
  );
  return { ...actual, parseWaybillBatch: (...args: unknown[]) => parseWaybillBatch(...args) };
});

const { handleJob } = await import('../../src/worker.js');

type ParsedParty = { inn: string | null; kpp: string | null; name: string | null };

function parsedUpd(over: {
  docNumber?: string;
  recipient?: ParsedParty | null;
  consignee?: ParsedParty | null;
}) {
  return {
    parsed: {
      docNumber: over.docNumber ?? '18266',
      docDate: '2026-07-10',
      totalSum: 597341,
      vatSum: 99556.83,
      itemsCount: 1,
      supplier: { inn: '5001120691', kpp: '500101001', name: 'ООО "АРХЕТИП"' },
      recipient:
        over.recipient === undefined
          ? { inn: '7736255508', kpp: '774550001', name: 'ООО «СУ-10»' }
          : over.recipient,
      consignee: over.consignee ?? null,
      items: [
        {
          nameRaw: 'Керамический Гранит Atlas Concorde',
          qty: 280,
          unit: 'шт',
          price: 1777.8,
          sum: 597341,
          vatRate: 20,
          vatSum: 99556.83,
        },
      ],
      confidence: 0.95,
    },
    textLength: 5000,
    llmProviderId: null,
  };
}

suite('стороны документа: что записывает воркер (реальный PostgreSQL)', () => {
  const db = sql!;
  const siteId = randomUUID();
  const bundleIds: string[] = [];

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`PRT${Date.now() % 10000}`}, 'Стороны')`;
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db`DELETE FROM sites WHERE id = ${siteId}`;
    await db.end({ timeout: 5 });
  });

  async function cleanup(): Promise<void> {
    await db`DELETE FROM source_document_items WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_document_attachments WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await db`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  }

  beforeEach(async () => {
    parseUpdPdf.mockReset();
    parseWaybillBatch.mockReset();
    await cleanup();
    bundleIds.length = 0;
  });

  /** Документ УПД в очереди + пакет, как их создаёт загрузка. */
  async function seedUpd(): Promise<string> {
    const bundleId = randomUUID();
    const docId = randomUUID();
    bundleIds.push(bundleId);
    await db`INSERT INTO source_bundles (id, site_id, direction, status, bundle_hash, doc_count)
             VALUES (${bundleId}, ${siteId}, 'inbound', 'queued', ${bundleId}, 1)`;
    await db`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, bundle_id)
             VALUES (${docId}, 'upd', 'inbound', 'queued', 'manual_pdf', ${siteId}, ${bundleId})`;
    return docId;
  }

  async function row(docId: string) {
    const [r] = await db<
      {
        status: string;
        parse_error_code: string | null;
        buyer_id: string | null;
        buyer_name_raw: string | null;
        consignee_id: string | null;
        consignee_name_raw: string | null;
        recipient_id: string | null;
        contractor_id: string | null;
      }[]
    >`SELECT status, parse_error_code, buyer_id, buyer_name_raw, consignee_id,
             consignee_name_raw, recipient_id, contractor_id
        FROM source_documents WHERE id = ${docId}`;
    return r!;
  }

  const job = (docId: string) =>
    ({ id: 'j1', data: { sourceDocumentId: docId, s3Key: `test/${docId}/source.pdf` } }) as never;

  it('грузополучатель без ИНН: имя сохранено, FK пустой', async () => {
    // Главный случай: графу 4 печатают без ИНН, а counterparties.inn NOT NULL.
    // Раньше такая сторона просто исчезала бы.
    const docId = await seedUpd();
    parseUpdPdf.mockResolvedValue(
      parsedUpd({ consignee: { inn: null, kpp: null, name: 'ООО «АЛЬЯНС»' } }),
    );

    await handleJob(job(docId));

    const r = await row(docId);
    expect(r.status).toBe('parsed');
    expect(r.consignee_name_raw).toBe('ООО «АЛЬЯНС»');
    expect(r.consignee_id).toBeNull();
  });

  it('грузополучатель с ИНН: заводится контрагент, но НЕ подрядчик', async () => {
    const docId = await seedUpd();
    parseUpdPdf.mockResolvedValue(
      parsedUpd({
        consignee: { inn: '7725494913', kpp: null, name: 'ООО "ФСК Инжиниринг"' },
      }),
    );

    await handleJob(job(docId));

    const r = await row(docId);
    expect(r.consignee_id).not.toBeNull();
    expect(r.consignee_name_raw).toBe('ООО "ФСК Инжиниринг"');
    // Роль customer: список подрядчиков наполняют люди, а не распознавание.
    const [cp] = await db<{ is_contractor: boolean; is_customer: boolean }[]>`
      SELECT is_contractor, is_customer FROM counterparties WHERE id = ${r.consignee_id!}`;
    expect(cp!.is_contractor).toBe(false);
    expect(cp!.is_customer).toBe(true);
  });

  it('покупатель пишется в buyer_*, contractor_id не трогается', async () => {
    const docId = await seedUpd();
    parseUpdPdf.mockResolvedValue(parsedUpd({}));

    await handleJob(job(docId));

    const r = await row(docId);
    expect(r.buyer_name_raw).toBe('ООО «СУ-10»');
    expect(r.buyer_id).not.toBeNull();
    // recipient_id остаётся заполненным для обратной совместимости, а
    // contractor_id — поле оператора, распознавание его не назначает.
    expect(r.recipient_id).toBe(r.buyer_id);
    expect(r.contractor_id).toBeNull();
  });

  it('дубликат: стороны сохраняются, хотя ветка — отдельный UPDATE', async () => {
    // Первый документ занимает пару (поставщик, номер, дата).
    const firstId = await seedUpd();
    parseUpdPdf.mockResolvedValue(parsedUpd({}));
    await handleJob(job(firstId));
    expect((await row(firstId)).status).toBe('parsed');

    // Второй с тем же номером и датой — уйдёт в ветку duplicate_upd.
    const secondId = await seedUpd();
    parseUpdPdf.mockResolvedValue(
      parsedUpd({ consignee: { inn: null, kpp: null, name: 'ООО «АЛЬЯНС»' } }),
    );
    await handleJob(job(secondId));

    const r = await row(secondId);
    expect(r.parse_error_code).toBe('duplicate_upd');
    expect(r.status).toBe('needs_resolution');
    expect(r.buyer_name_raw).toBe('ООО «СУ-10»');
    expect(r.consignee_name_raw).toBe('ООО «АЛЬЯНС»');
  });

  it('ТН-2116: грузополучатель в consignee_id, recipient_id пуст', async () => {
    const bundleId = randomUUID();
    const techId = randomUUID();
    bundleIds.push(bundleId);
    await db`INSERT INTO source_bundles (id, site_id, direction, status, bundle_hash, doc_count)
             VALUES (${bundleId}, ${siteId}, 'inbound', 'queued', ${bundleId}, 1)`;
    await db`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, bundle_id, is_technical)
             VALUES (${techId}, 'transport_waybill', 'inbound', 'queued', 'manual_pdf', ${siteId}, ${bundleId}, true)`;
    await db`INSERT INTO source_document_attachments (source_document_id, s3_key, filename, mime_type, size_bytes)
             VALUES (${techId}, ${`test/${techId}/tn.pdf`}, 'tn.pdf', 'application/pdf', 1000)`;

    parseWaybillBatch.mockResolvedValue({
      parsed: {
        documents: [
          {
            form: 'tn_2116',
            docNumber: '297',
            docDate: '2026-08-05',
            shipper: { inn: '5001120691', name: 'ООО «АЛЮПРОМ»' },
            consignee: { inn: '7736255508', name: 'ООО «СУ-10»' },
            items: [{ nameRaw: 'Профиль', qty: 10, unit: 'шт' }],
            confidence: 0.9,
          },
        ],
      },
      llmProviderId: null,
    });

    await handleJob({ id: 'j2', data: { bundleId } } as never);

    const [doc] = await db<
      {
        id: string;
        consignee_id: string | null;
        consignee_name_raw: string | null;
        recipient_id: string | null;
      }[]
    >`SELECT id, consignee_id, consignee_name_raw, recipient_id
        FROM source_documents
       WHERE bundle_id = ${bundleId} AND is_technical = false`;
    expect(doc).toBeTruthy();
    expect(doc!.consignee_name_raw).toBe('ООО «СУ-10»');
    expect(doc!.consignee_id).not.toBeNull();
    // Ключевое: получатель отгрузки остаётся незанятым — раньше грузополучатель
    // ТН писался именно туда и подменял бы колонку «Покупатель».
    expect(doc!.recipient_id).toBeNull();
  });

  /**
   * Гард справочника: что попадает в counterparties, а что нет.
   *
   * Порядок «поиск → нормализованный поиск → гард на создание» проверяется
   * именно здесь, потому что первая его ступень существует ради данных,
   * которых в свежей БД нет — исторических записей с невалидным ИНН.
   */
  describe('гард справочника контрагентов', () => {
    const INVALID_LEGACY_INN = '7736255608'; // перестановка цифр, есть в проде
    // Валидные ИНН, которых заведомо нет в справочнике: гард проверяется на
    // ветке СОЗДАНИЯ, а она достижима только когда поиск ничего не нашёл.
    // Если взять ИНН уже существующей записи (например «СУ-10»), первый же шаг
    // вернёт её id — и это правильное поведение, но не то, что здесь проверяем.
    const FREE_VALID_INN = '7712345671';
    const FREE_VALID_INN_2 = '7801122331';
    const createdInns: string[] = [];

    async function countByInn(inn: string): Promise<number> {
      const [r] = await db<{ n: string }[]>`
        SELECT count(*)::text AS n FROM counterparties WHERE inn = ${inn}`;
      return Number(r!.n);
    }

    /**
     * Заводит запись справочника идемпотентно и возвращает её id.
     *
     * Простой INSERT здесь ломается: vitest гоняет интеграционные файлы
     * параллельно, `counterparties.inn` уникален, и соседний набор может занять
     * тот же ИНН между beforeEach и вставкой. Тест про поведение гарда, а не
     * про то, кто успел первым.
     */
    async function ensureCounterparty(inn: string, name: string): Promise<string> {
      // Уникальность у справочника частичная: `(inn) WHERE kpp IS NULL` и
      // `(inn, kpp) WHERE kpp IS NOT NULL`. Записи заводим без КПП, поэтому и
      // условие в ON CONFLICT — то же самое, иначе Postgres не находит индекс.
      const [row] = await db<{ id: string }[]>`
        INSERT INTO counterparties (id, inn, kpp, name, is_customer)
        VALUES (${randomUUID()}, ${inn}, NULL, ${name}, true)
        ON CONFLICT (inn) WHERE kpp IS NULL DO UPDATE SET name = counterparties.name
        RETURNING id`;
      return row!.id;
    }

    beforeEach(async () => {
      for (const inn of createdInns) await db`DELETE FROM counterparties WHERE inn = ${inn}`;
      createdInns.length = 0;
    });

    afterAll(async () => {
      for (const inn of createdInns) await db`DELETE FROM counterparties WHERE inn = ${inn}`;
    });

    it('существующая запись с НЕвалидным ИНН по-прежнему находится', async () => {
      // Ради этого гард стоит ПОСЛЕ поиска, а не до него: иначе документы
      // перестали бы привязываться к тому, к чему привязывались раньше, и
      // защита справочника сама стала бы регрессом.
      createdInns.push(INVALID_LEGACY_INN);
      const legacyId = await ensureCounterparty(INVALID_LEGACY_INN, 'ООО «СУ-10» (старая запись)');

      const docId = await seedUpd();
      parseUpdPdf.mockResolvedValue(
        parsedUpd({ consignee: { inn: INVALID_LEGACY_INN, kpp: null, name: 'ООО «СУ-10»' } }),
      );
      await handleJob(job(docId));

      const r = await row(docId);
      expect(r.consignee_id).toBe(legacyId);
      expect(await countByInn(INVALID_LEGACY_INN)).toBe(1);
    }, 30_000);

    it('новый невалидный ИНН: контрагент не создаётся, распознанное сохранено', async () => {
      const docId = await seedUpd();
      parseUpdPdf.mockResolvedValue(
        parsedUpd({ consignee: { inn: '127018', kpp: null, name: 'ООО «АЛЬЯНС»' } }),
      );
      await handleJob(job(docId));

      const r = await row(docId);
      expect(r.consignee_id).toBeNull();
      // Данные не теряются: и имя, и сырой ИНН на месте — карточка покажет,
      // что распозналось, просто без ссылки на справочник.
      expect(r.consignee_name_raw).toBe('ООО «АЛЬЯНС»');
      const [raw] = await db<{ consignee_inn_raw: string | null }[]>`
        SELECT consignee_inn_raw FROM source_documents WHERE id = ${docId}`;
      expect(raw!.consignee_inn_raw).toBe('127018');
      expect(await countByInn('127018')).toBe(0);
    }, 30_000);

    it('имя-обрывок графы не заводит контрагента даже с валидным ИНН', async () => {
      createdInns.push(FREE_VALID_INN);
      const docId = await seedUpd();
      parseUpdPdf.mockResolvedValue(
        parsedUpd({ consignee: { inn: FREE_VALID_INN, kpp: null, name: 'и его адрес:' } }),
      );
      await handleJob(job(docId));

      const r = await row(docId);
      expect(r.consignee_id).toBeNull();
      expect(r.consignee_name_raw).toBe('и его адрес:');
      expect(await countByInn(FREE_VALID_INN)).toBe(0);
    }, 30_000);

    it('валидный ИНН с пробелами находит каноническую запись, а не создаёт вторую', async () => {
      createdInns.push(FREE_VALID_INN_2);
      const canonicalId = await ensureCounterparty(FREE_VALID_INN_2, 'ООО «Канонический»');

      const docId = await seedUpd();
      const spaced = `${FREE_VALID_INN_2.slice(0, 4)} ${FREE_VALID_INN_2.slice(4)}`;
      parseUpdPdf.mockResolvedValue(
        parsedUpd({ consignee: { inn: spaced, kpp: null, name: 'ООО «Канонический»' } }),
      );
      await handleJob(job(docId));

      const r = await row(docId);
      expect(r.consignee_id).toBe(canonicalId);
      expect(await countByInn(FREE_VALID_INN_2)).toBe(1);
    }, 30_000);

    it('валидный ИНН без записи в справочнике: поведение прежнее — контрагент создаётся', async () => {
      // Анти-регресс основной ветки: гард не должен мешать нормальному случаю.
      const freshInn = '5010123459';
      createdInns.push(freshInn);
      const docId = await seedUpd();
      parseUpdPdf.mockResolvedValue(
        parsedUpd({
          consignee: { inn: freshInn, kpp: '772501001', name: 'ООО "ФСК Инжиниринг"' },
        }),
      );
      await handleJob(job(docId));

      const r = await row(docId);
      expect(r.consignee_id).not.toBeNull();
      expect(await countByInn(freshInn)).toBe(1);
    }, 30_000);
  });

  /**
   * Реквизиты грузополучателя, скопированные моделью у покупателя.
   *
   * Воспроизводится боевой случай 14.08: промпт v9 вернул «ООО «АЛЬЯНС»» с ИНН
   * и КПП компании «СУ-10». Проверяется, что до БД такие реквизиты не доходят —
   * иначе документ показывает чужой ИНН и связывается с чужой организацией.
   */
  describe('реквизиты грузополучателя, скопированные у покупателя', () => {
    it('другое имя при ИНН покупателя: ИНН и связь не сохраняются, имя остаётся', async () => {
      const docId = await seedUpd();
      parseUpdPdf.mockResolvedValue(
        parsedUpd({
          // parsedUpd по умолчанию кладёт покупателя ООО «СУ-10» с этим же ИНН.
          consignee: { inn: '7736255508', kpp: '774550001', name: 'ООО «АЛЬЯНС»' },
        }),
      );

      await handleJob(job(docId));

      const r = await row(docId);
      expect(r.consignee_name_raw).toBe('ООО «АЛЬЯНС»');
      expect(r.consignee_id).toBeNull();
      const [raw] = await db<{ consignee_inn_raw: string | null }[]>`
        SELECT consignee_inn_raw FROM source_documents WHERE id = ${docId}`;
      expect(raw!.consignee_inn_raw).toBeNull();
      // Покупателя правило не касается — его реквизиты на месте.
      expect(r.buyer_id).not.toBeNull();
    }, 30_000);

    it('имя с адресом: в БД только наименование, реквизиты отброшены', async () => {
      // Боевой случай AA1708-0018: графу 4 печатают как «ООО "СУ-10", 127018,
      // Город Москва, …», и vision возвращает строку целиком. Адрес режется
      // ПОСЛЕ проверки реквизитов — иначе имена совпали бы и выдуманный ИНН
      // сохранился бы как «свой».
      const docId = await seedUpd();
      parseUpdPdf.mockResolvedValue(
        parsedUpd({
          consignee: {
            inn: '7736255508',
            kpp: '774550001',
            name: 'ООО «СУ-10», 127018, Город Москва, ул Полковая, дом 3',
          },
        }),
      );

      await handleJob(job(docId));

      const r = await row(docId);
      expect(r.consignee_name_raw).toBe('ООО «СУ-10»');
      expect(r.consignee_id).toBeNull();
      const [raw] = await db<{ consignee_inn_raw: string | null }[]>`
        SELECT consignee_inn_raw FROM source_documents WHERE id = ${docId}`;
      expect(raw!.consignee_inn_raw).toBeNull();
    }, 30_000);

    it('«он же»: совпали имя и ИНН — связь по-прежнему создаётся', async () => {
      // Анти-регресс: законный повтор графы 6 не должен пострадать от правила.
      const docId = await seedUpd();
      parseUpdPdf.mockResolvedValue(
        parsedUpd({
          consignee: { inn: '7736255508', kpp: '774550001', name: 'ООО «СУ-10»' },
        }),
      );

      await handleJob(job(docId));

      const r = await row(docId);
      expect(r.consignee_name_raw).toBe('ООО «СУ-10»');
      expect(r.consignee_id).not.toBeNull();
      const [raw] = await db<{ consignee_inn_raw: string | null }[]>`
        SELECT consignee_inn_raw FROM source_documents WHERE id = ${docId}`;
      expect(raw!.consignee_inn_raw).toBe('7736255508');
    }, 30_000);
  });
});
