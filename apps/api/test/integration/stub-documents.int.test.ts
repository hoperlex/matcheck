/**
 * Инвариант «принятый файл всегда виден документом» (реальный PostgreSQL).
 *
 * Проверяется то, ради чего инвариант и заводился: файл, из которого
 * распознавания не вышло, всё равно даёт видимую строку в «Документах» с
 * рабочим исходником. И то, чего делать нельзя: дубли при гонке, документы без
 * файла, воскрешение удалённого менеджером.
 *
 * Запуск — как у остальных int-наборов; без TEST_DATABASE_URL пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  headObject: vi.fn(),
  presign: vi.fn(),
  putObject: vi.fn(),
  getObject: vi.fn(),
}));

vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  headObject: mocks.headObject,
  presign: mocks.presign,
  putObject: mocks.putObject,
  getObject: mocks.getObject,
}));

const { ensureDocumentForRegistryRow, selectRowsWithoutDocument, stubReasonForRow } = await import(
  '../../src/domain/sourceDocuments/stub-documents.js'
);
const { closeRegistryRowsForDeletedDocument } = await import(
  '../../src/domain/sourceDocuments/stub-documents.js'
);

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('инвариант «принятый файл виден документом» (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  const siteId = randomUUID();
  const userId = randomUUID();

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql);
    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'STB'}, 'Stub docs')`;
    await sql`INSERT INTO users (id, email, password_hash, role)
      VALUES (${userId}, ${`stub-${userId}@test`}, 'x', 'manager')`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    mocks.headObject.mockReset().mockResolvedValue(true);
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  });

  /**
   * Пакет + строка реестра с файлом — состояние сразу после приёма.
   *
   * Дочерний пакет заводится здесь же: у строки реестра FK на sub_bundle_id, и
   * вставить её раньше пакета нельзя.
   */
  async function makeBundleWithFile(opts: {
    filename: string;
    processingMode?: 'auto' | 'store_only';
    detectedKind?: string | null;
    status?: string;
    subBundle?: { id: string; status: 'processing' | 'parsed' | 'parse_failed' };
  }) {
    const bundleId = randomUUID();
    await sql`INSERT INTO source_bundles (id, bundle_hash, kind, direction, site_id, status,
                                          active_upload_generation)
      VALUES (${bundleId}, ${randomUUID()}, 'mixed', 'inbound', ${siteId}, 'parsed', 0)`;
    if (opts.subBundle) {
      await sql`INSERT INTO source_bundles (id, bundle_hash, kind, direction, site_id, status,
                                            parent_bundle_id, active_upload_generation)
        VALUES (${opts.subBundle.id}, ${randomUUID()}, 'waybill', 'inbound', ${siteId},
                ${opts.subBundle.status}, ${bundleId}, 0)`;
    }
    const s3Key = `test/${bundleId}/${opts.filename}`;
    const [item] = await sql<{ id: string }[]>`
      INSERT INTO bundle_import_items
        (bundle_id, source_filename, input_s3_key, mime_type, size_bytes, upload_generation,
         processing_mode, detected_kind, status, sub_bundle_id)
      VALUES (${bundleId}, ${opts.filename}, ${s3Key}, 'application/pdf', 100, 0,
              ${opts.processingMode ?? 'auto'}, ${opts.detectedKind ?? null},
              ${opts.status ?? 'skipped'}, ${opts.subBundle?.id ?? null})
      RETURNING id`;
    return { bundleId, s3Key, itemId: item!.id };
  }

  async function bundleRow(bundleId: string) {
    const [row] = await sql`SELECT * FROM source_bundles WHERE id = ${bundleId}`;
    return row as never;
  }

  const docsOf = (bundleId: string) => sql<
    { id: string; kind: string; status: string; parse_error_code: string; is_technical: boolean }[]
  >`SELECT id, kind, status, parse_error_code, is_technical FROM source_documents
      WHERE bundle_id = ${bundleId}`;

  it('сертификат из зоны «Дополнительные» становится видимым документом с оригиналом', async () => {
    const { bundleId, s3Key, itemId } = await makeBundleWithFile({
      filename: 'cert.pdf',
      processingMode: 'store_only',
    });

    const rows = await selectRowsWithoutDocument(db as never, { bundleId });
    expect(rows).toHaveLength(1);
    const res = await ensureDocumentForRegistryRow({
      db: db as never,
      row: rows[0]!,
      bundle: await bundleRow(bundleId),
      reason: stubReasonForRow(rows[0]!),
    });
    expect(res.action).toBe('created');

    const docs = await docsOf(bundleId);
    expect(docs).toHaveLength(1);
    // Сопроводительному разбирать нечего — сразу в архив, но видимым.
    expect(docs[0]).toMatchObject({
      status: 'archived',
      parse_error_code: 'supplementary',
      is_technical: false,
    });

    // Видимость без исходника ничего не стоит: вложение должно указывать на тот
    // же объект, что принят.
    const attachments = await sql<{ s3_key: string; role: string }[]>`
      SELECT s3_key, role FROM source_document_attachments WHERE source_document_id = ${docs[0]!.id}`;
    expect(attachments).toEqual([{ s3_key: s3Key, role: 'original' }]);

    // Строка реестра больше не «пропавший файл» — иначе он повис бы ещё и в
    // блоке «дополнительные файлы» собственной карточки.
    const [item] = await sql<{ stub_document_id: string; effective_status: string }[]>`
      SELECT stub_document_id, effective_status FROM bundle_import_items WHERE id = ${itemId}`;
    expect(item).toMatchObject({ stub_document_id: docs[0]!.id, effective_status: 'created' });
  });

  it('нераспознанная накладная: показываем служебную запись, а не заводим вторую', async () => {
    const subId = randomUUID();
    // Дочерний пакет накладной кончился ничем, оригинал остался на служебной
    // записи — ровно то состояние, в котором файл пропадал из «Документов».
    const { bundleId, s3Key } = await makeBundleWithFile({
      filename: 'wb.pdf',
      detectedKind: 'transport_waybill',
      status: 'created',
      subBundle: { id: subId, status: 'parse_failed' },
    });
    const [tech] = await sql<{ id: string }[]>`
      INSERT INTO source_documents (kind, is_technical, direction, origin, status, site_id,
                                    bundle_id, queued_at, parse_error_code)
      VALUES ('transport_waybill', true, 'inbound', 'manual_pdf', 'parse_failed', ${siteId},
              ${subId}, now(), 'no_waybill_found')
      RETURNING id`;
    await sql`INSERT INTO source_document_attachments (source_document_id, s3_key, filename, role)
      VALUES (${tech!.id}, ${s3Key}, 'wb.pdf', 'original')`;

    const rows = await selectRowsWithoutDocument(db as never, { bundleId });
    expect(rows).toHaveLength(1);
    const res = await ensureDocumentForRegistryRow({
      db: db as never,
      row: rows[0]!,
      bundle: await bundleRow(bundleId),
      reason: stubReasonForRow(rows[0]!),
    });
    expect(res).toMatchObject({ action: 'promoted', documentId: tech!.id });

    // Второго документа на тот же файл быть не должно, а тип остаётся честным:
    // это накладная, а не УПД.
    const docs = await docsOf(subId);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      id: tech!.id,
      kind: 'transport_waybill',
      status: 'needs_resolution',
      is_technical: false,
    });
  });

  it('объекта нет в хранилище — документ не заводим, файл помечаем', async () => {
    mocks.headObject.mockResolvedValue(false);
    const { bundleId, itemId } = await makeBundleWithFile({
      filename: 'gone.pdf',
      processingMode: 'store_only',
    });

    const rows = await selectRowsWithoutDocument(db as never, { bundleId });
    const res = await ensureDocumentForRegistryRow({
      db: db as never,
      row: rows[0]!,
      bundle: await bundleRow(bundleId),
      reason: 'supplementary',
    });
    expect(res.action).toBe('missing_object');

    // Документ-призрак хуже отсутствия документа: он выглядит рабочим, а
    // открыть его нельзя.
    expect(await docsOf(bundleId)).toHaveLength(0);
    const [item] = await sql<{ status: string; reason: string }[]>`
      SELECT status, reason FROM bundle_import_items WHERE id = ${itemId}`;
    expect(item!.status).toBe('failed');
    expect(item!.reason).toContain('исходник недоступен');
  });

  it('два одновременных прохода создают ровно один документ', async () => {
    const { bundleId } = await makeBundleWithFile({
      filename: 'race.pdf',
      processingMode: 'store_only',
    });
    const rows = await selectRowsWithoutDocument(db as never, { bundleId });
    const bundle = await bundleRow(bundleId);

    // router-job и repair могут сойтись на одной строке: блокировка и повторная
    // проверка внутри транзакции обязаны это выдержать.
    const results = await Promise.all([
      ensureDocumentForRegistryRow({ db: db as never, row: rows[0]!, bundle, reason: 'supplementary' }),
      ensureDocumentForRegistryRow({ db: db as never, row: rows[0]!, bundle, reason: 'supplementary' }),
    ]);

    expect(await docsOf(bundleId)).toHaveLength(1);
    expect(results.filter((r) => r.action === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.action === 'exists')).toHaveLength(1);
  });

  it('повторный проход по уже обработанной строке ничего не меняет', async () => {
    const { bundleId } = await makeBundleWithFile({
      filename: 'idem.pdf',
      processingMode: 'store_only',
    });
    const bundle = await bundleRow(bundleId);
    const first = await selectRowsWithoutDocument(db as never, { bundleId });
    await ensureDocumentForRegistryRow({
      db: db as never,
      row: first[0]!,
      bundle,
      reason: 'supplementary',
    });

    // Главное: строка ушла из выборки. Иначе каждый прогон repair плодил бы
    // документы на один и тот же файл.
    expect(await selectRowsWithoutDocument(db as never, { bundleId })).toHaveLength(0);
    expect(await docsOf(bundleId)).toHaveLength(1);
  });

  it('удалённый менеджером документ не воскресает', async () => {
    const { bundleId, itemId } = await makeBundleWithFile({
      filename: 'deleted.pdf',
      processingMode: 'store_only',
    });
    const bundle = await bundleRow(bundleId);
    const rows = await selectRowsWithoutDocument(db as never, { bundleId });
    const created = await ensureDocumentForRegistryRow({
      db: db as never,
      row: rows[0]!,
      bundle,
      reason: 'supplementary',
    });
    const docId = (created as { documentId: string }).documentId;

    // Удаление документа чистит и S3-объект, поэтому воскрешать заглушку
    // нельзя — получился бы документ со ссылкой в никуда.
    await closeRegistryRowsForDeletedDocument(db as never, docId, userId);
    await sql`DELETE FROM source_documents WHERE id = ${docId}`;

    expect(await selectRowsWithoutDocument(db as never, { bundleId })).toHaveLength(0);
    const [item] = await sql<{ resolved_at: Date | null; stub_document_id: string | null }[]>`
      SELECT resolved_at, stub_document_id FROM bundle_import_items WHERE id = ${itemId}`;
    expect(item!.resolved_at).not.toBeNull();
    // FK обнулила ссылку сама — на этом и держится проверка «документ жив».
    expect(item!.stub_document_id).toBeNull();
  });

  it('файл в живом дочернем пакете не трогаем — там работа ещё идёт', async () => {
    const { bundleId } = await makeBundleWithFile({
      filename: 'in-progress.pdf',
      detectedKind: 'transport_waybill',
      status: 'created',
      subBundle: { id: randomUUID(), status: 'processing' },
    });

    expect(await selectRowsWithoutDocument(db as never, { bundleId })).toHaveLength(0);
  });

  it('файл с живым документом в выборку не попадает', async () => {
    const { bundleId, s3Key } = await makeBundleWithFile({
      filename: 'ok.pdf',
      status: 'created',
    });
    // Реквизиты обязательны: CHECK source_upd_required не пускает УПД в
    // `parsed` без номера, даты и суммы.
    const [doc] = await sql<{ id: string }[]>`
      INSERT INTO source_documents (kind, direction, origin, status, site_id, bundle_id, queued_at,
                                    doc_number, doc_date, total_sum)
      VALUES ('upd', 'inbound', 'manual_pdf', 'parsed', ${siteId}, ${bundleId}, now(),
              'A-1', now(), 100)
      RETURNING id`;
    await sql`INSERT INTO source_document_attachments (source_document_id, s3_key, filename, role)
      VALUES (${doc!.id}, ${s3Key}, 'ok.pdf', 'original')`;

    expect(await selectRowsWithoutDocument(db as never, { bundleId })).toHaveLength(0);
  });
});
