/**
 * Автоподстановка подрядчика из покупателя: когда срабатывает, когда молчит и
 * кому после этого виден документ.
 *
 * Проверяется именно граница записи, а не качество распознавания: парсер здесь
 * замокан. Каждый тест защищает решение, принятое при проектировании:
 *   * канал — подставляем ТОЛЬКО документам с публичной страницы /uploads, хотя
 *     handleJob обслуживает и ручную загрузку, и почту, и ЭДО;
 *   * статус и confidence — needs_resolution и «неуверенный» разбор не трогаем;
 *   * решение человека сильнее автоматики: очищенный получатель не возвращается
 *     повторным проходом, а сохранение карточки не снимает метку;
 *   * RBAC — auto_buyer не даёт роли contractor ни документа, ни приёмки,
 *     унаследовавшей от него подрядчика, а вот явное сохранение приёмки даёт.
 *
 * Запуск: см. заголовок test/integration/upload-documents-characterization.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliveries } from '../../src/db/schema.js';
import * as schema from '../../src/db/schema.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

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
// Мок терпит отсутствие TEST_DATABASE_URL: `drizzle(null)` бросает прямо в
// фабрике мока, и набор падал бы вместо того, чтобы скипнуться (так ведут себя
// соседние int-наборы — их починка отдельной задачей).
vi.mock('../../src/db/client.js', () => ({ db: sql ? drizzle(sql) : null }));
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

const { handleJob } = await import('../../src/worker.js');
const { deliveryContractorPredicate, sourceDocumentVisibleToContractor } = await import(
  '../../src/lib/contractor-scope.js'
);

/**
 * ИНН для теста генерируется, а не берётся боевой: справочник контрагентов общий
 * для всех интеграционных наборов, а уникальность в схеме частичная
 * (UNIQUE(inn) при пустом КПП, UNIQUE(inn, kpp) при заполненном) — константа
 * конфликтовала бы с данными, которые оставили соседние тесты.
 */
function makeInn(seed: number): string {
  const body = String(seed).padStart(9, '0').slice(-9);
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const check = (weights.reduce((acc, w, i) => acc + w * Number(body[i]), 0) % 11) % 10;
  return `${body}${check}`;
}

/** Валидный ИНН: контрольная цифра сходится, резолвер его примет. */
const BUYER_INN = makeInn(Date.now() % 1_000_000_000);
/**
 * ИНН с испорченной контрольной цифрой — модель именно так путала цифры на
 * проде (7736255088 и 7736255608 вместо 7736255508).
 */
const BROKEN_INN = `${BUYER_INN.slice(0, 9)}${(Number(BUYER_INN[9]) + 1) % 10}`;

function parsedUpd(over: { docNumber?: string; buyerInn?: string | null; confidence?: number }) {
  return {
    parsed: {
      docNumber: over.docNumber ?? 'UT-3843',
      docDate: '2026-07-10',
      totalSum: 403098,
      vatSum: 67183,
      itemsCount: 1,
      supplier: { inn: '5001120691', kpp: '500101001', name: 'ООО "КОМПЕНСАТОР"' },
      recipient:
        over.buyerInn === null
          ? null
          : { inn: over.buyerInn ?? BUYER_INN, kpp: '774550001', name: 'ООО «СУ-10»' },
      consignee: null,
      items: [
        {
          nameRaw: 'Компенсатор сильфонный',
          qty: 10,
          unit: 'шт',
          // Цена — из графы 4 (БЕЗ НДС), сумма — из графы 9 (С НДС):
          // валидатор сверяет qty × price с sum × 100/(100 + vatRate).
          price: 33591.5,
          sum: 403098,
          vatRate: 20,
          vatSum: 67183,
        },
      ],
      confidence: over.confidence ?? 0.95,
    },
    textLength: 5000,
    llmProviderId: null,
  };
}

// Таймаут поднят: каждый кейс гоняет полный handleJob по реальной базе (~0.8 с),
// а в общем прогоне БД уже нагружена соседними наборами — дефолтных 5 с не
// хватало, и набор падал только при `pnpm -r test`, оставаясь зелёным поодиночке.
suite('автоподстановка подрядчика из покупателя (реальный PostgreSQL)', { timeout: 30_000 }, () => {
  const db = sql!;
  const siteId = randomUUID();
  const contractorId = randomUUID();
  const otherContractorId = randomUUID();

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`ACR${Date.now() % 10000}`}, 'Автоподрядчик')`;
    // Дубль справочника: две записи с одним ИНН и разными КПП — ровно как у
    // СУ-10 на проде, где на каждое обособленное подразделение своя строка
    // (уникальность частичная: UNIQUE(inn, kpp) при заполненном КПП).
    // Побеждать должна более используемая, а не совпавшая по КПП.
    await db`INSERT INTO counterparties (id, inn, kpp, name, is_contractor)
             VALUES (${contractorId}, ${BUYER_INN}, '774550001', 'ООО «СУ-10»', true)`;
    await db`INSERT INTO counterparties (id, inn, kpp, name, is_contractor)
             VALUES (${otherContractorId}, ${BUYER_INN}, '771501001', 'ООО "СУ-10"', true)`;
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db`DELETE FROM counterparties WHERE id IN (${contractorId}, ${otherContractorId})`;
    await db`DELETE FROM sites WHERE id = ${siteId}`;
    await db.end({ timeout: 5 });
  });

  async function cleanup(): Promise<void> {
    await db`DELETE FROM delivery_sources WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await db`DELETE FROM source_document_items WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM ingest_events WHERE bundle_id IN (
      SELECT id FROM source_bundles WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await db`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  }

  beforeEach(async () => {
    parseUpdPdf.mockReset();
    await cleanup();
  });

  /**
   * Документ в очереди. `channel` определяет канал приёма: 'public' — публичная
   * страница, 'manual'/'mail' — всё остальное.
   */
  async function seedUpd(opts: {
    channel: 'public' | 'manual' | 'mail';
    contractorId?: string | null;
    recipientSource?: 'manual' | 'auto_buyer' | null;
    direction?: 'inbound' | 'outbound';
  }): Promise<string> {
    const bundleId = randomUUID();
    const docId = randomUUID();
    const direction = opts.direction ?? 'inbound';
    await db`INSERT INTO source_bundles (id, site_id, direction, status, bundle_hash, doc_count)
             VALUES (${bundleId}, ${siteId}, ${direction}, 'queued', ${bundleId}, 1)`;
    await db`INSERT INTO ingest_events (bundle_id, channel)
             VALUES (${bundleId}, ${opts.channel})`;
    await db`INSERT INTO source_documents
               (id, kind, direction, status, origin, site_id, bundle_id, contractor_id, recipient_source)
             VALUES (${docId}, 'upd', ${direction}, 'queued', 'manual_pdf', ${siteId}, ${bundleId},
                     ${opts.contractorId ?? null}, ${opts.recipientSource ?? null})`;
    return docId;
  }

  async function row(docId: string) {
    const [r] = await db<
      {
        status: string;
        parse_error_code: string | null;
        contractor_id: string | null;
        recipient_source: string | null;
        updated_at: string;
      }[]
    >`SELECT status, parse_error_code, contractor_id, recipient_source, updated_at
        FROM source_documents WHERE id = ${docId}`;
    return r!;
  }

  const job = (docId: string) =>
    ({ id: 'j1', data: { sourceDocumentId: docId, s3Key: `test/${docId}/source.pdf` } }) as never;

  // ─── Основной путь ────────────────────────────────────────────────────────

  it('публичный УПД: подрядчик подставлен, документ перестал быть черновиком', async () => {
    const docId = await seedUpd({ channel: 'public' });
    const before = await row(docId);
    parseUpdPdf.mockResolvedValue(parsedUpd({}));

    await handleJob(job(docId));

    const r = await row(docId);
    expect(r.status).toBe('parsed');
    expect(r.contractor_id).toBe(contractorId);
    expect(r.recipient_source).toBe('auto_buyer');
    // /sync берёт дельту по updated_at: без него планшет не увидел бы изменения.
    // Драйвер отдаёт timestamp строкой — сравниваем как даты.
    expect(new Date(r.updated_at).getTime()).toBeGreaterThan(
      new Date(before.updated_at).getTime(),
    );
  });

  it('дубли справочника по ИНН: побеждает наиболее используемая запись', async () => {
    // «Нагружаем» вторую запись — она должна обойти первую, несмотря на то что
    // создана позже: usage важнее created_at.
    const filler = randomUUID();
    const fillerBundle = randomUUID();
    await db`INSERT INTO source_bundles (id, site_id, direction, status, bundle_hash, doc_count)
             VALUES (${fillerBundle}, ${siteId}, 'inbound', 'parsed', ${fillerBundle}, 1)`;
    // CHECK source_upd_required: УПД со status='parsed' обязан иметь шапку.
    await db`INSERT INTO source_documents
               (id, kind, direction, status, origin, site_id, bundle_id, contractor_id,
                doc_number, doc_date, total_sum)
             VALUES (${filler}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId}, ${fillerBundle},
                     ${otherContractorId}, 'FILLER-1', '2026-01-01', 1.00)`;

    const docId = await seedUpd({ channel: 'public' });
    parseUpdPdf.mockResolvedValue(parsedUpd({ docNumber: 'UT-9001' }));
    await handleJob(job(docId));

    expect((await row(docId)).contractor_id).toBe(otherContractorId);
  });

  // ─── Канальный guard ──────────────────────────────────────────────────────

  it.each(['manual', 'mail'] as const)(
    'канал %s: не подставляем — там получателя выбирает человек',
    async (channel) => {
      const docId = await seedUpd({ channel });
      parseUpdPdf.mockResolvedValue(parsedUpd({ docNumber: `UT-${channel}` }));

      await handleJob(job(docId));

      const r = await row(docId);
      expect(r.contractor_id).toBeNull();
      expect(r.recipient_source).toBeNull();
    },
  );

  it('outbound не трогаем: там contractor_id — отправитель', async () => {
    const docId = await seedUpd({ channel: 'public', direction: 'outbound' });
    parseUpdPdf.mockResolvedValue(parsedUpd({ docNumber: 'UT-OUT' }));

    await handleJob(job(docId));

    expect((await row(docId)).contractor_id).toBeNull();
  });

  // ─── Качество разбора ─────────────────────────────────────────────────────

  it('needs_resolution не автопривязываем: «Черновиком» он не считается', async () => {
    const docId = await seedUpd({ channel: 'public' });
    // Без позиций разбор неполон → partial_parse → needs_resolution.
    const weak = parsedUpd({ docNumber: 'UT-WEAK' });
    weak.parsed.items = [];
    parseUpdPdf.mockResolvedValue(weak);

    await handleJob(job(docId));

    const r = await row(docId);
    expect(r.status).toBe('needs_resolution');
    expect(r.contractor_id).toBeNull();
    expect(r.recipient_source).toBeNull();
  });

  it('мусорный ИНН от LLM: отказ, документ остаётся черновиком', async () => {
    const docId = await seedUpd({ channel: 'public' });
    parseUpdPdf.mockResolvedValue(parsedUpd({ docNumber: 'UT-BAD', buyerInn: BROKEN_INN }));

    await handleJob(job(docId));

    const r = await row(docId);
    expect({ status: r.status, code: r.parse_error_code }).toEqual({ status: 'parsed', code: null });
    expect(r.contractor_id).toBeNull();
  });

  it('покупатель не распознан вовсе: отказ', async () => {
    const docId = await seedUpd({ channel: 'public' });
    parseUpdPdf.mockResolvedValue(parsedUpd({ docNumber: 'UT-NOBUYER', buyerInn: null }));

    await handleJob(job(docId));

    expect((await row(docId)).contractor_id).toBeNull();
  });

  // ─── Решение человека сильнее ─────────────────────────────────────────────

  it('менеджер очистил получателя (manual) — повторный разбор его не возвращает', async () => {
    const docId = await seedUpd({ channel: 'public', contractorId: null, recipientSource: 'manual' });
    parseUpdPdf.mockResolvedValue(parsedUpd({ docNumber: 'UT-VETO' }));

    await handleJob(job(docId));

    const r = await row(docId);
    expect(r.contractor_id).toBeNull();
    expect(r.recipient_source).toBe('manual');
  });

  it('подрядчик уже выбран человеком — значение не меняется', async () => {
    const docId = await seedUpd({
      channel: 'public',
      contractorId: otherContractorId,
      recipientSource: 'manual',
    });
    parseUpdPdf.mockResolvedValue(parsedUpd({ docNumber: 'UT-KEEP' }));

    await handleJob(job(docId));

    const r = await row(docId);
    expect(r.contractor_id).toBe(otherContractorId);
    expect(r.recipient_source).toBe('manual');
  });

  // ─── RBAC: автоподстановка не даёт прав ───────────────────────────────────

  it('auto_buyer-документ подрядчику не виден, manual — виден', () => {
    const opIds = [contractorId];
    expect(
      sourceDocumentVisibleToContractor({ contractorId, recipientSource: 'auto_buyer' }, opIds),
    ).toBe(false);
    expect(
      sourceDocumentVisibleToContractor({ contractorId, recipientSource: 'manual' }, opIds),
    ).toBe(true);
    expect(sourceDocumentVisibleToContractor({ contractorId, recipientSource: null }, opIds)).toBe(
      true,
    );
  });

  it('приёмка, унаследовавшая auto_buyer-документ, подрядчику не видна; с явным contractor_id — видна', async () => {
    const docId = await seedUpd({ channel: 'public' });
    parseUpdPdf.mockResolvedValue(parsedUpd({ docNumber: 'UT-RBAC' }));
    await handleJob(job(docId));
    expect((await row(docId)).recipient_source).toBe('auto_buyer');

    // Приёмка без своего подрядчика — видимость только через документ.
    const inheritedId = randomUUID();
    await db`INSERT INTO deliveries (id, site_id, status_id)
             VALUES (${inheritedId}, ${siteId}, (SELECT id FROM statuses WHERE entity_type='delivery' AND code='not_filled'))`;
    await db`INSERT INTO delivery_sources (delivery_id, source_document_id)
             VALUES (${inheritedId}, ${docId})`;

    // Приёмка с явно сохранённым подрядчиком — решение авторизованного человека.
    const explicitId = randomUUID();
    await db`INSERT INTO deliveries (id, site_id, contractor_id, status_id)
             VALUES (${explicitId}, ${siteId}, ${contractorId},
                     (SELECT id FROM statuses WHERE entity_type='delivery' AND code='not_filled'))`;
    await db`INSERT INTO delivery_sources (delivery_id, source_document_id)
             VALUES (${explicitId}, ${docId})`;

    // Проверяем НАСТОЯЩИЙ предикат из lib/contractor-scope, а не его копию:
    // копия в тесте разошлась бы с боевым кодом при первой же правке.
    // drizzle конфигурируем ровно как в приложении (db/client.ts): без schema и
    // casing сериализация массива в ANY(...) отличается от боевой.
    const orm = drizzle(db, { schema, casing: 'snake_case' });
    const rows = await orm
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(and(eq(deliveries.siteId, siteId), deliveryContractorPredicate([contractorId])));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(explicitId);
    expect(ids).not.toContain(inheritedId);
  });
});
