/**
 * Инвариант завершённости реестра входных файлов (реальный PostgreSQL).
 *
 * Гарантия, ради которой всё это заводилось: у пакета, объявленного
 * разобранным, не остаётся строк «в процессе», а файл, из которого не вышло
 * живого документа, остаётся видимым. Здесь проверяется механика обоих путей —
 * её вызывают и router-job, и обработчик исчерпанных ретраев, и периодический
 * repair.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { createHash, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import {
  finalizeStaleRegistryItems,
  markSubBundleItemsFailed,
  selectBundlesWithStaleItems,
  selectExtraFiles,
} from '../../src/domain/sourceDocuments/bundle-import-registry.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('инвариант завершённости реестра (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  const siteId = randomUUID();

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql) as unknown as Db;
    await sql`INSERT INTO sites (id, code, name)
      VALUES (${siteId}, ${`RGI${Date.now() % 10000}`}, 'Реестр')`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  });

  /** Пакет с одной строкой реестра в заданном статусе. */
  async function bundleWithItem(
    status: string,
    opts: { generation?: number | null; parentId?: string | null; s3Key?: string | null } = {},
  ): Promise<{ bundleId: string; itemId: string }> {
    const id = randomUUID();
    const hash = createHash('sha256').update(id).digest('hex');
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, kind, direction, site_id, status, parent_bundle_id)
      VALUES (${id}, ${hash}, 'mixed', 'inbound', ${siteId}, 'parsed', ${opts.parentId ?? null})`;
    const generation = opts.generation === undefined ? 0 : opts.generation;
    const s3Key = opts.s3Key === undefined ? `upload/${id}/file.pdf` : opts.s3Key;
    const [item] = await sql<{ id: string }[]>`
      INSERT INTO bundle_import_items
        (bundle_id, source_filename, input_s3_key, mime_type, size_bytes, upload_generation, status)
      VALUES (${id}, 'file.pdf', ${s3Key}, 'application/pdf', 100, ${generation}, ${status})
      RETURNING id`;
    return { bundleId: id, itemId: item!.id };
  }

  const itemById = (id: string) =>
    sql<
      { status: string; effective_status: string | null; reason: string | null }[]
    >`SELECT status, effective_status, reason FROM bundle_import_items WHERE id = ${id}`;

  it('строки «в процессе» закрываются как failed', async () => {
    const { bundleId, itemId } = await bundleWithItem('accepted');

    const closed = await finalizeStaleRegistryItems(db, bundleId);

    expect(closed.map((c) => c.filename)).toEqual(['file.pdf']);
    const [row] = await itemById(itemId);
    // Оба поля: по status файл попадает в дополнительные, по effective_status
    // его видит проверка «ни один принятый файл не потерян».
    expect(row).toMatchObject({ status: 'failed', effective_status: 'failed' });
  });

  it('строка без ключа S3 тоже закрывается — она и есть худший случай', async () => {
    // Именно такие строки нашлись на бою: 12 needs_review + 1 failed, все с
    // input_s3_key IS NULL. Разбор до них не доходит вовсе, и без явного
    // закрытия они висят «в процессе» вечно.
    const { bundleId, itemId } = await bundleWithItem('needs_review', { s3Key: null });

    await finalizeStaleRegistryItems(db, bundleId);

    expect((await itemById(itemId))[0]).toMatchObject({ status: 'failed' });
  });

  it('терминальные строки и чужие поколения не трогаются', async () => {
    const { bundleId, itemId } = await bundleWithItem('created');
    // Брошенная попытка загрузки: поколение ниже активного.
    const [old] = await sql<{ id: string }[]>`
      INSERT INTO bundle_import_items
        (bundle_id, source_filename, input_s3_key, mime_type, size_bytes, upload_generation, status)
      VALUES (${bundleId}, 'old.pdf', ${`upload/${bundleId}/old.pdf`}, 'application/pdf', 100,
              -1, 'accepted')
      RETURNING id`;

    const closed = await finalizeStaleRegistryItems(db, bundleId);

    expect(closed).toHaveLength(0);
    expect((await itemById(itemId))[0]!.status).toBe('created');
    expect((await itemById(old!.id))[0]!.status).toBe('accepted');
  });

  it('разобранное вручную повторно не закрывается', async () => {
    const { bundleId, itemId } = await bundleWithItem('needs_review');
    await sql`UPDATE bundle_import_items SET resolved_at = now() WHERE id = ${itemId}`;

    const closed = await finalizeStaleRegistryItems(db, bundleId);

    expect(closed).toHaveLength(0);
    expect((await itemById(itemId))[0]!.status).toBe('needs_review');
  });

  it('провал дочернего пакета помечает родительскую строку, не меняя status', async () => {
    const { bundleId, itemId } = await bundleWithItem('created');
    const subId = randomUUID();
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, kind, direction, site_id, status, parent_bundle_id)
      VALUES (${subId}, ${createHash('sha256').update(subId).digest('hex')}, 'waybill',
              'inbound', ${siteId}, 'parse_failed', ${bundleId})`;
    await sql`UPDATE bundle_import_items SET sub_bundle_id = ${subId} WHERE id = ${itemId}`;

    const marked = await markSubBundleItemsFailed(db, subId, 'накладная не распознана');

    expect(marked).toHaveLength(1);
    const [row] = await itemById(itemId);
    // status остаётся created намеренно: повторный прогон router'а видит по
    // нему «файл уже развёрнут» и не создаёт второй дочерний пакет.
    expect(row).toMatchObject({
      status: 'created',
      effective_status: 'failed',
      reason: 'накладная не распознана',
    });
  });

  it('файл провалившейся накладной попадает в дополнительные файлы поставки', async () => {
    const { bundleId, itemId } = await bundleWithItem('created');
    await sql`UPDATE bundle_import_items SET effective_status = 'failed' WHERE id = ${itemId}`;

    const files = await selectExtraFiles(db, bundleId);

    expect(files.map((f) => f.filename)).toEqual(['file.pdf']);
  });

  it('закрытый пакет с незавершённой строкой попадает в периодическую проверку', async () => {
    const { bundleId } = await bundleWithItem('needs_review');
    // Порог: свежий пакет ещё имеет право разбираться.
    expect(await selectBundlesWithStaleItems(db, 45, 50)).not.toContain(bundleId);

    await sql`UPDATE source_bundles SET updated_at = now() - interval '90 minutes'
               WHERE id = ${bundleId}`;

    expect(await selectBundlesWithStaleItems(db, 45, 50)).toContain(bundleId);
  });
});
