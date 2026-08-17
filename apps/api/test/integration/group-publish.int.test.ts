/**
 * Публикация собранного комплекта доносит до планшета ВСЮ машину.
 *
 * Дефект, ради которого набор написан. Накладная (и М-15) создаётся на корневом
 * пакете РАНЬШЕ публикации, когда assembly_version ещё 'legacy' и вычисляемый
 * group_id у неё NULL. Планшет, синхронизировавшийся в этот момент, кэширует её
 * одиночной карточкой. Публикация переводит корень в logical_v1 — group_id
 * накладной меняется САМ, ни одной записи в source_documents при этом не
 * происходит. Дальше планшет не узнаёт об изменении ни одним каналом:
 *   * дельта /sync отбирает по source_documents.updated_at — он не менялся;
 *   * reconcile отбирает по version > clientVersion — версии равны;
 *   * SSE лишь просит синхронизироваться той же дельтой.
 * Накладная остаётся у инспектора отдельной карточкой НАВСЕГДА: состояние не
 * лечится ни повторным синком, ни reconcile — только logout/login с очисткой.
 *
 * Существующий document-group.int.test.ts это не ловит: он проверяет вычисление
 * groupId у ЗАРАНЕЕ опубликованных записей и саму публикацию не выполняет.
 *
 * Запуск: см. заголовок sync-consignee.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishGroupDocuments } from '../../src/domain/sourceDocuments/document-group.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('публикация сборки: вся машина доезжает до планшета (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;

  const siteId = randomUUID();
  const rootBundleId = randomUUID();
  const waybillBundleId = randomUUID();
  const updBundleId = randomUUID();

  // Видимая ДО публикации — ровно тот документ, который терялся.
  const waybillId = randomUUID();
  // Сегменты сборки: пока технические, публикация снимет флаг.
  const segmentAId = randomUUID();
  const segmentBId = randomUUID();

  const hash = (s: string) => `${s}${randomUUID().replace(/-/g, '')}`.slice(0, 64);

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql);

    await sql`INSERT INTO sites (id, code, name)
              VALUES (${siteId}, ${`PUB${Date.now() % 10000}`}, 'Публикация машины')`;

    // Состояние ДО публикации: корень ещё legacy, поколение не опубликовано.
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, direction, site_id, status, doc_count, kind,
         assembly_version, published_generation, group_revision)
      VALUES (${rootBundleId}, ${hash('root')}, 'inbound', ${siteId}, 'processing', 0, 'mixed',
              'legacy', NULL, 1)`;
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, direction, site_id, status, doc_count, kind,
         assembly_version, parent_bundle_id, group_revision)
      VALUES (${waybillBundleId}, ${hash('wb')}, 'inbound', ${siteId}, 'parsed', 1, 'waybill',
              'legacy', ${rootBundleId}, 1)`;
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, direction, site_id, status, doc_count, kind,
         assembly_version, parent_bundle_id, group_revision)
      VALUES (${updBundleId}, ${hash('upd')}, 'inbound', ${siteId}, 'processing', 0, 'upd',
              'legacy', ${rootBundleId}, 1)`;

    const doc = (id: string, num: string, kind: string, bundleId: string, technical: boolean) => sql`
      INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum, bundle_id, version, updated_at)
      VALUES (${id}, ${kind}, ${technical}, 'inbound', 'manual_pdf', 'parsed', ${siteId}, now(),
              ${num}, now(), 100, ${bundleId}, 1, now() - interval '1 hour')`;

    await doc(waybillId, 'ПУБ-192', 'transport_waybill', waybillBundleId, false);
    await doc(segmentAId, 'ПУБ-1', 'upd', updBundleId, true);
    await doc(segmentBId, 'ПУБ-2', 'upd', updBundleId, true);
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE parent_bundle_id = ${rootBundleId}`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  it('бампает версию и у сегментов, и у уже видимой накладной — ровно на единицу', async () => {
    const before = await sql<{ id: string; version: number }[]>`
      SELECT id, version FROM source_documents WHERE site_id = ${siteId}`;
    const versionBefore = new Map(before.map((r) => [r.id, r.version]));
    expect(versionBefore.get(waybillId)).toBe(1);

    const now = new Date();
    await publishGroupDocuments(db, rootBundleId, [segmentAId, segmentBId], now);
    // Публикация переводит корень в logical_v1 — после этого group_id считается.
    await sql`UPDATE source_bundles
                 SET assembly_version = 'logical_v1', published_generation = 0
               WHERE id = ${rootBundleId}`;

    const after = await sql<{ id: string; version: number; is_technical: boolean }[]>`
      SELECT id, version, is_technical FROM source_documents WHERE site_id = ${siteId}`;
    const byId = new Map(after.map((r) => [r.id, r]));

    // Накладная: главное, ради чего всё. Раньше оставалась с version = 1.
    expect(byId.get(waybillId)!.version).toBe(2);
    // Сегменты опубликованы и НЕ получили двойной инкремент: один UPDATE, а не
    // два подряд — иначе version уехал бы на 3.
    for (const id of [segmentAId, segmentBId]) {
      expect(byId.get(id)!.is_technical, `сегмент ${id} остался техническим`).toBe(false);
      expect(byId.get(id)!.version, `сегмент ${id} получил двойной бамп`).toBe(2);
    }
  });

  it('updated_at сдвинут у всей машины — иначе дельта /sync её не заберёт', async () => {
    const rows = await sql<{ id: string; fresh: boolean }[]>`
      SELECT id, updated_at > now() - interval '5 minutes' AS fresh
        FROM source_documents WHERE site_id = ${siteId}`;
    for (const r of rows) {
      expect(r.fresh, `документ ${r.id} остался со старым updated_at`).toBe(true);
    }
  });

  it('после публикации все документы машины отдают один и тот же groupId', async () => {
    const rows = await sql<{ id: string; group_id: string | null }[]>`
      SELECT sd.id,
             (select case when root.assembly_version = 'logical_v1' then root.id end
                from source_bundles b
                join source_bundles root on root.id = coalesce(b.parent_bundle_id, b.id)
               where b.id = sd.bundle_id) AS group_id
        FROM source_documents sd WHERE sd.site_id = ${siteId}`;
    for (const r of rows) {
      expect(r.group_id, `документ ${r.id}`).toBe(rootBundleId);
    }
  });
});
