/**
 * Общий S3-объект переживает удаление одного из своих документов.
 *
 * Один файл штатно принадлежит нескольким source_documents: пачка накладных
 * дублирует attachments на каждый созданный документ, страницы одного PDF
 * расходятся по разным документам сборки УПД, слияние дубликатов копирует
 * вложения на keeper. При удалении документа в очередь чистки уходят ВСЕ его
 * ключи, поэтому перед физическим удалением нужно спросить, кто ещё ссылается
 * на объект: иначе удаление одной накладной из пачки оставляет соседей со
 * ссылкой в никуда.
 *
 * Запуск — как у остальных int-наборов; без TEST_DATABASE_URL пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const { selectUnreferencedS3Keys } = await import(
  '../../src/domain/sourceDocuments/s3-key-usage.js'
);

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('ссылки на S3-объект (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  const siteId = randomUUID();
  const bundleId = randomUUID();
  const prefix = `s3-usage/${randomUUID()}`;

  const keyOf = (name: string) => `${prefix}/${name}`;

  async function documentWithAttachments(...keys: string[]) {
    const id = randomUUID();
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, bundle_id,
         doc_number, parsed_at)
      VALUES (${id}, 'upd', false, 'inbound', 'manual_pdf', 'parsed', ${siteId}, ${bundleId},
              ${`S3U-${id.slice(0, 8)}`}, now())`;
    for (const key of keys) {
      await sql`INSERT INTO source_document_attachments (source_document_id, s3_key, filename, role)
                VALUES (${id}, ${key}, 'doc.pdf', 'original')`;
    }
    return id;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql);
    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'S3U'}, 'S3 key usage')`;
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, kind, direction, site_id, status, active_upload_generation)
      VALUES (${bundleId}, ${randomUUID()}, 'mixed', 'inbound', ${siteId}, 'parsed', 0)`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE id = ${bundleId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
  });

  it('ключ, за который держится другой документ, к удалению не предлагается', async () => {
    const shared = keyOf('batch.pdf');
    const removed = await documentWithAttachments(shared);
    await documentWithAttachments(shared);

    // Удаляем первый документ — его junction-строка уходит каскадом.
    await sql`DELETE FROM source_documents WHERE id = ${removed}`;

    expect(await selectUnreferencedS3Keys(db as never, [shared])).toEqual([]);
  });

  it('ключ последнего владельца удалять можно', async () => {
    const own = keyOf('single.pdf');
    const docId = await documentWithAttachments(own);
    await sql`DELETE FROM source_documents WHERE id = ${docId}`;

    expect(await selectUnreferencedS3Keys(db as never, [own])).toEqual([own]);
  });

  it('из смешанного списка отбираются только осиротевшие ключи', async () => {
    const shared = keyOf('shared.pdf');
    const orphan = keyOf('orphan.pdf');
    const removed = await documentWithAttachments(shared, orphan);
    await documentWithAttachments(shared);
    await sql`DELETE FROM source_documents WHERE id = ${removed}`;

    expect(await selectUnreferencedS3Keys(db as never, [shared, orphan])).toEqual([orphan]);
  });

  it('дубликаты во входе схлопываются, пустой список не ходит в базу', async () => {
    const orphan = keyOf('dup.pdf');
    expect(await selectUnreferencedS3Keys(db as never, [orphan, orphan])).toEqual([orphan]);
    expect(await selectUnreferencedS3Keys(db as never, [])).toEqual([]);
  });

  it('техническая запись пакета тоже держит объект', async () => {
    // Служебный документ снаружи не виден, но вложения на время разбора висят
    // именно на нём: снести его файл значит оборвать разбор.
    const key = keyOf('technical.pdf');
    const techId = randomUUID();
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, bundle_id)
      VALUES (${techId}, 'upd', true, 'inbound', 'manual_pdf', 'processing', ${siteId}, ${bundleId})`;
    await sql`INSERT INTO source_document_attachments (source_document_id, s3_key, filename, role)
              VALUES (${techId}, ${key}, 'doc.pdf', 'original')`;

    expect(await selectUnreferencedS3Keys(db as never, [key])).toEqual([]);
  });
});
