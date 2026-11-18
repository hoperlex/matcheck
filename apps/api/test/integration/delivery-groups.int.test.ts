/**
 * Группы приёмок (рейсы одной поставки) на настоящем PostgreSQL.
 *
 * Обещания (план 16.11 «группы приёмок», ред. 4):
 *   - сбор группы — одна операция, всё или ничего; черновик, удаляемая, из
 *     отгрузки, чужая группа, другой объект, больше 50 — ничего не изменено;
 *   - инварианты держатся на всех путях: в группе ≥ 2 живых приёмок одного
 *     объекта, приёмка не больше чем в одной группе;
 *   - пометка на удаление, окончательное удаление и перенос на другой объект
 *     выводят приёмку из группы; восстановление не возвращает;
 *   - ни один путь групп не трогает deliveries.version/updated_at (планшет);
 *   - список с grouped=1 ставит группу подряд, без параметра порядок прежний;
 *   - привязка УПД ко всей группе: состав сверяется, уже привязанные не мешают;
 *   - гонки — без 40P01 и без нарушения инвариантов.
 *
 * Запуск: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test
 * Без переменной набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../src/db/schema.js';
import type { Db } from '../../src/db/client.js';
import type { AuthUser } from '../../src/plugins/auth.js';
import type * as EventsModule from '../../src/routes/events.js';

const published = vi.hoisted(() => [] as { type: string; entityId: string; siteId?: string }[]);

vi.mock('../../src/routes/events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EventsModule>();
  return {
    ...actual,
    publishEvent: (_app: unknown, event: { type: string; entityId: string; siteId?: string }) => {
      published.push(event);
    },
  };
});

const { deliveryRoutes } = await import('../../src/routes/deliveries.js');
const { loadDeliveryGroupSummaries } =
  await import('../../src/domain/operations/delivery-groups.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const RUN = String(Date.now()).slice(-6);
const DAY = '2031-08-10';

type Ref = { deliveryId: string; displayId: number };
const ids = (refs: Ref[]) => refs.map((r) => r.deliveryId).sort();

suite('группы приёмок (реальный PostgreSQL)', { timeout: 240_000 }, () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let currentUser: AuthUser;
  const status: Record<string, string> = {};

  const siteA = randomUUID();
  const siteB = randomUUID();
  const managerId = randomUUID();
  const sessionId = randomUUID();
  const diadocAcc = randomUUID();

  async function shipment(): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO shipments (id, status_id, kind, site_id)
              SELECT ${id}, s.id, 'writeoff', ${siteB} FROM statuses s
               WHERE s.entity_type = 'shipment' AND s.code = 'draft' LIMIT 1`;
    return id;
  }

  async function delivery(
    o: { site?: string; code?: string; pending?: boolean; shipment?: boolean } = {},
  ): Promise<string> {
    const id = randomUUID();
    const shipmentId = o.shipment ? await shipment() : null;
    await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, arrived_at, version,
                                      pending_deletion_at, pending_deletion_by_user_id, source_shipment_id)
              VALUES (${id}, ${o.site ?? siteA}, ${managerId}, ${status[o.code ?? 'filled']!},
                      ${`${DAY}T08:00:00Z`}, 1,
                      ${o.pending ? `${DAY}T09:00:00Z` : null}, ${o.pending ? managerId : null},
                      ${shipmentId})`;
    return id;
  }
  const deliveriesN = async (n: number, o: Parameters<typeof delivery>[0] = {}) => {
    const out: string[] = [];
    for (let i = 0; i < n; i += 1) out.push(await delivery(o));
    return out;
  };

  const compose = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/delivery-groups', payload: body });
  const create = async (...deliveryIds: string[]): Promise<string> => {
    const res = await compose({ add: deliveryIds });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().groupId as string;
  };
  const leave = (deliveryIds: string[]) =>
    app.inject({ method: 'POST', url: '/api/v1/delivery-groups/leave', payload: { deliveryIds } });
  const dissolve = (groupId: string) =>
    app.inject({ method: 'DELETE', url: `/api/v1/delivery-groups/${groupId}` });
  const members = (groupId: string) =>
    app.inject({ method: 'GET', url: `/api/v1/delivery-groups/${groupId}/members` });

  async function groupOf(deliveryId: string): Promise<string | null> {
    const rows = await sql<{ group_id: string }[]>`
      SELECT group_id FROM delivery_group_members WHERE delivery_id = ${deliveryId}`;
    return rows[0]?.group_id ?? null;
  }
  async function memberIdsOf(groupId: string): Promise<string[]> {
    const rows = await sql<{ delivery_id: string }[]>`
      SELECT delivery_id FROM delivery_group_members WHERE group_id = ${groupId}`;
    return rows.map((r) => r.delivery_id).sort();
  }
  const groupExists = async (groupId: string) =>
    (await sql`SELECT 1 FROM delivery_groups WHERE id = ${groupId}`).length > 0;
  const groupCount = async () =>
    Number(
      (
        await sql<{ n: string }[]>`
          SELECT count(*) AS n FROM delivery_groups WHERE site_id IN (${siteA}, ${siteB})`
      )[0]!.n,
    );

  /** Инварианты групп обоих объектов набора. */
  async function expectInvariants(label = '') {
    const broken = await sql<{ id: string; n: string; same: boolean; live: boolean }[]>`
      SELECT g.id, count(m.delivery_id) AS n,
             coalesce(bool_and(d.site_id = g.site_id), true) AS same,
             coalesce(bool_and(d.pending_deletion_at IS NULL), true) AS live
        FROM delivery_groups g
        LEFT JOIN delivery_group_members m ON m.group_id = g.id
        LEFT JOIN deliveries d ON d.id = m.delivery_id
       WHERE g.site_id IN (${siteA}, ${siteB})
       GROUP BY g.id
      HAVING count(m.delivery_id) < 2 OR count(m.delivery_id) > 50
          OR NOT coalesce(bool_and(d.site_id = g.site_id), true)
          OR NOT coalesce(bool_and(d.pending_deletion_at IS NULL), true)`;
    expect(broken, `инварианты групп ${label}`).toEqual([]);
  }

  /** version/updated_at — то, по чему планшет решает, тянуть ли приёмку. */
  async function stamps(list: string[]) {
    // ::text — drizzle подменяет разбор дат у общего клиента postgres.js.
    const rows = await sql<{ id: string; version: number; updated_at: string }[]>`
      SELECT id, version, updated_at::text AS updated_at FROM deliveries
       WHERE id IN ${sql(list)} ORDER BY id`;
    return rows.map((r) => `${r.id}:${r.version}:${r.updated_at}`);
  }

  const displayIdOf = async (id: string) =>
    Number(
      (await sql<{ display_id: string }[]>`SELECT display_id FROM deliveries WHERE id = ${id}`)[0]!
        .display_id,
    );

  async function exportDoc(tag: string): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO edo_export_documents
        (id, edo_account_id, message_id, entity_id, document_type, document_number, document_date,
         supplier_inn, supplier_name, total_sum, content_category, status, s3_key, content_sha256,
         size_bytes, received_at)
      VALUES (${id}, ${diadocAcc}, ${`m-${id}`}, ${`e-${id}`}, 'UniversalTransferDocument',
              ${`ГР-${RUN}-${tag}`}, ${DAY}, '7700000002', 'ООО «Группа»', 1000.00, 'materials',
              'stored', ${`edo-export/test/${id}.xml`}, ${`${tag}${RUN}${id}`.slice(0, 64).padEnd(64, '0')},
              2048, ${`${DAY}T09:00:00Z`})`;
    return id;
  }
  const batch = (
    anchor: string,
    documentId: string,
    targets: string[],
    deliveryGroup?: { id: string; memberIds: string[] },
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/deliveries/${anchor}/edo-matches/batch`,
      payload: {
        documentId,
        source: 'export',
        targets: targets.map((deliveryId) => ({ deliveryId, sectionDocumentId: null })),
        ...(deliveryGroup ? { deliveryGroup } : {}),
      },
    });
  async function linkedTo(documentId: string): Promise<string[]> {
    const rows = await sql<{ delivery_id: string }[]>`
      SELECT delivery_id FROM delivery_edo_matches WHERE export_document_id = ${documentId}`;
    return rows.map((r) => r.delivery_id).sort();
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 12 });
    db = drizzle(sql, { schema, casing: 'snake_case' }) as unknown as Db;
    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', db as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = currentUser;
    });
    app.decorate(
      'authorize',
      (...roles: AuthUser['role'][]) =>
        async (
          req: { user?: AuthUser },
          reply: { code: (c: number) => { send: (b: unknown) => void } },
        ) => {
          if (!req.user || !roles.includes(req.user.role)) {
            reply.code(403).send({ error: 'forbidden' });
          }
        },
    );
    await app.register(deliveryRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteA}, ${`GRA${RUN}`}, 'Группы А'),
                                                       (${siteB}, ${`GRB${RUN}`}, 'Группы Б')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
              VALUES (${managerId}, ${`groups-${managerId}@test`}, 'x', 'manager', NULL)`;
    await sql`INSERT INTO sessions (id, user_id) VALUES (${sessionId}, ${managerId})`;
    currentUser = {
      id: managerId,
      role: 'manager',
      siteId: null,
      contractorCustomerId: null,
      sessionId,
    } as unknown as AuthUser;
    await sql`INSERT INTO edo_accounts (id, name, credentials_encrypted, box_id)
              VALUES (${diadocAcc}, ${`Диадок группы ${RUN}`}, '{}', ${`box-groups-${RUN}`})`;
    for (const row of await sql<{ id: string; code: string }[]>`
      SELECT id, code FROM statuses WHERE entity_type = 'delivery'`)
      status[row.code] = row.id;
  });

  beforeEach(() => {
    published.length = 0;
    currentUser = {
      id: managerId,
      role: 'manager',
      siteId: null,
      contractorCustomerId: null,
      sessionId,
    } as unknown as AuthUser;
  });

  afterAll(async () => {
    if (!sql) return;
    await app.close();
    const sites = [siteA, siteB];
    await sql`DELETE FROM delivery_groups WHERE site_id IN ${sql(sites)}`;
    await sql`DELETE FROM delivery_edo_matches WHERE delivery_id IN (SELECT id FROM deliveries WHERE site_id IN ${sql(sites)})`;
    await sql`DELETE FROM deliveries WHERE site_id IN ${sql(sites)}`;
    await sql`DELETE FROM shipments WHERE site_id IN ${sql(sites)}`;
    await sql`DELETE FROM edo_export_documents WHERE edo_account_id = ${diadocAcc}`;
    await sql`DELETE FROM edo_accounts WHERE id = ${diadocAcc}`;
    await sql`DELETE FROM sessions WHERE user_id = ${managerId}`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM sites WHERE id IN ${sql(sites)}`;
    await sql.end({ timeout: 5 });
  });

  describe('сбор группы', () => {
    it('группа из трёх: состав по убыванию номера, событие по каждой, планшет не задет', async () => {
      const list = await deliveriesN(3);
      const before = await stamps(list);
      const res = await compose({ add: list });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.dissolved).toBe(false);
      expect(ids(body.members)).toEqual([...list].sort());
      const numbers = body.members.map((m: Ref) => m.displayId);
      expect(numbers).toEqual([...numbers].sort((a: number, b: number) => b - a));
      expect(await memberIdsOf(body.groupId)).toEqual([...list].sort());
      expect(published.map((e) => e.entityId).sort()).toEqual([...list].sort());
      expect(published.every((e) => e.type === 'delivery_updated' && e.siteId === siteA)).toBe(
        true,
      );
      expect(await stamps(list)).toEqual(before);
      await expectInvariants();
    });

    it('добавление по groupId; устаревший expectedMemberIds — group_changed, ничего не изменено', async () => {
      const [d1, d2, d3, d4] = await deliveriesN(4);
      const groupId = await create(d1!, d2!);
      const ok = await compose({ groupId, expectedMemberIds: [d1, d2], add: [d3] });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ids(ok.json().added)).toEqual([d3]);
      expect(await memberIdsOf(groupId)).toEqual([d1!, d2!, d3!].sort());

      const stale = await compose({ groupId, expectedMemberIds: [d1, d2], add: [d4] });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: 'group_changed' });
      expect(await groupOf(d4!)).toBeNull();

      const same = await compose({ groupId, add: [d1] });
      expect(same.statusCode).toBe(200);
      expect(same.json().added).toEqual([]);
    });

    it('замена в группе из двух одной операцией: группа живёт, id тот же', async () => {
      const [d1, d2, d3] = await deliveriesN(3);
      const groupId = await create(d1!, d2!);
      const res = await compose({
        groupId,
        expectedMemberIds: [d1, d2],
        add: [d3],
        remove: [d2],
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ groupId, dissolved: false });
      expect(await memberIdsOf(groupId)).toEqual([d1!, d3!].sort());
      expect(await groupOf(d2!)).toBeNull();
      await expectInvariants();
    });

    it('убрать до одной — группа распущена', async () => {
      const [d1, d2] = await deliveriesN(2);
      const groupId = await create(d1!, d2!);
      published.length = 0;
      const res = await compose({ groupId, remove: [d2] });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ groupId: null, dissolved: true, members: [] });
      expect(await groupExists(groupId)).toBe(false);
      expect(await groupOf(d1!)).toBeNull();
      expect(published.map((e) => e.entityId).sort()).toEqual([d1!, d2!].sort());
    });

    it('всё или ничего: черновик, удаляемая, из отгрузки, чужая группа, другой объект, мало, нет', async () => {
      const ok = await delivery();
      const cases: Array<[string, () => Promise<Record<string, unknown>>, number]> = [
        ['draft', async () => ({ add: [ok, await delivery({ code: 'draft' })] }), 409],
        ['pending_deletion', async () => ({ add: [ok, await delivery({ pending: true })] }), 409],
        ['from_shipment', async () => ({ add: [ok, await delivery({ shipment: true })] }), 409],
        ['other_site', async () => ({ add: [ok, await delivery({ site: siteB })] }), 409],
        ['too_few', async () => ({ add: [ok] }), 400],
        ['not_found', async () => ({ add: [ok, randomUUID()] }), 404],
        [
          'in_other_group',
          async () => {
            const [x, y] = await deliveriesN(2);
            await create(x!, y!);
            return { add: [ok, x] };
          },
          409,
        ],
      ];
      for (const [error, body, code] of cases) {
        const payload = await body();
        const groupsBefore = await groupCount();
        const res = await compose(payload);
        expect(res.statusCode, `${error}: ${res.body}`).toBe(code);
        expect(res.json()).toMatchObject({ error });
        expect(await groupCount(), error).toBe(groupsBefore);
        expect(await groupOf(ok), error).toBeNull();
      }
    });

    it('добавление в группу с другого объекта — other_site против объекта группы', async () => {
      const [d1, d2] = await deliveriesN(2);
      const groupId = await create(d1!, d2!);
      const foreign = await delivery({ site: siteB });
      const res = await compose({ groupId, add: [foreign] });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'other_site' });
      expect(res.json().deliveries.map((d: Ref) => d.deliveryId)).toEqual([foreign]);
      expect(await groupOf(foreign)).toBeNull();
    });

    it('лимит 50 считает всех; пометка → добавили 50-ю → восстановили — 50, восстановленная вне группы', async () => {
      const fifty = await deliveriesN(50);
      const groupId = await create(...fifty);
      const extra = await deliveriesN(2);
      const over = await compose({ groupId, add: [extra[0]] });
      expect(over.statusCode).toBe(409);
      expect(over.json()).toMatchObject({ error: 'too_many' });

      const marked = fifty[0]!;
      const mark = await app.inject({
        method: 'POST',
        url: `/api/v1/deliveries/${marked}/mark-deletion`,
        payload: {},
      });
      expect(mark.statusCode, mark.body).toBe(200);
      expect(await groupOf(marked)).toBeNull();
      const add = await compose({ groupId, add: [extra[0]] });
      expect(add.statusCode, add.body).toBe(200);
      const restore = await app.inject({
        method: 'POST',
        url: `/api/v1/deliveries/${marked}/unmark-deletion`,
      });
      expect(restore.statusCode, restore.body).toBe(200);
      expect(await groupOf(marked)).toBeNull();
      expect((await memberIdsOf(groupId)).length).toBe(50);
      const full = await members(groupId);
      expect(full.json().memberIds.length).toBe(50);
      expect(full.json().items.length).toBe(50);
      await expectInvariants();
    });
  });

  describe('уход и роспуск', () => {
    it('убрать из группы: из группы трёх — две остаются; без группы — пропуск; из двух — роспуск', async () => {
      const [a1, a2, a3, b1, b2, loner] = await deliveriesN(6);
      const ga = await create(a1!, a2!, a3!);
      const gb = await create(b1!, b2!);
      const res = await leave([a1!, b1!, loner!]);
      expect(res.statusCode, res.body).toBe(200);
      expect(ids(res.json().removed)).toEqual([a1!, b1!].sort());
      expect(res.json().dissolvedGroupIds).toEqual([gb]);
      expect(await memberIdsOf(ga)).toEqual([a2!, a3!].sort());
      expect(await groupExists(gb)).toBe(false);
      await expectInvariants();
    });

    it('разгруппировать: все вне группы, повтор — 404', async () => {
      const list = await deliveriesN(3);
      const groupId = await create(...list);
      const before = await stamps(list);
      const res = await dissolve(groupId);
      expect(res.statusCode, res.body).toBe(200);
      expect(ids(res.json().removed)).toEqual([...list].sort());
      expect(await groupExists(groupId)).toBe(false);
      expect(await stamps(list)).toEqual(before);
      const again = await dissolve(groupId);
      expect(again.statusCode).toBe(404);
    });
  });

  describe('внешние пути записи', () => {
    it('пометка на удаление (одиночная и массовая) выводит из группы, группа из двух распускается', async () => {
      const [d1, d2, d3, d4] = await deliveriesN(4);
      const g1 = await create(d1!, d2!);
      const g2 = await create(d3!, d4!);
      const single = await app.inject({
        method: 'POST',
        url: `/api/v1/deliveries/${d1}/mark-deletion`,
        payload: {},
      });
      expect(single.statusCode, single.body).toBe(200);
      expect(await groupExists(g1)).toBe(false);
      const bulk = await app.inject({
        method: 'POST',
        url: '/api/v1/deliveries/bulk-mark-deletion',
        payload: { ids: [d3] },
      });
      expect(bulk.statusCode, bulk.body).toBe(200);
      expect(bulk.json().deleted).toEqual([d3]);
      expect(await groupExists(g2)).toBe(false);
      expect([await groupOf(d2!), await groupOf(d4!)]).toEqual([null, null]);
      await expectInvariants();
    });

    it('окончательное удаление «не заполненной» приёмки распускает группу из двух', async () => {
      const keep = await delivery();
      const gone = await delivery({ code: 'not_filled' });
      const groupId = await create(keep, gone);
      const res = await app.inject({ method: 'DELETE', url: `/api/v1/deliveries/${gone}` });
      expect(res.statusCode, res.body).toBe(200);
      expect(await groupExists(groupId)).toBe(false);
      expect(await groupOf(keep)).toBeNull();
    });

    it('upsert со сменой объекта выводит приёмку; без смены — группа не тронута', async () => {
      const [d1, d2, d3] = await deliveriesN(3);
      const groupId = await create(d1!, d2!, d3!);
      const upsert = (id: string, siteId: string) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/deliveries',
          payload: { id, statusCode: 'filled', siteId, items: [], sourceDocumentIds: [] },
        });
      const same = await upsert(d1!, siteA);
      expect(same.statusCode, same.body).toBe(200);
      expect(await groupOf(d1!)).toBe(groupId);

      const moved = await upsert(d1!, siteB);
      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json()).toMatchObject({ id: d1, siteId: siteB });
      expect(await groupOf(d1!)).toBeNull();
      expect(await memberIdsOf(groupId)).toEqual([d2!, d3!].sort());
      await expectInvariants();
    });

    it('состав для привязки: член, ставший черновиком, приходит; items и memberIds совпадают', async () => {
      const [d1, d2] = await deliveriesN(2);
      const groupId = await create(d1!, d2!);
      await sql`UPDATE deliveries SET status_id = ${status.draft!} WHERE id = ${d2!}`;
      const res = await members(groupId);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect([...body.memberIds].sort()).toEqual([d1!, d2!].sort());
      expect(body.items.map((i: { id: string }) => i.id)).toEqual(body.memberIds);
      expect(body.siteId).toBe(siteA);
      expect((await members(randomUUID())).statusCode).toBe(404);
    });
  });

  describe('список «Принятые»', () => {
    it('grouped=1: группа подряд на месте самой новой; без параметра порядок прежний; в корзине без поля', async () => {
      // Отдельный объект — чужие строки набора не мешают считать порядок.
      const site = randomUUID();
      await sql`INSERT INTO sites (id, code, name) VALUES (${site}, ${`GRL${RUN}`}, 'Группы список')`;
      try {
        const list: string[] = [];
        for (let i = 0; i < 6; i += 1) list.push(await delivery({ site }));
        const [x0, x1, x2, x3, x4, x5] = list;
        // Группа из самой старой и одной из середины, вторая группа — соседние.
        const g1 = await create(x0!, x3!);
        await create(x4!, x5!);
        const plain = await app.inject({
          method: 'GET',
          url: `/api/v1/deliveries?siteIds=${site}&limit=50`,
        });
        expect(plain.statusCode, plain.body).toBe(200);
        const plainOrder = plain.json().items.map((i: { id: string }) => i.id);
        expect(plainOrder).toEqual([...list].reverse());
        expect(plain.json().items.every((i: object) => !('deliveryGroup' in i))).toBe(true);

        const grouped = await app.inject({
          method: 'GET',
          url: `/api/v1/deliveries?siteIds=${site}&limit=50&grouped=1`,
        });
        const items = grouped.json().items as Array<{
          id: string;
          deliveryGroup: { id: string; members: Ref[] } | null;
        }>;
        expect(items.map((i) => i.id)).toEqual([x5, x4, x3, x0, x2, x1]);
        const head = items.find((i) => i.id === x3)!;
        expect(head.deliveryGroup).toMatchObject({ id: g1, siteId: site });
        expect(head.deliveryGroup!.members.map((m) => m.deliveryId)).toEqual([x3, x0]);
        expect(items.find((i) => i.id === x1)!.deliveryGroup).toBeNull();
        // Без права привязки в этом стенде сведений ЭДО нет.
        expect(head.deliveryGroup).not.toHaveProperty('edoLinkedCount');
        expect(grouped.json().total).toBe(6);

        const page2 = await app.inject({
          method: 'GET',
          url: `/api/v1/deliveries?siteIds=${site}&limit=2&offset=2&grouped=1`,
        });
        expect(page2.json().items.map((i: { id: string }) => i.id)).toEqual([x3, x0]);

        const trash = await app.inject({
          method: 'GET',
          url: `/api/v1/deliveries?siteIds=${site}&grouped=1&trash=true`,
        });
        expect(trash.statusCode).toBe(200);
        expect(trash.json().items).toEqual([]);

        const bogus = await app.inject({
          method: 'GET',
          url: `/api/v1/deliveries?siteIds=${site}&grouped=true`,
        });
        expect(bogus.statusCode).toBe(400);
      } finally {
        await sql`DELETE FROM delivery_groups WHERE site_id = ${site}`;
        await sql`DELETE FROM deliveries WHERE site_id = ${site}`;
        await sql`DELETE FROM sites WHERE id = ${site}`;
      }
    });

    it('мониторинг видит группы, инспектор и подрядчик — нет (как поля проверки)', async () => {
      const [d1, d2] = await deliveriesN(2);
      await create(d1!, d2!);
      const as = (role: string) => {
        currentUser = { ...currentUser, role } as unknown as AuthUser;
      };
      const groupOn = async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/deliveries?displayId=${await displayIdOf(d1!)}&grouped=1`,
        });
        expect(res.statusCode, res.body).toBe(200);
        return res.json().items[0]?.deliveryGroup;
      };
      as('monitor');
      expect(await groupOn()).toMatchObject({ siteId: siteA });
      as('monitor');
      const byMonitor = await compose({ add: await deliveriesN(2) });
      expect(byMonitor.statusCode, byMonitor.body).toBe(200);
      as('admin');
      expect((await compose({ add: await deliveriesN(2) })).statusCode).toBe(200);
      for (const role of ['inspector_kpp', 'contractor', 'observer']) {
        as(role);
        expect((await compose({ add: await deliveriesN(2) })).statusCode, role).toBe(403);
      }
    });

    it('edoLinkedCount — сколько участников уже с УПД из ЭДО (только по запросу)', async () => {
      const [d1, d2, d3] = await deliveriesN(3);
      await create(d1!, d2!, d3!);
      const doc = await exportDoc('E1');
      expect((await batch(d1!, doc, [d1!, d2!])).statusCode).toBe(200);
      const withEdo = await loadDeliveryGroupSummaries(db, [d1!], {
        withEdo: true,
        withDispatcher: false,
      });
      expect(withEdo.get(d1!)).toMatchObject({ edoLinkedCount: 2 });
      const without = await loadDeliveryGroupSummaries(db, [d1!], {
        withEdo: false,
        withDispatcher: false,
      });
      expect(without.get(d1!)).not.toHaveProperty('edoLinkedCount');
    });

    it('dispatcher — у скольких оформленных участников стоит «Диспетчер»; инспектору группы нет', async () => {
      const d1 = await delivery();
      const d2 = await delivery({ code: 'confirmed_mol' });
      const d3 = await delivery();
      const raw = await delivery({ code: 'not_filled' });
      await create(d1, d2, d3, raw);
      await sql`UPDATE deliveries SET dispatcher_checked_at = now(), dispatcher_checked_by_user_id = ${managerId}
                 WHERE id IN (${d1}, ${d2})`;
      const summary = await loadDeliveryGroupSummaries(db, [d3], {
        withEdo: false,
        withDispatcher: true,
      });
      // Неоформленная не в счёт: отметку ей поставить нельзя.
      expect(summary.get(d3)).toMatchObject({ dispatcher: { checked: 2, eligible: 3 } });
      const hidden = await loadDeliveryGroupSummaries(db, [d3], {
        withEdo: false,
        withDispatcher: false,
      });
      expect(hidden.get(d3)).not.toHaveProperty('dispatcher');

      const listed = async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/deliveries?displayId=${await displayIdOf(d3)}&grouped=1`,
        });
        expect(res.statusCode, res.body).toBe(200);
        return res.json().items[0]?.deliveryGroup;
      };
      expect(await listed()).toMatchObject({ dispatcher: { checked: 2, eligible: 3 } });
      currentUser = { ...currentUser, role: 'inspector_kpp', siteId: siteA } as unknown as AuthUser;
      expect(await listed()).toBeFalsy();
    });
  });

  describe('УПД из ЭДО ко всей группе', () => {
    it('ко всем; частичная (одна уже с УПД) и повторная — 200; без участника — group_incomplete', async () => {
      const [d1, d2, d3] = await deliveriesN(3);
      const groupId = await create(d1!, d2!, d3!);
      const memberIds = [d1!, d2!, d3!];
      const doc = await exportDoc('W1');
      const before = await stamps(memberIds);

      // Частичная: на d3 УПД уже стоит.
      expect((await batch(d3!, doc, [d3!])).statusCode).toBe(200);
      const partial = await batch(d1!, doc, memberIds, { id: groupId, memberIds });
      expect(partial.statusCode, partial.body).toBe(200);
      expect(ids(partial.json().linked)).toEqual([d1!, d2!].sort());
      expect(ids(partial.json().alreadyLinked)).toEqual([d3!]);
      expect(await linkedTo(doc)).toEqual([...memberIds].sort());

      // Повторная — ничего нового, не ошибка; участники в целях не обязательны,
      // если УПД на них уже стоит.
      const again = await batch(d1!, doc, [d1!], { id: groupId, memberIds });
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().linked).toEqual([]);
      expect(await stamps(memberIds)).toEqual(before);

      // Новая УПД, участник пропущен и без неё — отказ, ничего не вставлено.
      const doc2 = await exportDoc('W2');
      const missing = await batch(d1!, doc2, [d1!, d2!], { id: groupId, memberIds });
      expect(missing.statusCode).toBe(409);
      expect(missing.json()).toMatchObject({ error: 'group_incomplete' });
      expect(missing.json().deliveries.map((d: Ref) => d.deliveryId)).toEqual([d3]);
      expect(await linkedTo(doc2)).toEqual([]);
    });

    it('состав изменился — group_changed, ничего не вставлено; без группы — как раньше', async () => {
      const [d1, d2, d3] = await deliveriesN(3);
      const groupId = await create(d1!, d2!);
      expect((await compose({ groupId, add: [d3] })).statusCode).toBe(200);
      const doc = await exportDoc('C1');
      const stale = await batch(d1!, doc, [d1!, d2!], { id: groupId, memberIds: [d1!, d2!] });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: 'group_changed' });
      expect(await linkedTo(doc)).toEqual([]);

      const gone = await batch(d1!, doc, [d1!], { id: randomUUID(), memberIds: [d1!] });
      expect(gone.json()).toMatchObject({ error: 'group_changed' });

      const plain = await batch(d1!, doc, [d1!]);
      expect(plain.statusCode, plain.body).toBe(200);
    });
  });

  describe('гонки', () => {
    const allowed = (res: { statusCode: number }, codes: number[]) =>
      expect(codes, `код ${res.statusCode}`).toContain(res.statusCode);

    it('сбор {d1,d2} против {d2,d3}: одна группа, вторая — in_other_group', async () => {
      for (let round = 0; round < 10; round += 1) {
        const [d1, d2, d3] = await deliveriesN(3);
        const [a, b] = await Promise.all([compose({ add: [d1, d2] }), compose({ add: [d2, d3] })]);
        allowed(a, [200, 409]);
        allowed(b, [200, 409]);
        expect([a.statusCode, b.statusCode].sort(), `раунд ${round}`).toEqual([200, 409]);
        expect((a.statusCode === 409 ? a : b).json()).toMatchObject({ error: 'in_other_group' });
        await expectInvariants(`раунд ${round}`);
      }
    });

    it('добавление в G против роспуска G', async () => {
      for (let round = 0; round < 10; round += 1) {
        const [d1, d2, d3] = await deliveriesN(3);
        const groupId = await create(d1!, d2!);
        const [add, drop] = await Promise.all([compose({ groupId, add: [d3] }), dissolve(groupId)]);
        allowed(add, [200, 409]);
        expect(drop.statusCode).toBe(200);
        if (add.statusCode === 409) expect(add.json()).toMatchObject({ error: 'group_changed' });
        expect(await groupOf(d3!)).toBeNull();
        await expectInvariants(`раунд ${round}`);
      }
    });

    it('уход d из G против вступления d в H: членство меняется только под блокировками', async () => {
      for (let round = 0; round < 10; round += 1) {
        const [d, g2, h1, h2] = await deliveriesN(4);
        const g = await create(d!, g2!);
        const h = await create(h1!, h2!);
        const [out, into] = await Promise.all([leave([d!]), compose({ groupId: h, add: [d] })]);
        expect(out.statusCode).toBe(200);
        allowed(into, [200, 409]);
        if (into.statusCode === 409) {
          // Вступление шло первым и увидело d в G.
          expect(into.json()).toMatchObject({ error: 'in_other_group' });
          expect(await groupOf(d!)).toBeNull();
        }
        // Уход распустил G, H цела (в ней ≥ 2).
        expect(await groupExists(g)).toBe(false);
        expect(await groupExists(h)).toBe(true);
        await expectInvariants(`раунд ${round}`);
      }
    });

    it('перенос на другой объект против вступления той же приёмки', async () => {
      for (let round = 0; round < 10; round += 1) {
        const [d1, d2, moving] = await deliveriesN(3);
        const groupId = await create(d1!, d2!);
        const [up, add] = await Promise.all([
          app.inject({
            method: 'POST',
            url: '/api/v1/deliveries',
            payload: {
              id: moving,
              statusCode: 'filled',
              siteId: siteB,
              items: [],
              sourceDocumentIds: [],
            },
          }),
          compose({ groupId, add: [moving] }),
        ]);
        expect(up.statusCode, up.body).toBe(200);
        allowed(add, [200, 409]);
        await expectInvariants(`раунд ${round}`);
      }
    });

    it('пометка на удаление и восстановление против привязки ко всей группе', async () => {
      for (let round = 0; round < 10; round += 1) {
        const [d1, d2, d3] = await deliveriesN(3);
        const groupId = await create(d1!, d2!, d3!);
        const memberIds = [d1!, d2!, d3!];
        const doc = await exportDoc(`M${round}`);
        const [link, mark] = await Promise.all([
          batch(d1!, doc, memberIds, { id: groupId, memberIds }),
          app.inject({
            method: 'POST',
            url: `/api/v1/deliveries/${d3}/mark-deletion`,
            payload: {},
          }),
        ]);
        expect(mark.statusCode, mark.body).toBe(200);
        allowed(link, [200, 409]);
        if (link.statusCode === 409) {
          expect(['group_changed', 'pending_deletion']).toContain(link.json().error);
          expect(await linkedTo(doc)).toEqual([]);
        } else {
          expect(await linkedTo(doc)).toEqual([...memberIds].sort());
        }
        await expectInvariants(`раунд ${round}`);

        // Восстановление состав не меняет — привязка к оставшимся проходит.
        const rest = (await memberIdsOf(groupId)).length ? await memberIdsOf(groupId) : [];
        const doc2 = await exportDoc(`R${round}`);
        const [restore, link2] = await Promise.all([
          app.inject({ method: 'POST', url: `/api/v1/deliveries/${d3}/unmark-deletion` }),
          rest.length
            ? batch(rest[0]!, doc2, rest, { id: groupId, memberIds: rest })
            : Promise.resolve({ statusCode: 200, body: '' }),
        ]);
        expect(restore.statusCode, restore.body).toBe(200);
        expect(link2.statusCode, link2.body).toBe(200);
        expect(await groupOf(d3!)).toBeNull();
      }
    });

    it('сбор против привязки по той же группе', async () => {
      for (let round = 0; round < 10; round += 1) {
        const [d1, d2, d3] = await deliveriesN(3);
        const groupId = await create(d1!, d2!);
        const doc = await exportDoc(`S${round}`);
        const [link, add] = await Promise.all([
          batch(d1!, doc, [d1!, d2!], { id: groupId, memberIds: [d1!, d2!] }),
          compose({ groupId, add: [d3] }),
        ]);
        expect(add.statusCode, add.body).toBe(200);
        allowed(link, [200, 409]);
        if (link.statusCode === 409) expect(link.json()).toMatchObject({ error: 'group_changed' });
        await expectInvariants(`раунд ${round}`);
      }
    });
  });
});
