/**
 * Строгая выдача поставок с публичного портала (PORTAL_GROUPS_STRICT).
 *
 * Пакет, пришедший через /uploads, — это машина: несколько документов одного
 * рейса. Пока сборка не свела их в логическую поставку и не опубликовала,
 * `group_id` у них NULL, и планшет нарисует столько карточек, сколько
 * документов. Инспектор оформит один рейс дважды, а остаток повиснет
 * неоформленным.
 *
 * Проверка комплектности (GROUP_IS_COMPLETE) от этого не спасает: она следит,
 * чтобы документы приехали ОДНОВРЕМЕННО, но группой их не делает. Поэтому под
 * флагом публичный пакет не выдаётся вовсе, пока не опубликован.
 *
 * Здесь же проверяется вторая правка: строка реестра БЕЗ ключа S3 (файл принят
 * формой, но в хранилище не лёг) блокирует машину так же, как строка без
 * документа. Раньше такие строки не рассматривались вообще — соединение
 * требовало непустой input_s3_key.
 *
 * Запуск: см. заголовок sync-consignee.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sourceDocuments } from '../../src/db/schema.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('строгая выдача портальных поставок (реальный PostgreSQL)', () => {
  let sql_: ReturnType<typeof postgres>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  /** Предикат с флагом ВКЛЮЧЁН. */
  let strictVisible: () => ReturnType<typeof sql>;
  /** Предикат с флагом ВЫКЛЮЧЕН — прежнее поведение. */
  let laxVisible: () => ReturnType<typeof sql>;

  const siteId = randomUUID();
  const contractorId = randomUUID();

  const hash = (s: string) => `${s}${randomUUID().replace(/-/g, '')}`.slice(0, 64);

  async function bundle(
    id: string,
    opts: { assembly?: string; published?: number | null; active?: number } = {},
  ) {
    await sql_`INSERT INTO source_bundles
        (id, bundle_hash, direction, site_id, status, kind, assembly_version,
         published_generation, active_upload_generation)
      VALUES (${id}, ${hash('pgs')}, 'inbound', ${siteId}, 'parsed', 'mixed',
              ${opts.assembly ?? 'legacy'},
              ${opts.published === undefined ? null : opts.published},
              ${opts.active ?? 0})`;
  }

  /** Отметка «пакет пришёл с публичной страницы». */
  async function markPublic(bundleId: string) {
    await sql_`INSERT INTO ingest_events (bundle_id, channel, public_ticket)
               VALUES (${bundleId}, 'public', ${randomUUID().slice(0, 20)})`;
  }

  async function doc(id: string, bundleId: string) {
    await sql_`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum, bundle_id, expected_date, contractor_id)
      VALUES (${id}, 'upd', false, 'inbound', 'manual_pdf', 'parsed', ${siteId}, now(),
              'СТР-1', now(), 100, ${bundleId}, now(), ${contractorId})`;
  }

  async function visible(pred: () => ReturnType<typeof sql>, id: string): Promise<boolean> {
    const [row] = await db
      .select({ v: sql<boolean>`${pred()}` })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.id, id));
    return row.v;
  }

  beforeAll(async () => {
    sql_ = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql_);
    await sql_`INSERT INTO sites (id, code, name)
               VALUES (${siteId}, ${`PGS${Date.now() % 10000}`}, 'Строгий портал')`;
    await sql_`INSERT INTO counterparties (id, inn, name, is_contractor)
               VALUES (${contractorId}, ${`78${Date.now() % 100000000}`}, 'Подрядчик строгий', true)`;

    // Два варианта модуля: флаг читается при вызове предиката, но сам loadEnv
    // кеширует разбор окружения — поэтому берём два независимых экземпляра
    // модуля, как это делает group-claim.int.test.ts.
    process.env.PORTAL_GROUPS_STRICT = '1';
    vi.resetModules();
    strictVisible = (await import('../../src/domain/sourceDocuments/mobile-visibility.js'))
      .mobileVisibleSourceDocumentSql;
    // Первый вызов ОБЯЗАТЕЛЕН здесь: loadEnv кеширует разбор окружения при
    // первом обращении, а ниже переменная меняется на '0'. Без прогрева оба
    // экземпляра прочитали бы одно и то же значение — то, которое стояло в
    // момент первого теста.
    strictVisible();

    process.env.PORTAL_GROUPS_STRICT = '0';
    vi.resetModules();
    laxVisible = (await import('../../src/domain/sourceDocuments/mobile-visibility.js'))
      .mobileVisibleSourceDocumentSql;
    laxVisible();
  });

  afterAll(async () => {
    await sql_`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql_`DELETE FROM bundle_import_items WHERE bundle_id IN
                 (SELECT id FROM source_bundles WHERE site_id = ${siteId})`;
    await sql_`DELETE FROM ingest_events WHERE bundle_id IN
                 (SELECT id FROM source_bundles WHERE site_id = ${siteId})`;
    await sql_`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await sql_`DELETE FROM counterparties WHERE id = ${contractorId}`;
    await sql_`DELETE FROM sites WHERE id = ${siteId}`;
    await sql_.end();
    delete process.env.PORTAL_GROUPS_STRICT;
  });

  it('портальный пакет без логической сборки на планшет не едет', async () => {
    const b = randomUUID();
    const d = randomUUID();
    await bundle(b); // legacy: сборка откатилась на «файл = документ»
    await markPublic(b);
    await doc(d, b);

    // Документ сам по себе готов: parsed, реквизиты на месте, файлов без
    // документа нет. Прячет его именно происхождение — это машина, которую
    // ещё не собрали.
    expect(await visible(strictVisible, d)).toBe(false);
  });

  it('с выключенным флагом тот же документ виден — прежнее поведение', async () => {
    const b = randomUUID();
    const d = randomUUID();
    await bundle(b);
    await markPublic(b);
    await doc(d, b);

    expect(await visible(laxVisible, d)).toBe(true);
  });

  it('опубликованная логическая поставка едет и в строгом режиме', async () => {
    const b = randomUUID();
    const d = randomUUID();
    await bundle(b, { assembly: 'logical_v1', published: 0, active: 0 });
    await markPublic(b);
    await doc(d, b);

    expect(await visible(strictVisible, d)).toBe(true);
  });

  it('поколение поднято, а публикация осталась на прошлом — поставка скрыта', async () => {
    const b = randomUUID();
    const d = randomUUID();
    // Повторная отправка комплекта: active вырос, published отстал. Группа в
    // промежуточном состоянии — половина документов нового поколения ещё
    // создаётся.
    await bundle(b, { assembly: 'logical_v1', published: 0, active: 1 });
    await markPublic(b);
    await doc(d, b);

    expect(await visible(strictVisible, d)).toBe(false);
  });

  it('непортальный пакет правилом не затронут', async () => {
    const b = randomUUID();
    const d = randomUUID();
    // Ни одного ingest_events с channel='public' — почта или внутренняя
    // загрузка. Там пачка файлов не означает один рейс.
    await bundle(b);
    await doc(d, b);

    expect(await visible(strictVisible, d)).toBe(true);
  });

  it('файл, не попавший в хранилище, блокирует машину и внутри logical_v1', async () => {
    const b = randomUUID();
    const d = randomUUID();
    await bundle(b, { assembly: 'logical_v1', published: 0, active: 0 });
    await markPublic(b);
    await doc(d, b);

    // Сам документ готов и поставка опубликована — до этой строки виден.
    expect(await visible(strictVisible, d)).toBe(true);

    // Строка реестра БЕЗ ключа S3: форма файл приняла, хранилище не взяло.
    // Документа по нему нет и не появится, пока его не дозагрузят, — значит
    // машина неполная, и ехать ей нельзя.
    await sql_`INSERT INTO bundle_import_items
        (bundle_id, source_filename, input_s3_key, content_sha256, upload_generation,
         input_order, status, effective_status)
      VALUES (${b}, 'lost.pdf', NULL, ${'a'.repeat(64)}, 0, 1, 'failed', 'failed')`;

    expect(await visible(strictVisible, d)).toBe(false);
  });
});
