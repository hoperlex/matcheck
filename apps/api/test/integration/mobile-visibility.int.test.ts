/**
 * Предикат «документ виден инспектору»: что доезжает до планшета.
 *
 * Требование звучит просто — «на планшет попадает только обработанное», — но
 * `status = 'parsed'` его не выражает. Портал сам рисует такой документ
 * «Черновиком», если нет объекта, даты или получателя (getDocumentDisplayStatus).
 * Отдать инспектору черновик значит дать принять машину, у которой даже
 * получатель не определён.
 *
 * Что здесь ловится и не ловится больше нигде:
 *   * ЧЕРНОВИК не уезжает, хотя статус у него parsed;
 *   * ГРУППА ЕДЕТ ЦЕЛИКОМ: один неготовый документ машины прячет всю машину.
 *     Проверка «все документы группы parsed» этого не даёт — документа для
 *     очередного файла может ещё НЕ СУЩЕСТВОВАТЬ, и проверять было бы нечего;
 *   * ФАЙЛ БЕЗ ДОКУМЕНТА блокирует машину. Это ровно случай выше: строка реестра
 *     активного поколения есть, документа по ней нет;
 *   * ARCHIVED НЕ БЛОКИРУЕТ. Осознанно исключённый дубль или сертификат не
 *     должен держать машину вечно;
 *   * ОДИНОЧНЫЙ ДОКУМЕНТ без группы отвечает сам за себя — legacy-сборка, ЭДО и
 *     почта продолжают работать как раньше.
 *
 * Запуск: см. заголовок sync-consignee.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sourceDocuments } from '../../src/db/schema.js';
import { mobileVisibleSourceDocumentSql } from '../../src/domain/sourceDocuments/mobile-visibility.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('видимость документа на планшете (реальный PostgreSQL)', () => {
  let sql_: ReturnType<typeof postgres>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  const siteId = randomUUID();
  const contractorId = randomUUID();

  const hash = (s: string) => `${s}${randomUUID().replace(/-/g, '')}`.slice(0, 64);

  /** Готовый документ: статус, реквизиты и получатель на месте. */
  async function doc(opts: {
    id: string;
    bundleId: string | null;
    status?: string;
    withSite?: boolean;
    withDate?: boolean;
    withRecipient?: boolean;
    parseErrorCode?: string | null;
    technical?: boolean;
  }) {
    await sql_`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum, bundle_id, expected_date, contractor_id,
         parse_error_code)
      VALUES (${opts.id}, 'upd', ${opts.technical ?? false}, 'inbound', 'manual_pdf',
              ${opts.status ?? 'parsed'},
              ${opts.withSite === false ? null : siteId}, now(),
              'ВИД-1', now(), 100, ${opts.bundleId},
              ${opts.withDate === false ? null : sql_`now()`},
              ${opts.withRecipient === false ? null : contractorId},
              ${opts.parseErrorCode ?? null})`;
  }

  async function bundle(id: string, opts: { assembly?: string; parent?: string | null } = {}) {
    await sql_`INSERT INTO source_bundles
        (id, bundle_hash, direction, site_id, status, kind, assembly_version,
         published_generation, active_upload_generation, parent_bundle_id)
      VALUES (${id}, ${hash('vis')}, 'inbound', ${siteId}, 'parsed', 'mixed',
              ${opts.assembly ?? 'logical_v1'}, 0, 0, ${opts.parent ?? null})`;
  }

  /** Виден ли документ по предикату — спрашиваем саму БД. */
  async function isVisible(id: string): Promise<boolean> {
    const [row] = await db
      .select({ visible: sql<boolean>`${mobileVisibleSourceDocumentSql()}` })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.id, id));
    return row.visible;
  }

  beforeAll(async () => {
    sql_ = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql_);
    await sql_`INSERT INTO sites (id, code, name)
               VALUES (${siteId}, ${`VIS${Date.now() % 10000}`}, 'Видимость')`;
    await sql_`INSERT INTO counterparties (id, inn, name, is_contractor)
               VALUES (${contractorId}, ${`77${Date.now() % 100000000}`}, 'Подрядчик видимости', true)`;
  });

  afterAll(async () => {
    if (!sql_) return;
    await sql_`DELETE FROM bundle_import_items WHERE bundle_id IN
                 (SELECT id FROM source_bundles WHERE site_id = ${siteId})`;
    await sql_`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql_`DELETE FROM source_bundles WHERE site_id = ${siteId} AND parent_bundle_id IS NOT NULL`;
    await sql_`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await sql_`DELETE FROM counterparties WHERE id = ${contractorId}`;
    await sql_`DELETE FROM sites WHERE id = ${siteId}`;
    await sql_.end();
  });

  it('обработанный одиночный документ виден', async () => {
    const id = randomUUID();
    await doc({ id, bundleId: null });
    expect(await isVisible(id)).toBe(true);
  });

  it('документ не в parsed не виден', async () => {
    const id = randomUUID();
    await doc({ id, bundleId: null, status: 'needs_resolution' });
    expect(await isVisible(id)).toBe(false);
  });

  it('заглушка «не распознано» не видна', async () => {
    const id = randomUUID();
    await doc({ id, bundleId: null, status: 'needs_resolution', parseErrorCode: 'not_processed' });
    expect(await isVisible(id)).toBe(false);
  });

  it('parsed без объекта — это черновик, он не виден', async () => {
    const id = randomUUID();
    await doc({ id, bundleId: null, withSite: false });
    expect(await isVisible(id)).toBe(false);
  });

  it('parsed без даты поставки не виден', async () => {
    const id = randomUUID();
    await doc({ id, bundleId: null, withDate: false });
    expect(await isVisible(id)).toBe(false);
  });

  it('parsed без получателя не виден', async () => {
    const id = randomUUID();
    await doc({ id, bundleId: null, withRecipient: false });
    expect(await isVisible(id)).toBe(false);
  });

  it('один неготовый документ машины прячет всю машину', async () => {
    const root = randomUUID();
    const ready = randomUUID();
    const notReady = randomUUID();
    await bundle(root);
    await doc({ id: ready, bundleId: root });
    await doc({ id: notReady, bundleId: root, status: 'processing' });

    expect(await isVisible(ready)).toBe(false);
    expect(await isVisible(notReady)).toBe(false);
  });

  it('черновик внутри машины тоже прячет всю машину', async () => {
    const root = randomUUID();
    const ready = randomUUID();
    const draft = randomUUID();
    await bundle(root);
    await doc({ id: ready, bundleId: root });
    await doc({ id: draft, bundleId: root, withDate: false });

    expect(await isVisible(ready)).toBe(false);
  });

  it('архивный дубль машину не блокирует', async () => {
    const root = randomUUID();
    const ready = randomUUID();
    const archived = randomUUID();
    await bundle(root);
    await doc({ id: ready, bundleId: root });
    await doc({ id: archived, bundleId: root, status: 'archived', parseErrorCode: 'supplementary' });

    expect(await isVisible(ready)).toBe(true);
  });

  it('принятый файл без документа прячет машину — проверять по документам нечего', async () => {
    const root = randomUUID();
    const ready = randomUUID();
    await bundle(root);
    await doc({ id: ready, bundleId: root });
    // Файл принят, документа по нему ещё нет: строка реестра активного поколения
    // без единого attachment.
    await sql_`INSERT INTO bundle_import_items
        (bundle_id, source_filename, status, input_s3_key, upload_generation, processing_mode)
      VALUES (${root}, 'ещё-не-разобран.jpg', 'accepted', ${`vis/${root}/pending.jpg`}, 0, 'auto')`;

    expect(await isVisible(ready)).toBe(false);
  });

  it('файл второй зоны (skipped) машину не блокирует', async () => {
    const root = randomUUID();
    const ready = randomUUID();
    await bundle(root);
    await doc({ id: ready, bundleId: root });
    await sql_`INSERT INTO bundle_import_items
        (bundle_id, source_filename, status, input_s3_key, upload_generation, processing_mode)
      VALUES (${root}, 'сертификат.pdf', 'skipped', ${`vis/${root}/cert.pdf`}, 0, 'store_only')`;

    expect(await isVisible(ready)).toBe(true);
  });

  it('документ дочернего пакета учитывается как член машины', async () => {
    const root = randomUUID();
    const child = randomUUID();
    const onRoot = randomUUID();
    const onChild = randomUUID();
    await bundle(root);
    await bundle(child, { assembly: 'legacy', parent: root });
    await doc({ id: onRoot, bundleId: root });
    // Накладная живёт на дочернем пакете и ещё не готова — машина скрыта.
    await doc({ id: onChild, bundleId: child, status: 'queued' });

    expect(await isVisible(onRoot)).toBe(false);
  });

  it('legacy-пакет не считается машиной: документ отвечает сам за себя', async () => {
    const root = randomUUID();
    const a = randomUUID();
    const b = randomUUID();
    await bundle(root, { assembly: 'legacy' });
    await doc({ id: a, bundleId: root });
    await doc({ id: b, bundleId: root, status: 'processing' });

    // Сосед в разборе, но группы нет — готовый документ виден.
    expect(await isVisible(a)).toBe(true);
  });
});
