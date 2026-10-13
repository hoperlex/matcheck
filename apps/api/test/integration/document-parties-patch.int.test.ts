/**
 * Правка сторон документа (покупатель, грузополучатель) из карточки и
 * «применяется только изменённое».
 *
 * Мониторинг и админ задают стороны, когда распознавание их не нашло или
 * ошиблось. Здесь ловится то, чего не видно ни в одном юнит-тесте:
 *
 *   * колонки пишутся согласованно — имя, ИНН и FK. Сторона показывается как
 *     COALESCE(*_name_raw, имя по FK), и забытый FK при очистке вернул бы на
 *     экран прежнего контрагента;
 *   * атомарность: битый ИНН одной стороны отменяет весь запрос, а контрагент
 *     заводится уже ПОСЛЕ ветки конфликта машины — та фиксирует транзакцию, и
 *     заведённый раньше контрагент пережил бы отказ;
 *   * найденному по ИНН контрагенту добавляется роль покупателя, новых строк
 *     не появляется, а параллельные правки с одним новым ИНН не падают на
 *     уникальном индексе;
 *   * правка одной стороны не поднимает ревизию машины, не пересчитывает статус
 *     (иначе слетало бы «Принять как есть») и не трогает позиции — у строк
 *     приёмки на них ссылка ON DELETE SET NULL;
 *   * поставщик выбирается по id справочника, и вместе с FK сбрасывается
 *     распознанный ИНН: список приёмок и подбор ЭДО берут
 *     coalesce(supplier_inn_raw, ИНН справочника). Правка видна во всех
 *     приёмках, к которым привязан документ, но в строке списка — только если
 *     документ у приёмки основной.
 *
 * Запуск: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test
 * Без переменной набор пропускается.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';
import {
  idempotencyKeyOf,
  bundleIdentityHashOf,
} from '../../src/domain/sourceDocuments/bundle-key.js';

vi.mock('../../src/instrument.js', () => ({}));
vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  presign: vi.fn(),
  getObject: vi.fn(),
  deleteObject: vi.fn(),
  putObject: vi.fn(),
}));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Валидный и уникальный на прогон ИНН. Константа не годится: уникальный индекс
 * по ИНН общий для всех наборов, а тестовая база живёт между прогонами.
 */
function validInn(): string {
  const body = `98${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
  const d = [...body].map(Number);
  const check = ([2, 4, 10, 3, 5, 9, 4, 6, 8].reduce((a, w, i) => a + w * d[i]!, 0) % 11) % 10;
  return `${body}${check}`;
}

suite('правка сторон документа (реальный PostgreSQL)', { timeout: 40_000 }, () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  const siteA = randomUUID();
  const siteB = randomUUID();
  const manager = { id: randomUUID(), role: 'manager', siteId: null } as unknown as AuthUser;
  /** Все ИНН, под которыми набор мог завести контрагента, — для уборки. */
  const usedInns: string[] = [];

  function freshInn(): string {
    const inn = validInn();
    usedInns.push(inn);
    return inn;
  }

  /** Рубильник групп включён: только при нём PATCH поднимает ревизию машины. */
  async function buildApp(): Promise<FastifyInstance> {
    process.env.GROUPS_ROLLOUT = '1';
    vi.resetModules();
    const { sourceDocumentRoutes } = await import('../../src/routes/source-documents.js');
    const { deliveryRoutes } = await import('../../src/routes/deliveries.js');
    const instance = Fastify({ logger: false });
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    await instance.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    instance.decorate('db', drizzle(sql, { schema, casing: 'snake_case' }) as never);
    instance.decorate('queues', { updParse: { add: vi.fn() }, s3Cleanup: { add: vi.fn() } } as never);
    instance.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = manager;
    });
    instance.decorate(
      'authorize',
      (...roles: AuthUser['role'][]) =>
        async (
          req: { user?: AuthUser },
          reply: { code: (c: number) => { send: (b: unknown) => void } },
        ) => {
          if (!req.user || !roles.includes(req.user.role)) {
            reply.code(403).send({ error: 'forbidden' });
          }
        },
    );
    await instance.register(sourceDocumentRoutes);
    // Список приёмок — ради primarySourceDocument: он собирается своими
    // запросами, и «в DTO документа поставщик новый» ничего о нём не говорит.
    await instance.register(deliveryRoutes);
    await instance.ready();
    return instance;
  }

  /** Корневой пакет машины с портала. */
  async function seedMachine(siteId: string): Promise<{ rootId: string; docIds: string[] }> {
    const rootId = randomUUID();
    const key = idempotencyKeyOf({
      siteId,
      direction: 'inbound',
      expectedDate: '2026-08-26',
      contentHash: rootId.replace(/-/g, ''),
    });
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, idempotency_key, direction, site_id, status, kind,
         assembly_version, active_upload_generation, parent_bundle_id, expected_date)
      VALUES (${rootId}, ${bundleIdentityHashOf(key)}, ${key}, 'inbound', ${siteId},
              'parsed', 'mixed', 'legacy', 0, NULL, '2026-08-26')`;
    await sql`INSERT INTO ingest_events (bundle_id, channel, public_ticket)
              VALUES (${rootId}, 'public', ${randomUUID().slice(0, 20)})`;
    const docIds = [randomUUID(), randomUUID()];
    for (const id of docIds) await seedDoc({ id, siteId, bundleId: rootId });
    return { rootId, docIds };
  }

  /** Обработанный УПД с одной позицией; сумма сходится, если не задано иное. */
  async function seedDoc(opts: {
    id: string;
    siteId: string;
    bundleId?: string | null;
    totalSum?: number;
    parseErrorDetails?: unknown;
    supplierDirectoryId?: string;
    supplierInnRaw?: string;
    supplierId?: string;
  }): Promise<void> {
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum, bundle_id, expected_date,
         buyer_name_raw, consignee_name_raw, parse_error_details,
         supplier_directory_id, supplier_inn_raw, supplier_id)
      VALUES (${opts.id}, 'upd', false, 'inbound', 'manual_pdf', 'parsed', ${opts.siteId},
              now(), ${`DP-${opts.id.slice(0, 6)}`}, now(), ${opts.totalSum ?? 100},
              ${opts.bundleId ?? null}, '2026-08-26', 'ООО «Распознанный»', NULL,
              ${opts.parseErrorDetails ? JSON.stringify(opts.parseErrorDetails) : null}::jsonb,
              ${opts.supplierDirectoryId ?? null}, ${opts.supplierInnRaw ?? null},
              ${opts.supplierId ?? null})`;
    await sql`INSERT INTO source_document_items
        (source_document_id, name_raw, qty, unit, price, sum, line_no)
      VALUES (${opts.id}, 'Труба', 1, 'шт', 100, 100, 1)`;
  }

  async function docRow(id: string) {
    const [r] = await sql<
      {
        version: number;
        status: string;
        parse_error_code: string | null;
        parse_error_details: Record<string, unknown> | null;
        doc_number: string | null;
        buyer_id: string | null;
        buyer_name_raw: string | null;
        buyer_inn_raw: string | null;
        consignee_id: string | null;
        consignee_name_raw: string | null;
        consignee_inn_raw: string | null;
        supplier_id: string | null;
        supplier_directory_id: string | null;
        supplier_inn_raw: string | null;
      }[]
    >`SELECT version, status, parse_error_code, parse_error_details, doc_number,
             buyer_id, buyer_name_raw, buyer_inn_raw,
             consignee_id, consignee_name_raw, consignee_inn_raw,
             supplier_id, supplier_directory_id, supplier_inn_raw
        FROM source_documents WHERE id = ${id}`;
    return r!;
  }

  async function counterpartiesByInn(inn: string) {
    return await sql<
      { id: string; name: string; is_customer: boolean; is_supplier: boolean }[]
    >`SELECT id, name, is_customer, is_supplier FROM counterparties
       WHERE inn = ${inn} AND kpp IS NULL`;
  }

  async function itemIds(docId: string): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM source_document_items WHERE source_document_id = ${docId} ORDER BY line_no`;
    return rows.map((r) => r.id);
  }

  async function visibilityEvents(docId: string): Promise<number> {
    const [r] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM source_document_visibility_events
       WHERE source_document_id = ${docId}`;
    return r!.n;
  }

  function patch(docId: string, payload: Record<string, unknown>) {
    return app.inject({ method: 'PATCH', url: `/api/v1/source-documents/${docId}`, payload });
  }

  /** Записи справочника поставщиков, заведённые набором, — для уборки. */
  const seededSuppliers: string[] = [];

  async function seedSupplier(name: string): Promise<{ id: string; inn: string }> {
    const id = randomUUID();
    const inn = validInn();
    await sql`INSERT INTO suppliers (id, inn, name) VALUES (${id}, ${inn}, ${name})`;
    seededSuppliers.push(id);
    return { id, inn };
  }

  async function seedDelivery(siteId: string, docIds: string[]): Promise<string> {
    const deliveryId = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, status_id)
              VALUES (${deliveryId}, ${siteId},
                      (SELECT id FROM statuses WHERE entity_type='delivery' AND code='not_filled'))`;
    for (const docId of docIds) {
      await sql`INSERT INTO delivery_sources (delivery_id, source_document_id)
                VALUES (${deliveryId}, ${docId})`;
    }
    return deliveryId;
  }

  /** Строка списка приёмок — то, что видит таблица на портале. */
  async function listedSupplier(
    deliveryId: string,
  ): Promise<{ supplierName: string | null; supplierInn: string | null }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/deliveries?siteId=${siteA}&limit=100`,
    });
    expect(res.statusCode).toBe(200);
    const row = (res.json() as { items: Record<string, unknown>[] }).items.find(
      (i) => i.id === deliveryId,
    );
    expect(row, `приёмка ${deliveryId} не найдена в списке`).toBeTruthy();
    const primary = row!.primarySourceDocument as {
      supplierName: string | null;
      supplierInn: string | null;
    };
    return { supplierName: primary.supplierName, supplierInn: primary.supplierInn };
  }

  async function cleanup(): Promise<void> {
    for (const site of [siteA, siteB]) {
      await sql`DELETE FROM delivery_sources WHERE source_document_id IN (
        SELECT id FROM source_documents WHERE site_id = ${site})`;
      await sql`DELETE FROM deliveries WHERE site_id = ${site}`;
      await sql`DELETE FROM source_document_visibility_events WHERE site_id = ${site}`;
      await sql`DELETE FROM source_document_items WHERE source_document_id IN (
        SELECT id FROM source_documents WHERE site_id = ${site})`;
      await sql`DELETE FROM source_documents WHERE site_id = ${site}`;
      await sql`DELETE FROM ingest_events WHERE bundle_id IN (
        SELECT id FROM source_bundles WHERE site_id = ${site})`;
      await sql`DELETE FROM source_bundles WHERE site_id = ${site}`;
    }
    if (usedInns.length > 0) {
      await sql`DELETE FROM counterparties WHERE inn = ANY(${usedInns})`;
    }
    if (seededSuppliers.length > 0) {
      await sql`DELETE FROM suppliers WHERE id = ANY(${seededSuppliers})`;
      seededSuppliers.length = 0;
    }
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 6 });
    await sql`INSERT INTO sites (id, code, name) VALUES (${siteA}, ${`DPA${Date.now() % 10000}`}, 'Стороны A')`;
    await sql`INSERT INTO sites (id, code, name) VALUES (${siteB}, ${`DPB${Date.now() % 10000}`}, 'Стороны B')`;
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await cleanup();
    await sql`DELETE FROM sites WHERE id IN (${siteA}, ${siteB})`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(cleanup);

  // ─── Запись сторон ────────────────────────────────────────────────────────

  it('сторона с ИНН: имя в raw, ИНН через FK, DTO отдаёт выбранное', async () => {
    const docId = randomUUID();
    await seedDoc({ id: docId, siteId: siteA });
    const inn = freshInn();

    const res = await patch(docId, { buyer: { name: 'ООО «ЭСТ»', inn } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ buyerName: 'ООО «ЭСТ»', buyerInn: inn });

    const row = await docRow(docId);
    expect(row.buyer_name_raw).toBe('ООО «ЭСТ»');
    // Колонка отвечает на «что стояло в документе» — введённое туда не пишем.
    expect(row.buyer_inn_raw).toBeNull();
    const [cp] = await counterpartiesByInn(inn);
    expect(row.buyer_id).toBe(cp!.id);
    expect(cp!.is_customer).toBe(true);

    // Деталь — отдельный сборщик DTO; расходится с ответом PATCH молча.
    const detail = await app.inject({ method: 'GET', url: `/api/v1/source-documents/${docId}` });
    expect(detail.json()).toMatchObject({ buyerName: 'ООО «ЭСТ»', buyerInn: inn });
  });

  it('сторона без ИНН: только имя, FK и ИНН пустые', async () => {
    const docId = randomUUID();
    await seedDoc({ id: docId, siteId: siteA });

    const res = await patch(docId, { consignee: { name: '  ИП Петров  ' } });
    expect(res.statusCode).toBe(200);
    const row = await docRow(docId);
    expect(row.consignee_name_raw).toBe('ИП Петров');
    expect(row.consignee_id).toBeNull();
    expect(row.consignee_inn_raw).toBeNull();
    expect(res.json()).toMatchObject({ consigneeName: 'ИП Петров', consigneeInn: null });
  });

  it('очистка обнуляет имя, ИНН и FK — COALESCE не возвращает прежнего', async () => {
    const docId = randomUUID();
    await seedDoc({ id: docId, siteId: siteA });
    const inn = freshInn();
    expect((await patch(docId, { consignee: { name: 'ООО «Было»', inn } })).statusCode).toBe(200);
    await sql`UPDATE source_documents SET consignee_inn_raw = ${inn} WHERE id = ${docId}`;

    const res = await patch(docId, { consignee: null });
    expect(res.statusCode).toBe(200);
    const row = await docRow(docId);
    expect([row.consignee_id, row.consignee_name_raw, row.consignee_inn_raw]).toEqual([
      null,
      null,
      null,
    ]);
    expect(res.json()).toMatchObject({ consigneeName: null, consigneeInn: null });
  });

  it('без ключей сторон стороны не меняются', async () => {
    const docId = randomUUID();
    await seedDoc({ id: docId, siteId: siteA });
    const before = await docRow(docId);

    expect((await patch(docId, { docNumber: 'DP-NEW' })).statusCode).toBe(200);
    const after = await docRow(docId);
    expect(after.buyer_name_raw).toBe(before.buyer_name_raw);
    expect(after.buyer_id).toBe(before.buyer_id);
    expect(after.consignee_name_raw).toBe(before.consignee_name_raw);
  });

  // ─── Атомарность и контрагенты ────────────────────────────────────────────

  it('битый ИНН одной стороны отменяет весь запрос, включая вторую сторону', async () => {
    const docId = randomUUID();
    await seedDoc({ id: docId, siteId: siteA });
    const before = await docRow(docId);
    const buyerInn = freshInn();

    const res = await patch(docId, {
      docNumber: 'DP-CHANGED',
      buyer: { name: 'ООО «Покупатель»', inn: buyerInn },
      // Контрольная цифра должна быть 9.
      consignee: { name: 'ООО «Стройуправление»', inn: '7736255087' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_inn' });
    expect(res.json().message).toMatch(/грузополучателя/);

    expect(await counterpartiesByInn(buyerInn)).toHaveLength(0);
    const after = await docRow(docId);
    expect(after.doc_number).toBe(before.doc_number);
    expect(after.buyer_name_raw).toBe(before.buyer_name_raw);
    expect(after.consignee_name_raw).toBe(before.consignee_name_raw);
  });

  it('отказ переноса машины: контрагент не заведён, роль не добавлена', async () => {
    const m = await seedMachine(siteA);
    const deliveryId = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, status_id)
              VALUES (${deliveryId}, ${siteA},
                      (SELECT id FROM statuses WHERE entity_type='delivery' AND code='not_filled'))`;
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id)
              VALUES (${deliveryId}, ${m.docIds[1]!})`;
    // Существующий поставщик с ИНН грузополучателя — роль ему добавилась бы.
    const supplierInn = freshInn();
    await sql`INSERT INTO counterparties (inn, kpp, name, is_supplier, is_customer)
              VALUES (${supplierInn}, NULL, 'ООО «Поставщик»', true, false)`;
    const newInn = freshInn();

    // Ветка конфликта ВОЗВРАЩАЕТ результат, и транзакция фиксируется: всё,
    // что записано до неё, пережило бы отказ.
    const res = await patch(m.docIds[0]!, {
      siteId: siteB,
      buyer: { name: 'ООО «Новый»', inn: newInn },
      consignee: { name: 'ООО «Поставщик»', inn: supplierInn },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'machine_has_operation' });

    expect(await counterpartiesByInn(newInn)).toHaveLength(0);
    const [supplier] = await counterpartiesByInn(supplierInn);
    expect(supplier!.is_customer).toBe(false);
    expect((await docRow(m.docIds[0]!)).buyer_name_raw).toBe('ООО «Распознанный»');
  });

  it('существующему контрагенту добавляется роль покупателя, новых строк нет', async () => {
    const docId = randomUUID();
    await seedDoc({ id: docId, siteId: siteA });
    const inn = freshInn();
    const [existing] = await sql<{ id: string }[]>`
      INSERT INTO counterparties (inn, kpp, name, is_supplier, is_customer)
      VALUES (${inn}, NULL, 'ООО «Как в справочнике»', true, false) RETURNING id`;

    const res = await patch(docId, { consignee: { name: 'ООО «Как выбрал человек»', inn } });
    expect(res.statusCode).toBe(200);

    const rows = await counterpartiesByInn(inn);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(existing!.id);
    // Роль добавлена, чужая не снята, имя справочной записи не переписано.
    expect(rows[0]).toMatchObject({
      is_customer: true,
      is_supplier: true,
      name: 'ООО «Как в справочнике»',
    });
    // Показывается при этом имя, выбранное человеком, — оно в raw.
    expect(res.json().consigneeName).toBe('ООО «Как выбрал человек»');
    expect((await docRow(docId)).consignee_id).toBe(existing!.id);
  });

  it('параллельные правки с одним новым ИНН: обе проходят, контрагент один', async () => {
    const docA = randomUUID();
    const docB = randomUUID();
    await seedDoc({ id: docA, siteId: siteA });
    await seedDoc({ id: docB, siteId: siteA });
    const inn = freshInn();

    const [a, b] = await Promise.all([
      patch(docA, { buyer: { name: 'ООО «Гонка»', inn } }),
      patch(docB, { buyer: { name: 'ООО «Гонка»', inn } }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const rows = await counterpartiesByInn(inn);
    expect(rows).toHaveLength(1);
    expect((await docRow(docA)).buyer_id).toBe(rows[0]!.id);
    expect((await docRow(docB)).buyer_id).toBe(rows[0]!.id);
  });

  // ─── Применяется только изменённое ────────────────────────────────────────

  it('правка стороны не поднимает ревизию машины и не пишет событий видимости', async () => {
    const m = await seedMachine(siteA);
    const before = await Promise.all(m.docIds.map(docRow));
    const eventsBefore = await visibilityEvents(m.docIds[0]!);

    const res = await patch(m.docIds[0]!, { consignee: { name: 'ООО «СУ-10»' } });
    expect(res.statusCode).toBe(200);

    const after = await Promise.all(m.docIds.map(docRow));
    expect(after.map((r) => r.version)).toEqual(before.map((r) => r.version));
    expect(await visibilityEvents(m.docIds[0]!)).toBe(eventsBefore);
  });

  it('правка стороны не снимает «Принять как есть»', async () => {
    // Сумма документа 500 при позиции на 100 — расхождение, которое человек
    // принял. Пересчёт исхода о принятии не знает и вернул бы validation_mismatch.
    const docId = randomUUID();
    const acknowledgement = { reason: 'так в бумаге', userId: null, at: '2026-10-01T00:00:00Z' };
    await seedDoc({
      id: docId,
      siteId: siteA,
      totalSum: 500,
      parseErrorDetails: { acknowledgement },
    });

    expect((await patch(docId, { buyer: { name: 'ООО «СУ-10»' } })).statusCode).toBe(200);
    const row = await docRow(docId);
    expect(row.status).toBe('parsed');
    expect(row.parse_error_code).toBeNull();
    expect(row.parse_error_details).toMatchObject({ acknowledgement });
  });

  it('правка суммы по-прежнему пересчитывает исход', async () => {
    // Обратная сторона: пересчёт не выключен, а включается входами, от которых
    // зависит. Иначе менеджер, поправивший итог, не увидел бы расхождения.
    const docId = randomUUID();
    await seedDoc({ id: docId, siteId: siteA, parseErrorDetails: { acknowledgement: {} } });

    expect((await patch(docId, { totalSum: '500' })).statusCode).toBe(200);
    expect((await docRow(docId)).parse_error_code).toBe('validation_mismatch');
  });

  it('правка стороны не пересоздаёт позиции — связь строки приёмки цела', async () => {
    const docId = randomUUID();
    await seedDoc({ id: docId, siteId: siteA });
    const [itemId] = await itemIds(docId);
    const deliveryId = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, status_id)
              VALUES (${deliveryId}, ${siteA},
                      (SELECT id FROM statuses WHERE entity_type='delivery' AND code='not_filled'))`;
    const [line] = await sql<{ id: string }[]>`
      INSERT INTO delivery_items
        (delivery_id, source_document_id, source_document_item_id, name_raw, line_no)
      VALUES (${deliveryId}, ${docId}, ${itemId!}, 'Труба', 1) RETURNING id`;

    expect((await patch(docId, { consignee: { name: 'ООО «СУ-10»' } })).statusCode).toBe(200);

    expect(await itemIds(docId)).toEqual([itemId]);
    const [link] = await sql<{ source_document_item_id: string | null }[]>`
      SELECT source_document_item_id FROM delivery_items WHERE id = ${line!.id}`;
    expect(link!.source_document_item_id).toBe(itemId);
  });

  it('прежний номер ревизию не поднимает, новый — поднимает', async () => {
    const m = await seedMachine(siteA);
    const current = await docRow(m.docIds[0]!);
    const neighbour = await docRow(m.docIds[1]!);

    // Старая вкладка портала шлёт всю шапку: совпадающий номер — не правка.
    expect((await patch(m.docIds[0]!, { docNumber: current.doc_number })).statusCode).toBe(200);
    expect((await docRow(m.docIds[0]!)).version).toBe(current.version);
    expect((await docRow(m.docIds[1]!)).version).toBe(neighbour.version);

    expect((await patch(m.docIds[0]!, { docNumber: 'DP-RENAMED' })).statusCode).toBe(200);
    expect((await docRow(m.docIds[0]!)).version).toBeGreaterThan(current.version);
    expect((await docRow(m.docIds[1]!)).version).toBeGreaterThan(neighbour.version);
  });

  it('правка позиций, как и раньше, поднимает ревизию и пересоздаёт строки', async () => {
    const m = await seedMachine(siteA);
    const before = await docRow(m.docIds[0]!);
    const [oldItem] = await itemIds(m.docIds[0]!);

    const res = await patch(m.docIds[0]!, {
      items: [{ nameRaw: 'Труба', qty: 2, unit: 'шт', price: 100, sum: 200 }],
      totalSum: 200,
    });
    expect(res.statusCode).toBe(200);
    expect((await docRow(m.docIds[0]!)).version).toBeGreaterThan(before.version);
    const [newItem] = await itemIds(m.docIds[0]!);
    expect(newItem).not.toBe(oldItem);
  });

  // ─── Поставщик из справочника ─────────────────────────────────────────────

  it('поставщик по id справочника: FK сменён, распознанный ИНН и старый FK сброшены', async () => {
    const wrong = await seedSupplier('ООО «Ошибочный»');
    const right = await seedSupplier('ООО «Королевская вода»');
    const cpInn = freshInn();
    const [cp] = await sql<{ id: string }[]>`
      INSERT INTO counterparties (inn, kpp, name, is_supplier)
      VALUES (${cpInn}, NULL, 'ООО «Старый путь»', true) RETURNING id`;
    const docId = randomUUID();
    await seedDoc({
      id: docId,
      siteId: siteA,
      supplierDirectoryId: wrong.id,
      supplierInnRaw: wrong.inn,
      supplierId: cp!.id,
    });

    const res = await patch(docId, { supplierDirectoryId: right.id });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      supplierName: 'ООО «Королевская вода»',
      supplierInn: right.inn,
    });

    const row = await docRow(docId);
    expect(row.supplier_directory_id).toBe(right.id);
    // Оставленный распознанный ИНН перебил бы справочник во всех coalesce.
    expect(row.supplier_inn_raw).toBeNull();
    expect(row.supplier_id).toBeNull();

    const detail = await app.inject({ method: 'GET', url: `/api/v1/source-documents/${docId}` });
    expect(detail.json()).toMatchObject({
      supplierName: 'ООО «Королевская вода»',
      supplierInn: right.inn,
    });
  });

  it('тот же поставщик — не правка: распознанный ИНН остаётся', async () => {
    const current = await seedSupplier('ООО «Как распознано»');
    const docId = randomUUID();
    await seedDoc({
      id: docId,
      siteId: siteA,
      supplierDirectoryId: current.id,
      supplierInnRaw: current.inn,
    });

    expect((await patch(docId, { supplierDirectoryId: current.id })).statusCode).toBe(200);
    const row = await docRow(docId);
    expect(row.supplier_directory_id).toBe(current.id);
    expect(row.supplier_inn_raw).toBe(current.inn);
  });

  it('неизвестный поставщик — 400, документ не изменён', async () => {
    const current = await seedSupplier('ООО «Как распознано»');
    const docId = randomUUID();
    await seedDoc({
      id: docId,
      siteId: siteA,
      supplierDirectoryId: current.id,
      supplierInnRaw: current.inn,
    });

    const res = await patch(docId, { supplierDirectoryId: randomUUID(), docNumber: 'DP-X' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'supplier_not_found' });
    const row = await docRow(docId);
    expect(row.supplier_directory_id).toBe(current.id);
    expect(row.supplier_inn_raw).toBe(current.inn);
    expect(row.doc_number).not.toBe('DP-X');
  });

  it('поставщик двумя способами сразу — 400, справочник не растёт', async () => {
    const right = await seedSupplier('ООО «Королевская вода»');
    const docId = randomUUID();
    await seedDoc({ id: docId, siteId: siteA });
    const inn = validInn();

    const res = await patch(docId, {
      supplierDirectoryId: right.id,
      supplier: { inn, name: 'ООО «Через поиск»' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'supplier_conflict' });
    const created = await sql`SELECT id FROM suppliers WHERE inn = ${inn}`;
    expect(created).toHaveLength(0);
    expect((await docRow(docId)).supplier_directory_id).toBeNull();
  });

  it('правка поставщика не поднимает ревизию машины и не пишет событий видимости', async () => {
    const right = await seedSupplier('ООО «Королевская вода»');
    const m = await seedMachine(siteA);
    const before = await Promise.all(m.docIds.map(docRow));
    const eventsBefore = await visibilityEvents(m.docIds[0]!);

    expect((await patch(m.docIds[0]!, { supplierDirectoryId: right.id })).statusCode).toBe(200);

    const after = await Promise.all(m.docIds.map(docRow));
    expect(after.map((r) => r.version)).toEqual(before.map((r) => r.version));
    expect(await visibilityEvents(m.docIds[0]!)).toBe(eventsBefore);
  });

  it('правка поставщика не снимает «Принять как есть» и не трогает позиции', async () => {
    const right = await seedSupplier('ООО «Королевская вода»');
    const docId = randomUUID();
    const acknowledgement = { reason: 'так в бумаге', userId: null, at: '2026-10-01T00:00:00Z' };
    await seedDoc({
      id: docId,
      siteId: siteA,
      totalSum: 500,
      parseErrorDetails: { acknowledgement },
    });
    const [itemId] = await itemIds(docId);
    const deliveryId = await seedDelivery(siteA, [docId]);
    const [line] = await sql<{ id: string }[]>`
      INSERT INTO delivery_items
        (delivery_id, source_document_id, source_document_item_id, name_raw, line_no)
      VALUES (${deliveryId}, ${docId}, ${itemId!}, 'Труба', 1) RETURNING id`;

    expect((await patch(docId, { supplierDirectoryId: right.id })).statusCode).toBe(200);

    const row = await docRow(docId);
    expect(row.status).toBe('parsed');
    expect(row.parse_error_code).toBeNull();
    expect(row.parse_error_details).toMatchObject({ acknowledgement });
    expect(await itemIds(docId)).toEqual([itemId]);
    const [link] = await sql<{ source_document_item_id: string | null }[]>`
      SELECT source_document_item_id FROM delivery_items WHERE id = ${line!.id}`;
    expect(link!.source_document_item_id).toBe(itemId);
  });

  it('один УПД в двух приёмках: обе строки списка показывают нового поставщика', async () => {
    const wrong = await seedSupplier('ООО «Ошибочный»');
    const right = await seedSupplier('ООО «Королевская вода»');
    const docId = randomUUID();
    await seedDoc({
      id: docId,
      siteId: siteA,
      supplierDirectoryId: wrong.id,
      supplierInnRaw: wrong.inn,
    });
    // «Несколько поставок» (миграция 0063): один УПД — несколько рейсов.
    const first = await seedDelivery(siteA, [docId]);
    const second = await seedDelivery(siteA, [docId]);

    expect((await patch(docId, { supplierDirectoryId: right.id })).statusCode).toBe(200);

    for (const deliveryId of [first, second]) {
      expect(await listedSupplier(deliveryId)).toEqual({
        supplierName: 'ООО «Королевская вода»',
        supplierInn: right.inn,
      });
    }
  });

  it('многодокументная приёмка: строку списка меняет только правка основного документа', async () => {
    const wrong = await seedSupplier('ООО «Ошибочный»');
    const right = await seedSupplier('ООО «Королевская вода»');
    const docIds = [randomUUID(), randomUUID()];
    for (const id of docIds) {
      await seedDoc({
        id,
        siteId: siteA,
        supplierDirectoryId: wrong.id,
        supplierInnRaw: wrong.inn,
      });
    }
    // Основной — первый по sourceDocumentId: так его выбирают и список, и
    // карточка приёмки (sourceDocumentIds[0]).
    const [primary, secondary] = [...docIds].sort();
    const deliveryId = await seedDelivery(siteA, docIds);

    // Почему карточка правит только основной: правка второго нигде не видна.
    expect((await patch(secondary!, { supplierDirectoryId: right.id })).statusCode).toBe(200);
    expect((await listedSupplier(deliveryId)).supplierName).toBe('ООО «Ошибочный»');

    expect((await patch(primary!, { supplierDirectoryId: right.id })).statusCode).toBe(200);
    expect(await listedSupplier(deliveryId)).toEqual({
      supplierName: 'ООО «Королевская вода»',
      supplierInn: right.inn,
    });
  });
});
