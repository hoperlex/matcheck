/**
 * Повторная отправка того же комплекта: когда пакет пересобирается, а когда нет.
 *
 * Инцидент, из-за которого набор появился (боевой пакет 7d4be3f8 на объекте
 * TEST, 14.08.2026): поставщик прислал шесть фото, сборка свернула их в три
 * накладных и опубликовала. Менеджер удалил документы, поставщик прислал ТЕ ЖЕ
 * шесть файлов повторно — и они залипли. Файлы приняли, но до распознавания они
 * не дошли: `job_attempts = 0`, ни одного вызова модели, шесть строк
 * «не распознано» вместо трёх накладных.
 *
 * Причина была не в распознавании. `active_upload_generation` не
 * инкрементировалось нигде в коде — только читалось, и у всех пакетов оставалось
 * нулём. Ключ дочернего пакета (`assembly:<root>:<generation>`) при повторной
 * отправке совпадал с прошлым, вставка гасилась onConflictDoNothing, задание не
 * ставилось.
 *
 * Что здесь проверяется и не проверяется больше нигде:
 *   * ПОКОЛЕНИЕ РАСТЁТ при пересборке — без этого все ключи, завязанные на него,
 *     остаются прошлыми, и повтор уходит в мёртвую зону;
 *   * ДОКУМЕНТЫ ПРОШЛОГО ПОКОЛЕНИЯ УБИРАЮТСЯ. Реестр нового поколения заводится
 *     на ВСЕ файлы пачки, поэтому уцелевшие документы дали бы задвоение: три
 *     файла → пять документов. Инвариант видимости этого не ловит: он
 *     спрашивает «есть ли документ по s3Key», а документ есть;
 *   * ЗАНЯТЫЙ ОПЕРАЦИЕЙ ПАКЕТ НЕ ТРОГАЕТСЯ. Пересборка завела бы вторые
 *     документы на те же файлы, а приёмка осталась бы ссылаться на первые — с
 *     расходящимся составом материалов;
 *   * ПАКЕТ В РАБОТЕ НЕ ТРОГАЕТСЯ. Между приёмом и разбором у пакета есть ровно
 *     одна служебная запись в queued, и она техническая: не считать её — значит
 *     пересобирать поверх идущего разбора.
 *
 * Запуск: см. заголовок upload-documents-characterization.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ putObject: vi.fn(), queueAdd: vi.fn() }));

vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  putObject: mocks.putObject,
  presign: vi.fn(),
}));
vi.mock('../../src/domain/storage/s3.path.js', () => ({
  buildS3Key: (o: { entityId: string; filename: string }) => `test/${o.entityId}/${o.filename}`,
}));

const { ingestDocumentsBundle } = await import(
  '../../src/domain/sourceDocuments/ingest-bundle.js'
);

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('повторная отправка комплекта (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  const siteId = randomUUID();
  const statusId = randomUUID();

  const log = { error: vi.fn(), warn: vi.fn() };
  const queue = { add: mocks.queueAdd };

  /** Два файла с разным содержимым — «пачка одной машины». */
  const files = () => [
    { filename: 'upd-1.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 first') },
    { filename: 'upd-2.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 second') },
  ];

  const ingest = () =>
    ingestDocumentsBundle(
      { db, queue: queue as never, log },
      {
        files: files(),
        direction: 'inbound',
        siteId,
        actorUserId: null,
        dispatch: 'direct',
        concurrency: 'legacy',
      },
    );

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql);
    await sql`INSERT INTO sites (id, code, name)
              VALUES (${siteId}, ${`RST${Date.now() % 10000}`}, 'Повтор пачки')`;
    await sql`INSERT INTO statuses (id, entity_type, code, label, sort_order)
              VALUES (${statusId}, 'delivery', ${`rst-${Date.now() % 10000}`}, 'Повтор', 998)`;
  });

  afterEach(async () => {
    // Между сценариями пакет должен исчезать целиком: идемпотентность считает
    // ключ по объекту и содержимому, и остаток прошлого теста слился бы с новым.
    await sql`DELETE FROM operation_group_claims WHERE group_id IN
                (SELECT id FROM source_bundles WHERE site_id = ${siteId})`;
    await sql`DELETE FROM delivery_sources WHERE delivery_id IN
                (SELECT id FROM deliveries WHERE site_id = ${siteId})`;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM bundle_import_items WHERE bundle_id IN
                (SELECT id FROM source_bundles WHERE site_id = ${siteId})`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await sql`DELETE FROM entity_deletions WHERE site_id = ${siteId}`;
    mocks.queueAdd.mockClear();
    log.warn.mockClear();
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM statuses WHERE id = ${statusId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end();
  });

  /** Приводит пакет в состояние «разбор закончен»: убирает служебную запись. */
  async function finishParsing(bundleId: string, docNumbers: string[]): Promise<string[]> {
    await sql`DELETE FROM source_documents WHERE bundle_id = ${bundleId} AND is_technical = true`;
    const keys = await sql<{ input_s3_key: string }[]>`
      SELECT input_s3_key FROM bundle_import_items
       WHERE bundle_id = ${bundleId} ORDER BY input_order`;
    const ids: string[] = [];
    for (const [i, num] of docNumbers.entries()) {
      const id = randomUUID();
      await sql`INSERT INTO source_documents
                  (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
                   doc_number, doc_date, total_sum, bundle_id)
                VALUES (${id}, 'upd', false, 'inbound', 'manual_pdf', 'parsed', ${siteId}, now(),
                        ${num}, now(), 100, ${bundleId})`;
      await sql`INSERT INTO source_document_attachments
                  (source_document_id, s3_key, filename, mime_type, size_bytes, role)
                VALUES (${id}, ${keys[i].input_s3_key}, ${`f${i}.pdf`}, 'application/pdf', 10, 'original')`;
      ids.push(id);
    }
    await sql`UPDATE bundle_import_items SET status = 'created', resolved_at = now()
               WHERE bundle_id = ${bundleId}`;
    await sql`UPDATE source_bundles SET status = 'parsed' WHERE id = ${bundleId}`;
    return ids;
  }

  it('пакет в разборе не пересобирается: служебная запись queued — это «идёт работа»', async () => {
    const first = await ingest();
    expect(first.outcome).toBe('created');

    // Воркер ещё не отработал: у пакета только служебная запись.
    const second = await ingest();
    expect(second.outcome).toBe('reused');

    const [bundle] = await sql`SELECT active_upload_generation AS gen FROM source_bundles
                                WHERE id = ${first.bundleId}`;
    expect(bundle.gen).toBe(0);
  });

  it('полный комплект не пересобирается', async () => {
    const first = await ingest();
    await finishParsing(first.bundleId, ['ПОВ-1', 'ПОВ-2']);

    const second = await ingest();
    expect(second.outcome).toBe('reused');

    const docs = await sql`SELECT count(*)::int AS n FROM source_documents
                            WHERE bundle_id = ${first.bundleId} AND is_technical = false`;
    expect(docs[0].n).toBe(2);
  });

  it('после удаления одного документа комплект восстанавливается новым поколением', async () => {
    const first = await ingest();
    const [docA] = await finishParsing(first.bundleId, ['ПОВ-1', 'ПОВ-2']);

    // Менеджер удалил одну УПД.
    await sql`DELETE FROM source_documents WHERE id = ${docA}`;

    const second = await ingest();
    expect(second.outcome).toBe('created');
    expect(second.bundleId).toBe(first.bundleId);

    const [bundle] = await sql`SELECT active_upload_generation AS gen, status FROM source_bundles
                                WHERE id = ${first.bundleId}`;
    // Поколение выросло — иначе ключи дочерних пакетов остались бы прошлыми.
    expect(bundle.gen).toBe(1);
    expect(bundle.status).toBe('queued');

    // Уцелевший документ убран: иначе router завёл бы вторую пару поверх него.
    const live = await sql`SELECT count(*)::int AS n FROM source_documents
                            WHERE bundle_id = ${first.bundleId} AND is_technical = false`;
    expect(live[0].n).toBe(0);

    // И планшет об удалении узнает — tombstone на месте.
    const tombstones = await sql`SELECT count(*)::int AS n FROM entity_deletions
                                  WHERE entity_type = 'source_document' AND site_id = ${siteId}`;
    expect(tombstones[0].n).toBeGreaterThan(0);

    // Реестр нового поколения заведён на все файлы пачки.
    const items = await sql`SELECT count(*)::int AS n FROM bundle_import_items
                             WHERE bundle_id = ${first.bundleId} AND upload_generation = 1`;
    expect(items[0].n).toBe(2);
  });

  it('пакет, чьи документы уже в приёмке, не пересобирается', async () => {
    const first = await ingest();
    const [docA, docB] = await finishParsing(first.bundleId, ['ПОВ-1', 'ПОВ-2']);

    // Инспектор принял машину: документы уехали в приёмку.
    const deliveryId = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, status_id)
              VALUES (${deliveryId}, ${siteId}, ${statusId})`;
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id)
              VALUES (${deliveryId}, ${docB})`;

    // Второй документ удалён — комплект неполон, но трогать пакет нельзя.
    await sql`DELETE FROM source_documents WHERE id = ${docA}`;

    const second = await ingest();
    expect(second.outcome).toBe('reused');

    const [bundle] = await sql`SELECT active_upload_generation AS gen FROM source_bundles
                                WHERE id = ${first.bundleId}`;
    expect(bundle.gen).toBe(0);

    // Документ приёмки на месте: пересборка снесла бы его вместе с привязкой.
    const survived = await sql`SELECT count(*)::int AS n FROM source_documents WHERE id = ${docB}`;
    expect(survived[0].n).toBe(1);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ documents: expect.any(Array) }),
      expect.stringContaining('уже в операции'),
    );
  });
});
