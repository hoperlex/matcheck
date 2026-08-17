/**
 * Перевод зависшего пакета в терминальное состояние.
 *
 * Router ставит пакету `processing`, если запустил сборку логических УПД, и
 * рассчитывает, что до терминала его доведёт публикация. Ветка ОТКАТА сборки
 * этого не делала — пакет оставался в `processing` навсегда, а `repairStuckJobs`
 * ищет только `queued` и такой пакет не подбирает. На боевой БД так зависли
 * 7 пакетов, и это ровно все откаты сборки.
 *
 * Главное, что здесь проверяется, — функция не может вызвать повторное
 * распознавание: она не ставит заданий вовсе, и на это есть отдельный assert по
 * пустому `job_outbox`. Второе по важности — она не воскрешает то, что закрыл
 * человек.
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
  finalizeBundleTerminalState,
  selectStuckProcessingBundles,
} from '../../src/domain/sourceDocuments/bundle-finalize.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('финализация зависшего пакета (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  const siteId = randomUUID();

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql) as unknown as Db;
    await sql`INSERT INTO sites (id, code, name)
      VALUES (${siteId}, ${`FIN${Date.now() % 10000}`}, 'Финализация')`;
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup();
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM bundle_import_items WHERE bundle_id IN
      (SELECT id FROM source_bundles WHERE site_id = ${siteId})`;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  }

  beforeEach(cleanup);

  const ago = (m: number) => `${m} minutes`;

  /** Пакет в processing, «без движения» age минут. */
  async function stuckBundle(
    age: number,
    opts: { status?: string; published?: boolean; parent?: string | null } = {},
  ): Promise<string> {
    const id = randomUUID();
    const hash = createHash('sha256').update(id).digest('hex');
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, kind, direction, site_id, status, updated_at,
         published_generation, parent_bundle_id)
      VALUES (${id}, ${hash}, 'mixed', 'inbound', ${siteId}, ${opts.status ?? 'processing'},
        now() - ${ago(age)}::interval, ${opts.published ? 0 : null}, ${opts.parent ?? null})`;
    return id;
  }

  /** Видимый разобранный УПД: CHECK source_upd_required требует реквизиты. */
  async function realDocument(bundleId: string): Promise<void> {
    await sql`INSERT INTO source_documents
        (kind, is_technical, direction, origin, status, site_id, bundle_id,
         doc_number, doc_date, total_sum)
      VALUES ('upd', false, 'inbound', 'manual_pdf', 'parsed', ${siteId}, ${bundleId},
        'УТ-1', current_date, 1000)`;
  }

  async function technicalDocument(bundleId: string): Promise<void> {
    await sql`INSERT INTO source_documents
        (kind, is_technical, direction, origin, status, site_id, bundle_id, queued_at)
      VALUES ('transport_waybill', true, 'inbound', 'manual_pdf', 'queued', ${siteId},
        ${bundleId}, now())`;
  }

  async function registryRow(
    bundleId: string,
    opts: { status?: string; resolved?: boolean } = {},
  ): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO bundle_import_items
        (id, bundle_id, source_filename, status, upload_generation, input_s3_key, resolved_at)
      VALUES (${id}, ${bundleId}, 'upd.pdf', ${opts.status ?? 'accepted'}, 0,
        ${`upload/${id}.pdf`}, ${opts.resolved ? sql`now()` : null})`;
    return id;
  }

  const statusOf = async (id: string): Promise<string> => {
    const [row] = await sql<{ status: string }[]>`
      SELECT status FROM source_bundles WHERE id = ${id}`;
    return row!.status;
  };

  const itemStatus = async (id: string): Promise<{ status: string; effective: string | null }> => {
    const [row] = await sql<{ status: string; effective_status: string | null }[]>`
      SELECT status, effective_status FROM bundle_import_items WHERE id = ${id}`;
    return { status: row!.status, effective: row!.effective_status };
  };

  it('есть живой документ → пакет parsed', async () => {
    const id = await stuckBundle(60);
    await realDocument(id);

    const res = await finalizeBundleTerminalState(db, id);

    expect(res.outcome).toBe('parsed');
    expect(res.documents).toBe(1);
    expect(await statusOf(id)).toBe('parsed');
  });

  it('документов нет → пакет parse_failed', async () => {
    const id = await stuckBundle(60);

    const res = await finalizeBundleTerminalState(db, id);

    expect(res.outcome).toBe('parse_failed');
    expect(await statusOf(id)).toBe('parse_failed');
  });

  it('документ лежит в дочернем пакете — это тоже «разобрано»', async () => {
    // Накладные router разворачивает отдельным пакетом, и реальный документ
    // висит уже на нём: без этой ветки родитель ушёл бы в parse_failed.
    const root = await stuckBundle(60);
    const child = await stuckBundle(60, { status: 'parsed', parent: root });
    await realDocument(child);

    const res = await finalizeBundleTerminalState(db, root);

    expect(res.outcome).toBe('parsed');
    expect(await statusOf(root)).toBe('parsed');
  });

  it('ни одного задания в очередь: повторное распознавание невозможно', async () => {
    const id = await stuckBundle(60);
    await realDocument(id);
    const before = await sql<{ n: string }[]>`SELECT count(*) AS n FROM job_outbox`;

    await finalizeBundleTerminalState(db, id);

    const after = await sql<{ n: string }[]>`SELECT count(*) AS n FROM job_outbox`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('терминальный пакет не трогаем', async () => {
    const id = await stuckBundle(60, { status: 'parsed' });

    const res = await finalizeBundleTerminalState(db, id);

    expect(res.outcome).toBe('skipped');
    expect(res.skipReason).toBe('уже терминальный');
  });

  it('опубликованное поколение не перебиваем', async () => {
    // Пока откат разворачивал файлы, параллельная публикация могла успеть
    // объявить поколение опубликованным — отбирать у неё статус нельзя.
    // Фикстура публикует поколение 0, и откат идёт по нему же.
    const id = await stuckBundle(60, { published: true });

    const res = await finalizeBundleTerminalState(db, id, {
      requireUnpublished: true,
      generation: 0,
    });

    expect(res.outcome).toBe('skipped');
    expect(res.skipReason).toBe('опубликован');
    expect(await statusOf(id)).toBe('processing');
  });

  it('публикация ПРОШЛОГО поколения откату не мешает', async () => {
    // Ровно случай повторной загрузки: комплект публиковался поколением 0,
    // документы удалили, файлы отправили заново — активное поколение стало 1.
    // Сравнение с null объявляло бы такой пакет опубликованным, и откат не
    // закрывал бы его: пакет висел в processing, а файлы оставались без разбора.
    const id = await stuckBundle(60, { published: true });

    const res = await finalizeBundleTerminalState(db, id, {
      requireUnpublished: true,
      generation: 1,
    });

    expect(res.outcome).not.toBe('skipped');
    expect(await statusOf(id)).not.toBe('processing');
  });

  it('строка реестра «в процессе» закрывается — иначе файл не виден нигде', async () => {
    const id = await stuckBundle(60);
    const item = await registryRow(id, { status: 'accepted' });

    const res = await finalizeBundleTerminalState(db, id);

    expect(res.finalizedItems).toBe(1);
    expect(await itemStatus(item)).toEqual({ status: 'failed', effective: 'failed' });
  });

  it('разобранное человеком не переоткрываем', async () => {
    const id = await stuckBundle(60);
    const item = await registryRow(id, { status: 'accepted', resolved: true });

    await finalizeBundleTerminalState(db, id);

    expect((await itemStatus(item)).status).toBe('accepted');
  });

  describe('отбор зависших', () => {
    const stuck = () => selectStuckProcessingBundles(db, 45, 50);

    it('пакет без движения дольше порога берётся', async () => {
      const id = await stuckBundle(60);
      expect(await stuck()).toContain(id);
    });

    it('свежий пакет не берём — разбор мог ещё идти', async () => {
      const id = await stuckBundle(5);
      expect(await stuck()).not.toContain(id);
    });

    it('жива техническая запись → это упавший router, а не «нечего делать»', async () => {
      const id = await stuckBundle(60);
      await technicalDocument(id);
      expect(await stuck()).not.toContain(id);
    });

    it('дочерний пакет ещё в работе → родителя не трогаем', async () => {
      const id = await stuckBundle(60);
      await stuckBundle(60, { status: 'queued', parent: id });
      expect(await stuck()).not.toContain(id);
    });

    it('дочерние пакеты сами по себе не берутся', async () => {
      const root = await stuckBundle(60, { status: 'parsed' });
      const child = await stuckBundle(60, { parent: root });
      expect(await stuck()).not.toContain(child);
    });

    it('есть недоставленное задание по пакету → работа впереди', async () => {
      const id = await stuckBundle(60);
      const key = `bundle~${id}~parse~0`;
      await sql`INSERT INTO job_outbox (queue, job_name, payload, dedupe_key)
        VALUES ('upd-parse', 'parse',
          ${JSON.stringify({ bundleId: id, mode: 'router' })}::jsonb, ${key})`;
      try {
        expect(await stuck()).not.toContain(id);
      } finally {
        await sql`DELETE FROM job_outbox WHERE dedupe_key = ${key}`;
      }
    });
  });
});
