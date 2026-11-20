/**
 * Объединение машин: «Объединить в одну машину» / «Разъединить».
 *
 * Проверяется то, чего не видно в коде:
 *   * одна машина для планшета и портала (groupId, ревизия, portalGroupId) —
 *     ровно тем же SQL, что отдаёт /sync;
 *   * идемпотентность: повтор и пересекающиеся наборы не плодят цепочек;
 *   * каждый отказ ничего не пишет;
 *   * ревизия растёт линейно и строго для любого, кто смотрел на любой корень;
 *   * бамп из отправки-участника не трогает строку головы и всё же доносит
 *     изменение до всей машины;
 *   * гонки: пересекающиеся слияния, слияние × разъединение, два «разбора»
 *     разных отправок одной машины — без взаимных блокировок.
 *
 * Запуск: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../src/db/schema.js';
import type { Db } from '../../src/db/client.js';

vi.mock('../../src/instrument.js', () => ({}));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('объединение машин (реальный PostgreSQL)', { timeout: 120_000 }, () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  const siteA = randomUUID();
  const siteB = randomUUID();
  const supplier1 = randomUUID();
  const supplier2 = randomUUID();

  // Модули — после выставления окружения: loadEnv кеширует разбор.
  let mm: typeof import('../../src/domain/sourceDocuments/machine-merge.js');
  let dg: typeof import('../../src/domain/sourceDocuments/document-group.js');
  let lock: typeof import('../../src/domain/sourceDocuments/machine-lock.js');
  let retry: typeof import('../../src/lib/db-retry.js');

  let seq = 0;
  /** Отправка с /uploads. created_at растёт — порядок «самая ранняя» определён. */
  async function seedUpload(opts: { siteId?: string; date?: string; portal?: boolean } = {}) {
    const id = randomUUID();
    seq += 1;
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, direction, site_id, status, kind, assembly_version,
         active_upload_generation, expected_date, created_at, group_revision)
      VALUES (${id}, ${`mm${id.replace(/-/g, '')}`.slice(0, 64)}, 'inbound', ${opts.siteId ?? siteA},
              'parsed', 'mixed', 'legacy', 0, ${opts.date ?? '2026-11-19'},
              now() - make_interval(mins => ${1000 - seq}), 1)`;
    if (opts.portal !== false) {
      await sql`INSERT INTO ingest_events (bundle_id, channel, public_ticket)
                VALUES (${id}, 'public', ${randomUUID().slice(0, 20)})`;
    }
    return id;
  }

  async function seedDoc(
    bundleId: string | null,
    opts: {
      siteId?: string;
      date?: string;
      supplier?: string | null;
      status?: string;
      direction?: 'inbound' | 'outbound';
    } = {},
  ) {
    const id = randomUUID();
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum, bundle_id, expected_date, supplier_directory_id)
      VALUES (${id}, 'upd', false, ${opts.direction ?? 'inbound'}, 'manual_pdf',
              ${opts.status ?? 'parsed'}, ${opts.siteId ?? siteA}, now(),
              ${`MM-${id.slice(0, 6)}`}, now(), 100, ${bundleId}, ${opts.date ?? '2026-11-19'},
              ${opts.supplier === undefined ? supplier1 : opts.supplier})`;
    await sql`INSERT INTO source_document_items
        (source_document_id, name_raw, qty, unit, price, sum, line_no)
      VALUES (${id}, 'Труба', 1, 'шт', 100, 100, 1)`;
    return id;
  }

  /** Как /sync: groupId, ревизия и портальная машина тем же SQL. */
  async function machineOf(docId: string) {
    const [r] = await db
      .select({
        groupId: dg.documentGroupIdSql(),
        revision: dg.documentGroupRevisionSql(),
        portalGroupId: dg.portalDocumentGroupIdSql,
        portalSize: dg.portalDocumentGroupSizeSql,
      })
      .from(schema.sourceDocuments)
      .where(eq(schema.sourceDocuments.id, docId));
    return r!;
  }

  async function versionOf(docId: string) {
    const [r] = await sql<
      { version: number }[]
    >`SELECT version FROM source_documents WHERE id = ${docId}`;
    return r!.version;
  }

  async function bundleRevision(id: string) {
    const [r] = await sql<
      { group_revision: number }[]
    >`SELECT group_revision FROM source_bundles WHERE id = ${id}`;
    return r!.group_revision;
  }

  const merge = async (documentIds: string[], expected?: string[]) => {
    const exp = expected ?? (await mm.analyzeMerge(db, documentIds)).documentIds;
    return db.transaction((tx) =>
      mm.mergeMachines(tx as unknown as Db, {
        documentIds,
        expectedDocumentIds: exp,
        userId: null,
      }),
    );
  };
  const unmerge = async (documentId: string, mergeId?: string) => {
    const [m] = await sql<{ head: string }[]>`
      SELECT coalesce(mm.target_root_id, coalesce(b.parent_bundle_id, b.id)) AS head
        FROM source_documents sd JOIN source_bundles b ON b.id = sd.bundle_id
        LEFT JOIN machine_merges mm ON mm.member_root_id = coalesce(b.parent_bundle_id, b.id)
       WHERE sd.id = ${documentId}`;
    const docs = await sql<{ id: string }[]>`
      SELECT sd.id FROM source_documents sd JOIN source_bundles b ON b.id = sd.bundle_id
       WHERE coalesce(b.parent_bundle_id, b.id) IN (
         SELECT ${m!.head}::uuid UNION ALL SELECT member_root_id FROM machine_merges WHERE target_root_id = ${m!.head})
         AND sd.is_technical = false`;
    return db.transaction((tx) =>
      mm.unmergeMachine(tx as unknown as Db, {
        documentId,
        expectedDocumentIds: docs.map((d) => d.id),
        mergeId: mergeId ?? null,
      }),
    );
  };

  async function cleanup() {
    for (const site of [siteA, siteB]) {
      await sql`DELETE FROM delivery_sources WHERE source_document_id IN (SELECT id FROM source_documents WHERE site_id = ${site})`;
      await sql`DELETE FROM deliveries WHERE site_id = ${site}`;
      await sql`DELETE FROM source_document_visibility_events WHERE site_id = ${site}`;
      await sql`DELETE FROM source_document_items WHERE source_document_id IN (SELECT id FROM source_documents WHERE site_id = ${site})`;
      await sql`DELETE FROM source_documents WHERE site_id = ${site}`;
      await sql`DELETE FROM machine_merges WHERE member_root_id IN (SELECT id FROM source_bundles WHERE site_id = ${site})`;
      await sql`DELETE FROM ingest_events WHERE bundle_id IN (SELECT id FROM source_bundles WHERE site_id = ${site})`;
      await sql`DELETE FROM source_bundles WHERE site_id = ${site} AND parent_bundle_id IS NOT NULL`;
      await sql`DELETE FROM source_bundles WHERE site_id = ${site}`;
    }
  }

  beforeAll(async () => {
    process.env.GROUPS_ROLLOUT = '1';
    delete process.env.GROUPS_ROLLOUT_SINCE;
    process.env.GROUP_CLAIM_SITES = '*';
    process.env.MACHINE_MERGE_SITES = '*';
    vi.resetModules();
    mm = await import('../../src/domain/sourceDocuments/machine-merge.js');
    dg = await import('../../src/domain/sourceDocuments/document-group.js');
    lock = await import('../../src/domain/sourceDocuments/machine-lock.js');
    retry = await import('../../src/lib/db-retry.js');
    sql = postgres(TEST_DATABASE_URL!, { max: 12 });
    db = drizzle(sql, { schema, casing: 'snake_case' }) as unknown as Db;
    await sql`INSERT INTO sites (id, code, name) VALUES (${siteA}, ${`MMA${Date.now() % 100000}`}, 'Объект A')`;
    await sql`INSERT INTO sites (id, code, name) VALUES (${siteB}, ${`MMB${Date.now() % 100000}`}, 'Объект B')`;
    await sql`INSERT INTO suppliers (id, inn, name) VALUES (${supplier1}, ${`77${String(Date.now()).slice(-8)}`}, 'Поставщик 1')`;
    await sql`INSERT INTO suppliers (id, inn, name) VALUES (${supplier2}, ${`78${String(Date.now()).slice(-8)}`}, 'Поставщик 2')`;
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup();
    await sql`DELETE FROM suppliers WHERE id IN (${supplier1}, ${supplier2})`;
    await sql`DELETE FROM sites WHERE id IN (${siteA}, ${siteB})`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(cleanup);

  it('две отправки → одна машина: groupId, портал, ревизия числом, бамп документов', async () => {
    const u1 = await seedUpload();
    const u2 = await seedUpload();
    const a = await seedDoc(u1);
    const b = await seedDoc(u2);
    await sql`UPDATE source_bundles SET group_revision = 7 WHERE id = ${u2}`;
    const vA = await versionOf(a);
    const vB = await versionOf(b);

    const res = await merge([a, b]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changed).toBe(true);
    expect(res.groupId).toBe(u1); // самая ранняя отправка
    expect(res.undoable).toBe(true);

    const ma = await machineOf(a);
    const mb = await machineOf(b);
    expect(ma.groupId).toBe(u1);
    expect(mb.groupId).toBe(u1);
    expect(ma.portalGroupId).toBe(u1);
    expect(mb.portalSize).toBe(2);
    // max(1, 7) + 1 — и именно ЧИСЛО: postgres-js отдаёт bigint строкой.
    expect(ma.revision).toBe(8);
    expect(typeof mb.revision).toBe('number');
    expect(await versionOf(a)).toBe(vA + 1);
    expect(await versionOf(b)).toBe(vB + 1);
  });

  it('повтор → changed:false, ничего не пишет; пересекающиеся наборы без цепочек', async () => {
    const u1 = await seedUpload();
    const u2 = await seedUpload();
    const u3 = await seedUpload();
    const a = await seedDoc(u1);
    const b = await seedDoc(u2);
    const c = await seedDoc(u3);
    await merge([a, b]);
    const v = await versionOf(a);
    const again = await merge([b, a]);
    expect(again.ok && again.changed).toBe(false);
    expect(await versionOf(a)).toBe(v);

    // (B,C): голова — уже объединённая машина u1, не самая ранняя «вообще».
    const res = await merge([c, b]);
    expect(res.ok && res.groupId).toBe(u1);
    expect(res.ok && res.undoable).toBe(false);
    const rows = await sql<{ member_root_id: string; target_root_id: string }[]>`
      SELECT member_root_id, target_root_id FROM machine_merges
       WHERE target_root_id IN (${u1}, ${u2}, ${u3}) ORDER BY member_root_id`;
    expect(rows.map((r) => r.target_root_id)).toEqual([u1, u1]);
    // Без цепочек: голова не стоит участником.
    const heads =
      await sql`SELECT 1 FROM machine_merges WHERE member_root_id IN (SELECT target_root_id FROM machine_merges)`;
    expect(heads.length).toBe(0);
    for (const d of [a, b, c]) expect((await machineOf(d)).groupId).toBe(u1);
  });

  it('объединение двух уже объединённых машин переводит участников на одну голову', async () => {
    const [u1, u2, u3, u4] = [
      await seedUpload(),
      await seedUpload(),
      await seedUpload(),
      await seedUpload(),
    ];
    const [a, b, c, d] = [
      await seedDoc(u1),
      await seedDoc(u2),
      await seedDoc(u3),
      await seedDoc(u4),
    ];
    await merge([a, b]);
    await merge([c, d]);
    const res = await merge([d, a]);
    expect(res.ok && res.groupId).toBe(u1);
    for (const x of [a, b, c, d]) expect((await machineOf(x)).groupId).toBe(u1);
    const chains =
      await sql`SELECT 1 FROM machine_merges WHERE member_root_id IN (SELECT target_root_id FROM machine_merges)`;
    expect(chains.length).toBe(0);
  });

  it('каждый отказ ничего не пишет', async () => {
    const before = async () =>
      (await sql`SELECT count(*)::int AS n FROM machine_merges`)[0]!.n as number;
    const n0 = await before();

    // Разные поставщики.
    {
      const a = await seedDoc(await seedUpload());
      const b = await seedDoc(await seedUpload(), { supplier: supplier2 });
      const r = await merge([a, b]);
      expect(!r.ok && 'blocker' in r && r.blocker.code).toBe('different_suppliers');
    }
    // Разные даты поставки.
    {
      const a = await seedDoc(await seedUpload({ date: '2026-11-19' }), { date: '2026-11-19' });
      const b = await seedDoc(await seedUpload({ date: '2026-11-20' }), { date: '2026-11-20' });
      const r = await merge([a, b]);
      expect(!r.ok && 'blocker' in r && r.blocker.code).toBe('different_expected_dates');
    }
    // Разные объекты.
    {
      const a = await seedDoc(await seedUpload());
      const b = await seedDoc(await seedUpload({ siteId: siteB }), { siteId: siteB });
      const r = await merge([a, b]);
      expect(!r.ok && 'blocker' in r && r.blocker.code).toBe('different_sites');
    }
    // Не с портала.
    {
      const a = await seedDoc(await seedUpload());
      const b = await seedDoc(await seedUpload({ portal: false }));
      const r = await merge([a, b]);
      expect(!r.ok && 'blocker' in r && r.blocker.code).toBe('not_portal_upload');
    }
    // Отгрузка.
    {
      const a = await seedDoc(await seedUpload());
      const b = await seedDoc(await seedUpload(), { direction: 'outbound' });
      const r = await merge([a, b]);
      expect(!r.ok && 'blocker' in r && r.blocker.code).toBe('outbound_not_supported');
    }
    // Есть приёмка.
    {
      const a = await seedDoc(await seedUpload());
      const b = await seedDoc(await seedUpload());
      const [st] = await sql<
        { id: string }[]
      >`SELECT id FROM statuses WHERE code = 'filled' LIMIT 1`;
      const [del] = await sql<{ id: string; display_id: number }[]>`
        INSERT INTO deliveries (site_id, status_id) VALUES (${siteA}, ${st!.id}) RETURNING id, display_id`;
      await sql`INSERT INTO delivery_sources (delivery_id, source_document_id) VALUES (${del!.id}, ${b})`;
      const r = await merge([a, b]);
      expect(!r.ok && 'blocker' in r && r.blocker.code).toBe('machine_has_operation');
      if (!r.ok && 'blocker' in r && r.blocker.code === 'machine_has_operation') {
        expect(r.blocker.deliveryNumbers).toEqual([Number(del!.display_id)]);
      }
    }
    // Состав разошёлся с тем, что видел менеджер.
    {
      const a = await seedDoc(await seedUpload());
      const b = await seedDoc(await seedUpload());
      const r = await merge([a, b], [a]);
      expect(!r.ok && 'compositionChanged' in r).toBe(true);
    }
    expect(await before()).toBe(n0);
  });

  it('объект не включён → machine_merge_disabled', async () => {
    process.env.MACHINE_MERGE_SITES = siteB;
    process.env.GROUP_CLAIM_SITES = siteB;
    vi.resetModules();
    const fresh = await import('../../src/domain/sourceDocuments/machine-merge.js');
    try {
      const a = await seedDoc(await seedUpload());
      const b = await seedDoc(await seedUpload());
      const analysis = await fresh.analyzeMerge(db, [a, b]);
      expect(analysis.blockers[0]?.code).toBe('machine_merge_disabled');
    } finally {
      process.env.MACHINE_MERGE_SITES = '*';
      process.env.GROUP_CLAIM_SITES = '*';
      vi.resetModules();
    }
  });

  it('машина в разборе прячет присоединённые документы, после разбора видна целиком', async () => {
    const u1 = await seedUpload();
    const u2 = await seedUpload();
    const a = await seedDoc(u1);
    const b = await seedDoc(u2, { status: 'processing' });
    await sql`UPDATE source_documents SET queued_at = now() WHERE id = ${b}`;
    const res = await merge([a, b]);
    expect(res.ok).toBe(true);
    const ev = await sql<{ visibility: string }[]>`
      SELECT visibility FROM source_document_visibility_events WHERE source_document_id = ${a} ORDER BY created_at`;
    expect(ev.map((e) => e.visibility)).toEqual(['hidden']);

    // «Разбор» закончился: документ участника стал parsed — бамп из отправки-
    // участника поднимает ревизию ГОЛОВЫ и бампает документы всей машины, а
    // строку пакета участника не трогает.
    const revHead = await bundleRevision(u1);
    const revMember = await bundleRevision(u2);
    const vA = await versionOf(a);
    await db.transaction(async (tx) => {
      const m = await lock.lockMachineHead(tx as unknown as Db, { documentId: b });
      expect(m.headId).toBe(u1);
      await tx.execute(
        (await import('drizzle-orm'))
          .sql`UPDATE source_documents SET status = 'parsed' WHERE id = ${b}`,
      );
      await dg.markSourceDocumentContentChanged(tx, m, b);
    });
    expect(await bundleRevision(u1)).toBe(revHead + 1);
    expect(await bundleRevision(u2)).toBe(revMember);
    expect(await versionOf(a)).toBe(vA + 1);
  });

  it('разъединение: группы вернулись, ревизии строго больше виденного, повтор — no-op', async () => {
    const u1 = await seedUpload();
    const u2 = await seedUpload();
    const a = await seedDoc(u1);
    const b = await seedDoc(u2);
    const merged = await merge([a, b]);
    const seenMerged = (await machineOf(b)).revision!;
    // Сценарий ревью ред. 3, п.5: пока машина общая, «дата» меняется через A —
    // бамп ревизии головы.
    await db.transaction(async (tx) =>
      dg.bumpGroupRevision(tx, await lock.lockMachineHead(tx as unknown as Db, { documentId: a })),
    );
    const res = await unmerge(a);
    expect(res.ok && res.changed).toBe(true);
    expect((await machineOf(a)).groupId).toBe(u1);
    expect((await machineOf(b)).groupId).toBe(u2);
    // Старый снимок B (до слияния: 1) и снимок во время слияния — оба меньше.
    const revB = (await machineOf(b)).revision!;
    expect(revB).toBeGreaterThan(seenMerged);
    expect(revB).toBeGreaterThan(1);
    const again = await unmerge(a);
    expect(again.ok && again.changed).toBe(false);
    expect(merged.ok).toBe(true);
  });

  it('«Отменить» с чужим составом → отказ; операция по машине → отказ', async () => {
    const [u1, u2, u3] = [await seedUpload(), await seedUpload(), await seedUpload()];
    const [a, b, c] = [await seedDoc(u1), await seedDoc(u2), await seedDoc(u3)];
    const first = await merge([a, b]);
    await merge([a, c]); // другой менеджер добавил третью отправку
    const undo = await unmerge(a, first.ok ? first.mergeId! : undefined);
    expect(!undo.ok && 'compositionChanged' in undo).toBe(true);
    expect((await machineOf(c)).groupId).toBe(u1);

    const [st] = await sql<{ id: string }[]>`SELECT id FROM statuses WHERE code = 'filled' LIMIT 1`;
    const [del] = await sql<
      { id: string }[]
    >`INSERT INTO deliveries (site_id, status_id) VALUES (${siteA}, ${st!.id}) RETURNING id`;
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id) VALUES (${del!.id}, ${b})`;
    const blocked = await unmerge(a);
    expect(!blocked.ok && 'blocker' in blocked && blocked.blocker.code).toBe(
      'machine_has_operation',
    );
  });

  it('200 циклов «объединить ↔ разъединить»: ревизия растёт линейно и монотонно', async () => {
    const u1 = await seedUpload();
    const u2 = await seedUpload();
    const a = await seedDoc(u1);
    const b = await seedDoc(u2);
    let last = 0;
    for (let i = 0; i < 200; i++) {
      await merge([a, b]);
      const r1 = (await machineOf(b)).revision!;
      expect(r1).toBeGreaterThan(last);
      last = r1;
      await unmerge(a);
      const r2 = Math.max((await machineOf(a)).revision!, (await machineOf(b)).revision!);
      expect(r2).toBeGreaterThan(last);
      last = r2;
    }
    // Линейно: +1 на слияние и +1 на разъединение от стартовой единицы.
    expect(last).toBeLessThanOrEqual(1 + 2 * 200 + 1);
  });

  it('гонки: пересекающиеся слияния и слияние × разъединение сходятся без цепочек', async () => {
    for (let round = 0; round < 10; round++) {
      await cleanup();
      const ups = [await seedUpload(), await seedUpload(), await seedUpload()];
      const [a, b, c] = [await seedDoc(ups[0]!), await seedDoc(ups[1]!), await seedDoc(ups[2]!)];
      const { withTxRetry } = retry;
      // Предпросмотр каждого — до гонки: проигравший честно получит «состав
      // изменился» (менеджер видел другое), но не ошибку и не цепочку.
      const results = await Promise.allSettled([
        withTxRetry(() => merge([a, b])),
        withTxRetry(() => merge([b, c])),
        withTxRetry(() => merge([c, a])),
      ]);
      for (const r of results) if (r.status === 'rejected') throw r.reason;
      const chains =
        await sql`SELECT 1 FROM machine_merges WHERE member_root_id IN (SELECT target_root_id FROM machine_merges)`;
      expect(chains.length).toBe(0);
      // Добиваем последовательно: итог — одна машина.
      await merge([a, b, c]);
      const groups = await Promise.all([a, b, c].map(async (d) => (await machineOf(d)).groupId));
      expect(new Set(groups).size).toBe(1);
      // Слияние × разъединение: итог — одно из двух согласованных состояний.
      const res = await Promise.allSettled([
        withTxRetry(() => unmerge(a)),
        withTxRetry(() => merge([a, b])),
      ]);
      for (const r of res) expect(r.status).toBe('fulfilled');
      const after = await Promise.all([a, b, c].map(async (d) => (await machineOf(d)).groupId));
      const distinct = new Set(after).size;
      expect([1, 2, 3]).toContain(distinct);
      const chains2 =
        await sql`SELECT 1 FROM machine_merges WHERE member_root_id IN (SELECT target_root_id FROM machine_merges)`;
      expect(chains2.length).toBe(0);
    }
  });

  it('повторная отправка: объединённая отправка не перезапускается, принятая машина не дозагружается', async () => {
    const ops = await import('../../src/domain/sourceDocuments/machine-operations.js');
    const u1 = await seedUpload();
    const u2 = await seedUpload();
    const a = await seedDoc(u1);
    const b = await seedDoc(u2);
    const guard = (bundleId: string) =>
      db.transaction((tx) => ops.machineGuardForBundle(tx as unknown as Db, bundleId));
    expect(await guard(u2)).toEqual({ merged: false, busy: false });
    await merge([a, b]);
    expect((await guard(u2)).merged).toBe(true);
    expect((await guard(u1)).merged).toBe(true);
    const [st] = await sql<{ id: string }[]>`SELECT id FROM statuses WHERE code = 'filled' LIMIT 1`;
    const [del] = await sql<
      { id: string }[]
    >`INSERT INTO deliveries (site_id, status_id) VALUES (${siteA}, ${st!.id}) RETURNING id`;
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id) VALUES (${del!.id}, ${a})`;
    // Приняли документ головы — занята вся машина, в том числе отправка-участник.
    expect((await guard(u2)).busy).toBe(true);
  });

  it('гонка «перезапуск против слияния» (10 раундов): документы не теряются, итог согласован', async () => {
    const ops = await import('../../src/domain/sourceDocuments/machine-operations.js');
    const { sql: dsql } = await import('drizzle-orm');
    for (let round = 0; round < 10; round++) {
      await cleanup();
      const u1 = await seedUpload();
      const u2 = await seedUpload();
      const a = await seedDoc(u1);
      const b = await seedDoc(u2);
      const expected = (await mm.analyzeMerge(db, [a, b])).documentIds;
      // «Перезапуск» отправки u2: под замком машины свежая проверка, затем —
      // как purgePreviousGeneration — удаление её документов в той же транзакции.
      const restart = db.transaction(async (tx) => {
        const g = await ops.machineGuardForBundle(tx as unknown as Db, u2);
        if (g.merged || g.busy) return 'reused' as const;
        await new Promise((r) => setTimeout(r, 20));
        await tx.execute(dsql`DELETE FROM source_document_items WHERE source_document_id = ${b}`);
        await tx.execute(dsql`DELETE FROM source_documents WHERE id = ${b}`);
        return 'restarted' as const;
      });
      const mergeRes = retry.withTxRetry(() =>
        db.transaction((tx) =>
          mm.mergeMachines(tx as unknown as Db, {
            documentIds: [a, b],
            expectedDocumentIds: expected,
            userId: null,
          }),
        ),
      );
      const [r, m] = await Promise.all([restart, mergeRes.catch((e: unknown) => e)]);
      const bExists = (await sql`SELECT 1 FROM source_documents WHERE id = ${b}`).length > 0;
      if (r === 'restarted') {
        // Перезапуск первым: документ ушёл, слияние не прошло — состав другой
        // (или документа уже нет).
        expect(bExists).toBe(false);
        expect(m && typeof m === 'object' && 'ok' in m && (m as { ok: boolean }).ok).toBe(false);
        const merges =
          await sql`SELECT 1 FROM machine_merges WHERE member_root_id IN (${u1}, ${u2})`;
        expect(merges.length).toBe(0);
      } else {
        // Слияние первым: перезапуск увидел объединение и ничего не удалил.
        expect(bExists).toBe(true);
        expect((m as { ok: boolean }).ok).toBe(true);
      }
    }
  });

  it('два «разбора» разных отправок одной машины параллельно — без взаимной блокировки', async () => {
    for (let round = 0; round < 10; round++) {
      await cleanup();
      const u1 = await seedUpload();
      const u2 = await seedUpload();
      const a = await seedDoc(u1);
      const b = await seedDoc(u2);
      await merge([a, b]);
      // Как запись результата в воркере: замок машины → свой документ → пауза
      // (другой «разбор» успевает начать) → бамп всей машины.
      const parse = (docId: string) =>
        db.transaction(async (tx) => {
          const m = await lock.lockMachineHead(tx as unknown as Db, { documentId: docId });
          await tx.execute(
            (await import('drizzle-orm'))
              .sql`UPDATE source_documents SET total_sum = total_sum + 1 WHERE id = ${docId}`,
          );
          await new Promise((r) => setTimeout(r, 30));
          await dg.markSourceDocumentContentChanged(tx, m, docId);
        });
      const res = await Promise.allSettled([parse(a), parse(b)]);
      for (const r of res) {
        if (r.status === 'rejected') throw r.reason;
      }
    }
  });
});
