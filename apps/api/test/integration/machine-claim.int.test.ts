/**
 * «Одна машина — одна приёмка» при создании приёмки (domain/groups/machine-claim.ts).
 *
 * Как в маршруте: подготовка первым действием транзакции, затем шапка
 * приёмки, затем занятие машины (claim ссылается на приёмку внешним ключом).
 *
 * Запуск: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as dsql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../src/db/schema.js';
import type { Db } from '../../src/db/client.js';

vi.mock('../../src/instrument.js', () => ({}));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('протокол «одна машина — одна приёмка» (реальный PostgreSQL)', { timeout: 60_000 }, () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let mc: typeof import('../../src/domain/groups/machine-claim.js');
  let dg: typeof import('../../src/domain/sourceDocuments/document-group.js');
  const site = randomUUID();
  const otherSite = randomUUID();
  let statusId = '';

  async function seedMachine(siteId = site, docs = 2) {
    const root = randomUUID();
    await sql`INSERT INTO source_bundles (id, bundle_hash, direction, site_id, status, kind,
              assembly_version, active_upload_generation, expected_date)
              VALUES (${root}, ${`mc${root.replace(/-/g, '')}`.slice(0, 64)}, 'inbound', ${siteId},
                      'parsed', 'mixed', 'legacy', 0, '2026-11-20')`;
    await sql`INSERT INTO ingest_events (bundle_id, channel, public_ticket)
              VALUES (${root}, 'public', ${randomUUID().slice(0, 20)})`;
    const ids: string[] = [];
    for (let i = 0; i < docs; i++) {
      const id = randomUUID();
      await sql`INSERT INTO source_documents (id, kind, is_technical, direction, origin, status,
                site_id, parsed_at, doc_number, doc_date, total_sum, bundle_id, expected_date)
                VALUES (${id}, 'upd', false, 'inbound', 'manual_pdf', 'parsed', ${siteId}, now(),
                        ${`MC-${id.slice(0, 6)}`}, now(), 100, ${root}, '2026-11-20')`;
      await sql`INSERT INTO source_document_items (source_document_id, name_raw, qty, unit, price, sum, line_no)
                VALUES (${id}, 'Труба', 1, 'шт', 100, 100, 1)`;
      ids.push(id);
    }
    return { root, ids: ids.sort() };
  }

  async function revisionOf(docId: string) {
    const [r] = await db
      .select({ g: dg.documentGroupIdSql(), r: dg.documentGroupRevisionSql() })
      .from(schema.sourceDocuments)
      .where(dsql`${schema.sourceDocuments.id} = ${docId}`);
    return r!;
  }

  /** Как createDelivery: подготовка → шапка → занятие, одной транзакцией. */
  function create(
    documentIds: string[],
    opts: {
      caps?: string[];
      mobile?: boolean;
      groupId?: string | null;
      revision?: number | null;
      siteId?: string;
    } = {},
  ) {
    const id = randomUUID();
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const claim = await mc.prepareMachineClaim(tx, {
        operationId: id,
        documentIds,
        siteId: opts.siteId ?? site,
        clientGroupId: opts.groupId,
        clientGroupRevision: opts.revision,
        ctx: {
          capabilities: new Set(opts.caps ?? ['group_claim_v1']),
          mobile: opts.mobile ?? true,
          actorUserId: null,
        },
      });
      await tx.execute(
        dsql`INSERT INTO deliveries (id, site_id, status_id) VALUES (${id}, ${opts.siteId ?? site}, ${statusId})`,
      );
      for (const d of documentIds) {
        await tx.execute(
          dsql`INSERT INTO delivery_sources (delivery_id, source_document_id) VALUES (${id}, ${d})`,
        );
      }
      if (claim) {
        await mc.commitMachineClaim(tx, {
          headId: claim.headId,
          deliveryId: id,
          actorUserId: null,
          groupRevision: claim.groupRevision,
        });
      }
      return { id, claimed: !!claim };
    });
  }

  async function cleanup() {
    for (const s of [site, otherSite]) {
      await sql`DELETE FROM operation_group_claims WHERE group_id IN (SELECT id FROM source_bundles WHERE site_id = ${s})`;
      await sql`DELETE FROM delivery_sources WHERE delivery_id IN (SELECT id FROM deliveries WHERE site_id = ${s})`;
      await sql`DELETE FROM deliveries WHERE site_id = ${s}`;
      await sql`DELETE FROM source_document_items WHERE source_document_id IN (SELECT id FROM source_documents WHERE site_id = ${s})`;
      await sql`DELETE FROM source_documents WHERE site_id = ${s}`;
      await sql`DELETE FROM ingest_events WHERE bundle_id IN (SELECT id FROM source_bundles WHERE site_id = ${s})`;
      await sql`DELETE FROM source_bundles WHERE site_id = ${s}`;
    }
  }

  beforeAll(async () => {
    process.env.GROUPS_ROLLOUT = '1';
    delete process.env.GROUPS_ROLLOUT_SINCE;
    process.env.GROUP_CLAIM_SITES = site;
    process.env.MACHINE_MERGE_SITES = '';
    vi.resetModules();
    mc = await import('../../src/domain/groups/machine-claim.js');
    dg = await import('../../src/domain/sourceDocuments/document-group.js');
    sql = postgres(TEST_DATABASE_URL!, { max: 8 });
    db = drizzle(sql, { schema, casing: 'snake_case' }) as unknown as Db;
    await sql`INSERT INTO sites (id, code, name) VALUES (${site}, ${`MC${Date.now() % 100000}`}, 'Защищённый')`;
    await sql`INSERT INTO sites (id, code, name) VALUES (${otherSite}, ${`MO${Date.now() % 100000}`}, 'Обычный')`;
    const [st] = await sql<{ id: string }[]>`SELECT id FROM statuses WHERE code = 'filled' LIMIT 1`;
    statusId = st!.id;
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup();
    await sql`DELETE FROM sites WHERE id IN (${site}, ${otherSite})`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(cleanup);

  it('вне защищённой области — прежний путь: без занятия и без проверок', async () => {
    const m = await seedMachine(otherSite);
    const res = await create(m.ids, { siteId: otherSite, caps: [] });
    expect(res.claimed).toBe(false);
    const second = await create(m.ids, { siteId: otherSite, caps: [] });
    expect(second.claimed).toBe(false);
  });

  it('старый клиент без group_claim_v1 на защищённом объекте → 426, ничего не записано', async () => {
    const m = await seedMachine();
    await expect(create(m.ids, { caps: [] })).rejects.toMatchObject({
      statusCode: 426,
      name: 'client_outdated',
    });
    expect((await sql`SELECT 1 FROM deliveries WHERE site_id = ${site}`).length).toBe(0);
  });

  it('два параллельных создания по машине → одно, второе group_claimed', async () => {
    const m = await seedMachine();
    const { g, r } = await revisionOf(m.ids[0]!);
    const results = await Promise.allSettled([
      create(m.ids, { groupId: g, revision: r }),
      create(m.ids, { groupId: g, revision: r }),
    ]);
    const ok = results.filter((x) => x.status === 'fulfilled');
    const failed = results.filter((x) => x.status === 'rejected') as PromiseRejectedResult[];
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(1);
    expect(failed[0]!.reason).toBeInstanceOf(mc.GroupConflictError);
    expect((failed[0]!.reason as InstanceType<typeof mc.GroupConflictError>).conflict.error).toBe(
      'group_claimed',
    );
    expect((await sql`SELECT 1 FROM deliveries WHERE site_id = ${site}`).length).toBe(1);
  });

  it('старый снимок без groupId: свободная машина → group_changed, занятая → group_claimed', async () => {
    const m = await seedMachine();
    await expect(create(m.ids, { groupId: null, revision: null })).rejects.toMatchObject({
      conflict: { error: 'group_changed' },
    });
    const { g, r } = await revisionOf(m.ids[0]!);
    await create(m.ids, { groupId: g, revision: r });
    await expect(create(m.ids, { groupId: null, revision: null })).rejects.toMatchObject({
      conflict: { error: 'group_claimed' },
    });
  });

  it('живая приёмка без claim (портал, старая сборка) занимает машину', async () => {
    const m = await seedMachine();
    const legacy = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, status_id) VALUES (${legacy}, ${site}, ${statusId})`;
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id) VALUES (${legacy}, ${m.ids[0]!})`;
    const { g, r } = await revisionOf(m.ids[0]!);
    await expect(create(m.ids, { groupId: g, revision: r })).rejects.toMatchObject({
      conflict: { error: 'group_claimed', claimedByOperationId: legacy },
    });
  });

  it('неполный состав с планшета → group_incomplete; портал — только занятость', async () => {
    const m = await seedMachine();
    const { g, r } = await revisionOf(m.ids[0]!);
    await expect(create([m.ids[0]!], { groupId: g, revision: r })).rejects.toMatchObject({
      conflict: { error: 'group_incomplete' },
    });
    const portal = await create([m.ids[0]!], { mobile: false });
    expect(portal.claimed).toBe(true);
  });
});
