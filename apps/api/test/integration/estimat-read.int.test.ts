/**
 * Чтение заказов EstiMat: фильтр «Виза» на SQL обязан считать ровно то же, что
 * approvalState() из контракта (по нему красятся чип и строки), фильтры списка,
 * карточка заказа, кэш состава, который сбрасывается при изменении заказа.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { approvalState, ESTIMAT_APPROVAL_STATES } from '@matcheck/contracts';
import * as schema from '../../src/db/schema.js';
import type { Db } from '../../src/db/client.js';
import { readEstimatConfig } from '../../src/domain/estimat/config.js';
import { EstimatError, type EstimatClient } from '../../src/domain/estimat/estimat.http.js';
import { loadOrderItems, resetOrderItemsCache } from '../../src/domain/estimat/order-items.js';
import { getOrderDetail, listOrders, loadSyncStatus } from '../../src/domain/estimat/orders-read.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;
const CONFIG = readEstimatConfig({ ESTIMAT_API_TOKEN: 'estm_readtest.' + 'x'.repeat(47) });

suite('чтение заказов EstiMat', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  const siteId = randomUUID();
  const siteCode = `RD${siteId.slice(0, 6)}`;

  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  async function order(patch: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    const r = {
      order_no: 100,
      sub_no: 0,
      site_id: siteId as string | null,
      sourcing_status: 'awarded',
      supplier_name: 'ООО Поставщик',
      supplier_inn: '7800000000',
      supply_approved_at: null as Date | null,
      deleted_at: null as Date | null,
      estimat_updated_at: new Date('2026-10-20T00:00:00Z'),
      ...patch,
    };
    await sql`INSERT INTO estimat_supplier_orders
      (id, order_no, sub_no, site_id, sourcing_status, supplier_name, supplier_inn, supply_approved_at, deleted_at,
       estimat_updated_at, raw, last_seen_pass_id)
      VALUES (${id}, ${r.order_no}, ${r.sub_no}, ${r.site_id}, ${r.sourcing_status}, ${r.supplier_name}, ${r.supplier_inn},
              ${iso(r.supply_approved_at)}::timestamptz, ${iso(r.deleted_at)}::timestamptz,
              ${iso(r.estimat_updated_at)}::timestamptz, ${JSON.stringify({ id })}::jsonb, ${randomUUID()})`;
    return id;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql, { schema }) as unknown as Db;
    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${siteCode}, 'Чтение')`;
  });

  beforeEach(async () => {
    await sql`DELETE FROM delivery_supplier_orders`;
    await sql`DELETE FROM estimat_supplier_orders`;
    await sql`DELETE FROM estimat_sync_runs`;
    resetOrderItemsCache();
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM estimat_supplier_orders`;
    await sql`DELETE FROM estimat_sync_runs`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  it('фильтр «Виза» на SQL совпадает с approvalState() на всех сочетаниях', async () => {
    const at = new Date('2026-10-22T12:00:00Z');
    const stages = ['forming', 'sourcing', 'approval', 'awarded', 'recorded', 'cancel_pending', 'cancelled', 'no_award', 'new_stage'];
    const expected = new Map<string, string>();
    for (const stage of stages) {
      for (const approved of [null, at]) {
        for (const deleted of [null, at]) {
          const id = await order({ sourcing_status: stage, supply_approved_at: approved, deleted_at: deleted });
          expected.set(id, approvalState(stage, approved, deleted));
        }
      }
    }
    for (const state of ESTIMAT_APPROVAL_STATES) {
      const { items } = await listOrders(db, { approval: [state], limit: 100, offset: 0 });
      const got = items.map((i) => i.id).sort();
      const want = [...expected].filter(([, s]) => s === state).map(([id]) => id).sort();
      expect({ state, ids: got }).toEqual({ state, ids: want });
      for (const item of items) expect(item.approvalState).toBe(state);
    }
  });

  it('список: удалённые скрыты без флага, поиск по номеру и поставщику, стадии, объект, total', async () => {
    const a = await order({ order_no: 12, sub_no: 0 });
    const b = await order({ order_no: 12, sub_no: 1, supplier_name: 'АО Бетон' });
    const c = await order({ order_no: 77, site_id: null, sourcing_status: 'sourcing' });
    const gone = await order({ order_no: 12, deleted_at: new Date() });

    const ids = async (q: Parameters<typeof listOrders>[1]) =>
      (await listOrders(db, q)).items.map((i) => i.id).sort();
    expect(await ids({ limit: 50, offset: 0 })).toEqual([a, b, c].sort());
    expect(await ids({ includeDeleted: true, limit: 50, offset: 0 })).toEqual([a, b, c, gone].sort());
    expect(await ids({ q: 'З-012', limit: 50, offset: 0 })).toEqual([a, b].sort());
    expect(await ids({ q: '12/1', limit: 50, offset: 0 })).toEqual([b]);
    expect(await ids({ q: 'бетон', limit: 50, offset: 0 })).toEqual([b]);
    expect(await ids({ statuses: ['sourcing'], limit: 50, offset: 0 })).toEqual([c]);
    expect(await ids({ siteId, limit: 50, offset: 0 })).toEqual([a, b].sort());
    const page = await listOrders(db, { limit: 1, offset: 1 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
    const first = (await listOrders(db, { q: '12/1', limit: 5, offset: 0 })).items[0]!;
    expect(first).toMatchObject({ number: 'З-012/1', siteCode, amount: null });
  });

  it('карточка заказа: журнал с последним снятием визы', async () => {
    const id = await order();
    await sql`INSERT INTO estimat_supplier_order_events (order_id, kind, to_value) VALUES
      (${id}, 'first_seen', 'awarded'), (${id}, 'approved', '2026-10-22T12:00:00.000Z'), (${id}, 'approval_revoked', NULL)`;
    const detail = await getOrderDetail(db, id);
    expect(detail?.events.map((e) => e.kind)).toEqual(['approval_revoked', 'approved', 'first_seen']);
    expect(detail?.lastApprovalRevokedAt).not.toBeNull();
    expect(await getOrderDetail(db, randomUUID())).toBeNull();
  });

  it('состав: кэш до изменения заказа, после изменения — новый запрос', async () => {
    const id = await order();
    const calls = vi.fn(async () => [
      { id: 'i1', materialName: 'Бетон B25', unit: 'м3', quantity: 12.5, deliveryDate: '2026-10-30', contractorName: null },
    ]);
    const createClient = () => ({ getSupplierOrderItems: calls }) as unknown as EstimatClient;
    const deps = { db, config: CONFIG, createClient };

    const first = await loadOrderItems(deps, id);
    expect(first).toMatchObject({ state: 'ready', items: [{ materialName: 'Бетон B25', quantity: 12.5 }] });
    await loadOrderItems(deps, id);
    expect(calls).toHaveBeenCalledTimes(1);

    await sql`UPDATE estimat_supplier_orders SET estimat_updated_at = now() WHERE id = ${id}`;
    await loadOrderItems(deps, id);
    expect(calls).toHaveBeenCalledTimes(2);

    await sql`UPDATE estimat_supplier_orders SET supply_approved_at = now() WHERE id = ${id}`;
    await loadOrderItems(deps, id);
    expect(calls).toHaveBeenCalledTimes(3);
  });

  it('состав: EstiMat занят — unavailable с понятным текстом; без токена — disabled', async () => {
    const id = await order();
    const busy = () =>
      ({
        getSupplierOrderItems: async () => {
          throw new EstimatError('rate_limited', 'EstiMat занят: лимит');
        },
      }) as unknown as EstimatClient;
    expect(await loadOrderItems({ db, config: CONFIG, createClient: busy }, id)).toMatchObject({
      state: 'unavailable',
      message: 'EstiMat занят, попробуйте позже',
    });
    expect(await loadOrderItems({ db, config: readEstimatConfig({}) }, id)).toMatchObject({ state: 'disabled' });
    expect(await loadOrderItems({ db, config: CONFIG }, randomUUID())).toBeNull();
  });

  it('состояние синхронизации: причина выключения, последний и последний успешный обход', async () => {
    const off = await loadSyncStatus(db, { enabledFlag: false, config: CONFIG, intervalSec: 1800 });
    expect(off).toMatchObject({ enabled: false, running: null, lastRun: null, lastCompleted: null });
    expect(off.reason).toContain('ESTIMAT_SYNC_ENABLED');
    expect(await loadSyncStatus(db, { enabledFlag: true, config: readEstimatConfig({}), intervalSec: 1800 })).toMatchObject({
      enabled: false,
      reason: 'нет токена EstiMat',
    });

    await sql`INSERT INTO estimat_sync_runs (trigger, outcome, started_at, finished_at, orders_seen)
      VALUES ('auto', 'completed', now() - interval '2 hours', now() - interval '2 hours', 10)`;
    await sql`INSERT INTO estimat_sync_runs (trigger, outcome, started_at, finished_at, error_code, request_id)
      VALUES ('auto', 'error', now() - interval '1 hour', now() - interval '1 hour', 'internal_error', 'req-1')`;
    const on = await loadSyncStatus(db, { enabledFlag: true, config: CONFIG, intervalSec: 1800 });
    expect(on).toMatchObject({ enabled: true, reason: null });
    expect(on.lastRun).toMatchObject({ outcome: 'error', errorCode: 'internal_error', requestId: 'req-1' });
    expect(on.lastCompleted).toMatchObject({ outcome: 'completed', ordersSeen: 10 });
    expect(on.lastCompleted!.durationMs).toBe(0);
  });
});
