/**
 * Обход заказов EstiMat на настоящем PostgreSQL с поддельным EstiMat.
 *
 * Главное здесь — единственное разрушительное действие обхода: пометка
 * «удалён в EstiMat». Она обязана срабатывать только при полном обходе и
 * подтверждённой полноте доступа токена и никогда — при обрыве, рестарте
 * курсора, суженном или изменившемся доступе.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema.js';
import type { Db } from '../../src/db/client.js';
import { readEstimatConfig } from '../../src/domain/estimat/config.js';
import {
  EstimatAuthError,
  EstimatCursorError,
  EstimatError,
  type EstimatClient,
} from '../../src/domain/estimat/estimat.http.js';
import type { EstimatCapabilities, OrderPage } from '../../src/domain/estimat/estimat.types.js';
import {
  runEstimatSync,
  type EstimatSyncDeps,
  type EstimatSyncFinished,
  type EstimatSyncResult,
} from '../../src/domain/estimat/supplier-orders-sync.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const TOKEN_A = 'estm_aaaaaaaa.' + 'a'.repeat(47);
const TOKEN_B = 'estm_bbbbbbbb.' + 'b'.repeat(47);
const PROJECT_P = randomUUID();
const PROJECT_Q = randomUUID();

const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => log,
} as never;

type Row = Record<string, unknown> & { id: string };

/** Поддельный EstiMat: заказы, страницы по PAGE штук, сценарии сбоев. */
class FakeEstimat {
  orders: Row[] = [];
  pageSize = 2;
  caps: EstimatCapabilities = { scopes: ['purchases:read'], projectId: null };
  capsSeq: (EstimatCapabilities | Error)[] = [];
  /** Перед выдачей страницы с этим номером (0 — первая) — что сделать. */
  beforePage: ((index: number, cursor: string | null) => Promise<void> | void) | null = null;
  listCalls = 0;

  client(): EstimatClient {
    return {
      listSupplierOrders: async (cursor: string | null): Promise<OrderPage> => {
        this.listCalls++;
        const index = cursor === null ? 0 : Number(cursor.replace('c', ''));
        await this.beforePage?.(index, cursor);
        const visible = this.caps.projectId
          ? this.orders.filter((o) => o.projectId === this.caps.projectId)
          : this.orders;
        const chunk = visible.slice(index * this.pageSize, (index + 1) * this.pageSize);
        const more = (index + 1) * this.pageSize < visible.length;
        return { data: chunk, meta: { nextCursor: more ? `c${index + 1}` : null } };
      },
      capabilities: async () => {
        const next = this.capsSeq.shift();
        if (next instanceof Error) throw next;
        return next ?? this.caps;
      },
      getSupplierOrderItems: async () => [],
      openapiVersion: async () => '1.6.0',
    };
  }
}

function order(patch: Partial<Row> = {}): Row {
  return {
    id: randomUUID(),
    orderNo: Math.floor(Math.random() * 900) + 1,
    subNo: 0,
    projectId: PROJECT_P,
    projectCode: null,
    projectName: 'Объект',
    contractors: [{ id: 'c', name: 'Подрядчик', inn: '7700000000', type: 'subcontractor' }],
    sourcingStatus: 'awarded',
    supplierName: 'Поставщик',
    supplierInn: '7800000000',
    amount: 1000.5,
    supplyApprovedAt: null,
    createdAt: '2026-10-15T07:02:44.000Z',
    updatedAt: '2026-10-15T07:02:44.000Z',
    ...patch,
  };
}

suite('обход заказов EstiMat', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let fake: FakeEstimat;
  const siteId = randomUUID();
  const siteCode = `EST${siteId.slice(0, 5)}`;

  const deps = (token = TOKEN_A): EstimatSyncDeps => ({
    db,
    log,
    config: readEstimatConfig({ ESTIMAT_API_TOKEN: token }),
    createClient: () => fake.client(),
  });
  const run = (trigger: 'auto' | 'manual' | 'script' = 'script', token = TOKEN_A, extra: { acceptDeletions?: boolean } = {}) =>
    runEstimatSync(deps(token), { trigger, ...extra });
  const finished = (r: EstimatSyncResult): EstimatSyncFinished => {
    if ('skipped' in r) throw new Error(`обход пропущен: ${r.skipped}`);
    return r;
  };

  const deletedIds = async () =>
    (await sql<{ id: string }[]>`SELECT id FROM estimat_supplier_orders WHERE deleted_at IS NOT NULL ORDER BY id`).map((r) => r.id);
  const events = async (orderId: string) =>
    (await sql<{ kind: string; from_value: string | null; to_value: string | null }[]>`
      SELECT kind, from_value, to_value FROM estimat_supplier_order_events WHERE order_id = ${orderId} ORDER BY id`);

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql, { schema }) as unknown as Db;
    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${siteCode}, 'Тест EstiMat')`;
  });

  beforeEach(async () => {
    // Таблицы новые и принадлежат только этим наборам — чистим целиком.
    await sql`DELETE FROM delivery_supplier_orders`;
    await sql`DELETE FROM estimat_supplier_orders`;
    await sql`DELETE FROM estimat_sync_runs`;
    fake = new FakeEstimat();
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM delivery_supplier_orders`;
    await sql`DELETE FROM estimat_supplier_orders`;
    await sql`DELETE FROM estimat_sync_runs`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  it('обход по курсору; повторный обход не создаёт дублей', async () => {
    fake.orders = Array.from({ length: 5 }, () => order());
    const first = finished(await run());
    expect(first).toMatchObject({ outcome: 'completed' });
    expect(first.counters).toMatchObject({ pages: 3, ordersSeen: 5, inserted: 5, updated: 0 });

    const second = finished(await run());
    expect(second.counters).toMatchObject({ pages: 3, ordersSeen: 5, inserted: 0, updated: 5 });
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM estimat_supplier_orders`;
    expect(n).toBe(5);
    const [{ seen }] = await sql<{ seen: number }[]>`
      SELECT count(*)::int AS seen FROM estimat_supplier_order_events WHERE kind = 'first_seen'`;
    expect(seen).toBe(5);
    const [runRow] = await sql<{ outcome: string; scope_confirmed: boolean; token_fingerprint: string }[]>`
      SELECT outcome, scope_confirmed, token_fingerprint FROM estimat_sync_runs WHERE id = ${second.runId}`;
    expect(runRow).toMatchObject({ outcome: 'completed', scope_confirmed: true });
    expect(runRow!.token_fingerprint).toHaveLength(16);
  });

  it('сумма decimal, подрядчики и объект по коду без учёта регистра', async () => {
    const o = order({ amount: 356400.5, projectCode: siteCode.toLowerCase(), subNo: 1 });
    fake.orders = [o];
    finished(await run());
    const [row] = await sql<{ amount: string; site_id: string; sub_no: number; contractors: unknown }[]>`
      SELECT amount::text, site_id, sub_no, contractors FROM estimat_supplier_orders WHERE id = ${o.id}`;
    expect(row).toMatchObject({ amount: '356400.50', site_id: siteId, sub_no: 1 });
    expect(row!.contractors).toEqual(o.contractors);
  });

  it('виза: согласован → снят → согласован повторно', async () => {
    const o = order();
    fake.orders = [o];
    finished(await run());
    o.supplyApprovedAt = '2026-10-22T12:40:11.000Z';
    finished(await run());
    o.supplyApprovedAt = null;
    const revoked = finished(await run());
    expect(revoked.counters.approvalChanges).toBe(1);
    let [row] = await sql<{ supply_approved_at: Date | null }[]>`
      SELECT supply_approved_at FROM estimat_supplier_orders WHERE id = ${o.id}`;
    expect(row!.supply_approved_at).toBeNull();
    o.supplyApprovedAt = '2026-10-25T08:00:00.000Z';
    finished(await run());
    [row] = await sql<{ supply_approved_at: Date | null }[]>`
      SELECT supply_approved_at FROM estimat_supplier_orders WHERE id = ${o.id}`;
    expect(new Date(row!.supply_approved_at!).toISOString()).toBe('2026-10-25T08:00:00.000Z');
    expect((await events(o.id)).map((e) => e.kind)).toEqual([
      'first_seen',
      'approved',
      'approval_revoked',
      'reapproved',
    ]);
  });

  it('впервые увиден с визой → снят → поставлен снова = reapproved', async () => {
    const o = order({ supplyApprovedAt: '2026-10-22T12:40:11.000Z' });
    fake.orders = [o];
    finished(await run());
    o.supplyApprovedAt = null;
    finished(await run());
    o.supplyApprovedAt = '2026-10-26T10:00:00.000Z';
    finished(await run());
    expect((await events(o.id)).map((e) => e.kind)).toEqual([
      'first_seen',
      'approved',
      'approval_revoked',
      'reapproved',
    ]);
  });

  it('пропавший заказ помечается удалённым, связь с приёмкой цела; вернувшийся — restored', async () => {
    const keep = order();
    const gone = order();
    fake.orders = [keep, gone];
    finished(await run());
    const deliveryId = await createDelivery();
    await sql`INSERT INTO delivery_supplier_orders (delivery_id, order_id) VALUES (${deliveryId}, ${gone.id})`;

    fake.orders = [keep];
    const r = finished(await run());
    expect(r.counters.markedDeleted).toBe(1);
    expect(await deletedIds()).toEqual([gone.id]);
    const [link] = await sql`SELECT 1 FROM delivery_supplier_orders WHERE order_id = ${gone.id}`;
    expect(link).toBeDefined();

    fake.orders = [keep, gone];
    const back = finished(await run());
    expect(back.counters.restored).toBe(1);
    expect(await deletedIds()).toEqual([]);
    expect((await events(gone.id)).map((e) => e.kind)).toEqual(['first_seen', 'deleted', 'restored']);
    await sql`DELETE FROM delivery_supplier_orders WHERE delivery_id = ${deliveryId}`;
    await sql`DELETE FROM deliveries WHERE id = ${deliveryId}`;
  });

  it('обход оборвался на второй странице — никто не помечен', async () => {
    fake.orders = Array.from({ length: 4 }, () => order());
    finished(await run());
    fake.orders = fake.orders.slice(0, 1);
    fake.beforePage = (index) => {
      if (index === 1) throw new EstimatError('internal_error', 'сбой EstiMat', { status: 500, requestId: 'req-42' });
    };
    fake.orders.push(order(), order());
    const r = finished(await run());
    expect(r).toMatchObject({ outcome: 'error', errorCode: 'internal_error', requestId: 'req-42' });
    expect(await deletedIds()).toEqual([]);
    const [row] = await sql<{ outcome: string; request_id: string }[]>`
      SELECT outcome, request_id FROM estimat_sync_runs WHERE id = ${r.runId}`;
    expect(row).toMatchObject({ outcome: 'error', request_id: 'req-42' });
  });

  describe('полнота доступа токена', () => {
    it('токен сужен до объекта P — помечаются только пропавшие заказы P', async () => {
      const p1 = order({ projectId: PROJECT_P });
      const p2 = order({ projectId: PROJECT_P });
      const q1 = order({ projectId: PROJECT_Q });
      const none = order({ projectId: null });
      fake.orders = [p1, p2, q1, none];
      finished(await run());

      fake.caps = { scopes: ['purchases:read'], projectId: PROJECT_P };
      fake.orders = [p1, q1, none];
      const r = finished(await run());
      expect(r.counters.markedDeleted).toBe(1);
      expect(await deletedIds()).toEqual([p2.id]);
      const [row] = await sql<{ token_project_id: string; scope_confirmed: boolean }[]>`
        SELECT token_project_id, scope_confirmed FROM estimat_sync_runs WHERE id = ${r.runId}`;
      expect(row).toMatchObject({ token_project_id: PROJECT_P, scope_confirmed: true });
    });

    it('доступ изменился за время обхода — scope_changed, ничего не помечено', async () => {
      const a = order();
      const b = order();
      fake.orders = [a, b];
      finished(await run());
      fake.orders = [a];
      fake.capsSeq = [
        { scopes: ['purchases:read'], projectId: null },
        { scopes: ['purchases:read'], projectId: PROJECT_P },
      ];
      const r = finished(await run());
      expect(r.deletionSkippedReason).toBe('scope_changed');
      expect(await deletedIds()).toEqual([]);
    });

    it('второй /capabilities не ответил — scope_unconfirmed, ничего не помечено', async () => {
      const a = order();
      const b = order();
      fake.orders = [a, b];
      finished(await run());
      fake.orders = [a];
      fake.capsSeq = [{ scopes: ['purchases:read'], projectId: null }, new EstimatError('network', 'нет связи')];
      const r = finished(await run());
      expect(r).toMatchObject({ outcome: 'completed', deletionSkippedReason: 'scope_unconfirmed' });
      expect(await deletedIds()).toEqual([]);
    });

    it('нет purchases:read — ошибка до первой страницы', async () => {
      fake.orders = [order()];
      fake.caps = { scopes: ['estimates:read'], projectId: null };
      const r = finished(await run());
      expect(r).toMatchObject({ outcome: 'error', errorCode: 'insufficient_scope' });
      expect(fake.listCalls).toBe(0);
    });
  });

  it('массовое исчезновение не помечается; --accept-deletions помечает', async () => {
    fake.orders = Array.from({ length: 25 }, () => order());
    fake.pageSize = 100;
    finished(await run());
    const kept = fake.orders.slice(0, 4);
    fake.orders = kept;
    const r = finished(await run());
    expect(r.deletionSkippedReason).toBe('mass_disappearance');
    expect(await deletedIds()).toEqual([]);

    const forced = finished(await run('script', TOKEN_A, { acceptDeletions: true }));
    expect(forced.counters.markedDeleted).toBe(21);
  });

  it('брошенная попытка: заказ, встреченный только в ней, помечается после полной второй', async () => {
    const x = order();
    const y = order();
    const z = order();
    fake.orders = [x, y, z];
    finished(await run());

    // Попытка 1: первая страница содержит X, на второй — invalid_cursor. Пока
    // идёт попытка, X удаляют в EstiMat; попытка 2 его уже не видит.
    let failed = false;
    fake.beforePage = (index) => {
      if (index === 1 && !failed) {
        failed = true;
        fake.orders = [y, z];
        throw new EstimatCursorError('курсор устарел');
      }
    };
    const r = finished(await run());
    expect(r.counters.restarts).toBe(1);
    expect(await deletedIds()).toEqual([x.id]);
  });

  it('cursor_ignored на второй странице — рестарт, а не путаница страниц', async () => {
    fake.orders = Array.from({ length: 4 }, () => order());
    let ignored = false;
    const base = fake.client();
    fake.client = () => ({
      ...base,
      listSupplierOrders: async (cursor: string | null) => {
        const page = await base.listSupplierOrders(cursor);
        if (cursor !== null && !ignored) {
          ignored = true;
          const first = await base.listSupplierOrders(null);
          return { data: first.data, meta: { ...first.meta, warnings: ['cursor_ignored: формат устарел'] } };
        }
        return page;
      },
    });
    const r = finished(await run());
    expect(r.counters).toMatchObject({ restarts: 1, ordersSeen: 4, inserted: 4 });
  });

  it('битая строка с id не даёт ложного удаления; без id — пометка выключается', async () => {
    const a = order();
    const b = order();
    const c = order();
    fake.orders = [a, b, c];
    finished(await run());
    // b пришёл битым (нет стадии), но с id — он есть в EstiMat.
    fake.orders = [a, { ...b, sourcingStatus: undefined } as Row, c];
    const r1 = finished(await run());
    expect(r1.counters.invalidRows).toBe(1);
    expect(await deletedIds()).toEqual([]);

    // Строка без id — неизвестно, какой заказ пропал: не помечаем никого.
    fake.orders = [a, { garbage: true } as unknown as Row];
    const r2 = finished(await run());
    expect(r2.counters.invalidRowsNoId).toBe(1);
    expect(r2.deletionSkippedReason).toBe('invalid_rows_no_id');
    expect(await deletedIds()).toEqual([]);
  });

  it('401: автообход останавливается до смены токена; ручной запуск идёт', async () => {
    fake.orders = [order()];
    fake.beforePage = () => {
      throw new EstimatAuthError('api_token_revoked', 'токен отозван', { status: 401, requestId: 'req-401' });
    };
    const failed = finished(await run('auto'));
    expect(failed).toMatchObject({ outcome: 'error', errorCode: 'api_token_revoked', requestId: 'req-401' });

    const blocked = await run('auto');
    expect(blocked).toMatchObject({ skipped: 'auth_blocked' });
    const [skipRow] = await sql<{ outcome: string; error_code: string }[]>`
      SELECT outcome, error_code FROM estimat_sync_runs WHERE id = ${(blocked as { runId: string }).runId}`;
    expect(skipRow).toMatchObject({ outcome: 'skipped', error_code: 'auth_blocked' });
    // Пропущенная строка не считается «последним завершённым»: блок держится.
    expect(await run('auto')).toMatchObject({ skipped: 'auth_blocked' });

    fake.beforePage = null;
    expect(finished(await run('manual'))).toMatchObject({ outcome: 'completed' });
  });

  it('401 со старым токеном не блокирует автообход с новым токеном', async () => {
    fake.orders = [order()];
    fake.beforePage = () => {
      throw new EstimatAuthError('api_token_expired', 'истёк', { status: 401 });
    };
    finished(await run('auto', TOKEN_A));
    fake.beforePage = null;
    expect(finished(await run('auto', TOKEN_B))).toMatchObject({ outcome: 'completed' });
  });

  it('второй одновременный обход — already_running; брошенный старше 30 мин закрывается', async () => {
    await sql`INSERT INTO estimat_sync_runs (trigger) VALUES ('auto')`;
    expect(await run()).toEqual({ skipped: 'already_running' });

    await sql`UPDATE estimat_sync_runs SET heartbeat_at = now() - interval '31 minutes' WHERE outcome = 'running'`;
    fake.orders = [order()];
    expect(finished(await run())).toMatchObject({ outcome: 'completed' });
    const [stale] = await sql<{ outcome: string; error_code: string }[]>`
      SELECT outcome, error_code FROM estimat_sync_runs WHERE trigger = 'auto' ORDER BY started_at LIMIT 1`;
    expect(stale).toMatchObject({ outcome: 'error', error_code: 'run_lost' });
  });

  it('обход, закрытый другим процессом, получает run_lost и ничего не пишет', async () => {
    const a = order();
    const b = order();
    const c = order();
    fake.orders = [a, b, c];
    finished(await run());

    fake.orders = [a];
    fake.pageSize = 1;
    fake.orders.push(order());
    fake.beforePage = async (index) => {
      if (index === 1) {
        await sql`UPDATE estimat_sync_runs SET outcome = 'error', error_code = 'run_lost' WHERE outcome = 'running'`;
      }
    };
    const r = await run();
    expect(r).toMatchObject({ skipped: 'run_lost' });
    expect(await deletedIds()).toEqual([]);
    const [row] = await sql<{ outcome: string; finished_at: Date | null }[]>`
      SELECT outcome, finished_at FROM estimat_sync_runs WHERE id = ${(r as { runId: string }).runId}`;
    expect(row).toMatchObject({ outcome: 'error', finished_at: null });
  });

  it('ограничения схемы: второй running и неизвестный вид события', async () => {
    await sql`INSERT INTO estimat_sync_runs (trigger) VALUES ('auto')`;
    await expect(sql`INSERT INTO estimat_sync_runs (trigger) VALUES ('manual')`).rejects.toMatchObject({ code: '23505' });
    await expect(sql`INSERT INTO estimat_sync_runs (trigger, outcome) VALUES ('nope', 'completed')`).rejects.toMatchObject({
      code: '23514',
    });
    const o = order();
    fake.orders = [o];
    await sql`DELETE FROM estimat_sync_runs`;
    finished(await run());
    await expect(
      sql`INSERT INTO estimat_supplier_order_events (order_id, kind) VALUES (${o.id}, 'whatever')`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  async function createDelivery(): Promise<string> {
    const id = randomUUID();
    const [status] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    await sql`INSERT INTO deliveries (id, site_id, status_id) VALUES (${id}, ${siteId}, ${status!.id})`;
    return id;
  }
});
