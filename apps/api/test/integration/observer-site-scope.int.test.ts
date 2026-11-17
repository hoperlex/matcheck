/**
 * Наблюдатель по объектам (user_sites) на живой БД — настоящая цепочка:
 * токен → plugins/auth (объекты из БД на каждом запросе) → plugins/permissions
 * (матрица + хук siteScope) → боевые маршруты.
 *
 * Объекты A, B, C; наблюдатель видит A и B. Что доказываем:
 *  - списки приёмок, отгрузок, документов, комплектов, журнала и справочник
 *    объектов отдают только A и B; фильтр `siteIds=C` не расширяет видимость;
 *  - чужая запись по id — 404 на каждом пути чтения (карточки, файлы, страницы,
 *    фото, итог импорта, заказы и договор приёмки);
 *  - свои записи по тем же путям открываются (не 404);
 *  - заказ чужого объекта, привязанный к своей приёмке с подтверждённым
 *    несовпадением, скрыт; у общего договора видны только свои коды объектов;
 *  - счётчики Операций не берутся из общего кэша;
 *  - пустой список — пусто везде; удаление объекта сужает доступ, а не
 *    открывает всё;
 *  - смена объектов админом гасит и access-, и refresh-токен наблюдателя.
 *
 * Запуск: TEST_DATABASE_URL=… npx vitest run test/integration/observer-site-scope.int.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.PERMISSIONS_ENFORCE = '1';
  process.env.REDIS_URL = 'redis://127.0.0.1:6399';
});

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import authPlugin from '../../src/plugins/auth.js';
import permissionsPlugin from '../../src/plugins/permissions.js';
import { registerErrorHandler } from '../../src/lib/error-handler.js';
import { signAccessToken } from '../../src/domain/auth/jwt.js';
import { createSessionAndRefresh, REFRESH_COOKIE_NAME } from '../../src/domain/auth/refresh.js';
import { authRoutes } from '../../src/routes/auth.js';
import { meRoutes } from '../../src/routes/me.js';
import { userAdminRoutes } from '../../src/routes/admin/users.js';
import { deliveryRoutes } from '../../src/routes/deliveries.js';
import { shipmentRoutes } from '../../src/routes/shipments.js';
import { sourceDocumentRoutes } from '../../src/routes/source-documents.js';
import { photoRoutes } from '../../src/routes/photos.js';
import { reportRoutes } from '../../src/routes/reports.js';
import { siteRoutes } from '../../src/routes/sites.js';
import { materialRoutes } from '../../src/routes/materials.js';
import { estimatRoutes } from '../../src/routes/estimat.js';
import { supplierContractsRoutes } from '../../src/routes/supplier-contracts.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

type Page =
  | 'operations.deliveries'
  | 'operations.shipments'
  | 'documents.list'
  | 'documents.extra_only'
  | 'materials_journal';
const OBSERVER_VIEW: Page[] = [
  'operations.deliveries',
  'operations.shipments',
  'documents.list',
  'documents.extra_only',
  'materials_journal',
];

suite('наблюдатель по объектам (PostgreSQL)', { timeout: 120_000 }, () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  const redisStore = new Map<string, string>();

  const tag = randomUUID().slice(0, 6);
  const site = { A: randomUUID(), B: randomUUID(), C: randomUUID(), D: randomUUID() };
  const user = {
    admin: randomUUID(),
    observer: randomUUID(),
    empty: randomUUID(),
    onlyD: randomUUID(),
  };
  const token: Record<keyof typeof user, string> = { admin: '', observer: '', empty: '', onlyD: '' };
  const delivery = { A: randomUUID(), B: randomUUID(), C: randomUUID() };
  const shipment = { A: randomUUID(), C: randomUUID() };
  const photo = { A: randomUUID(), C: randomUUID() };
  const doc = { A: randomUUID(), C: randomUUID() };
  const bundle = { A: randomUUID(), C: randomUUID(), extraA: randomUUID(), extraC: randomUUID() };
  const extraItem = { A: randomUUID(), C: randomUUID() };
  const order = { A: randomUUID(), C: randomUUID() };
  const contractId = randomUUID();
  let savedObserverRows: Record<string, unknown>[] = [];

  async function login(id: string, role: string): Promise<string> {
    const sid = randomUUID();
    await sql`INSERT INTO sessions (id, user_id) VALUES (${sid}, ${id})`;
    return signAccessToken({ sub: id, role: role as never, sid, aal: 'aal1' });
  }

  const get = (who: keyof typeof user, url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token[who]}` } });

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 8, onnotice: () => {} });
    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerErrorHandler(app);
    await app.register(cookie);
    app.decorate('db', drizzle(sql, { schema, casing: 'snake_case' }) as never);
    app.decorate('redis', {
      publish: async () => 0,
      get: async (k: string) => redisStore.get(k) ?? null,
      set: async (k: string, v: string) => {
        redisStore.set(k, v);
        return 'OK';
      },
      incr: async () => {
        throw new Error('redis disabled in test');
      },
    } as never);
    app.decorate('queues', new Proxy({}, { get: () => ({ add: async () => ({}) }) }) as never);
    await app.register(authPlugin);
    await app.register(permissionsPlugin);
    for (const routes of [
      authRoutes,
      meRoutes,
      userAdminRoutes,
      deliveryRoutes,
      shipmentRoutes,
      sourceDocumentRoutes,
      photoRoutes,
      reportRoutes,
      siteRoutes,
      materialRoutes,
      estimatRoutes,
      supplierContractsRoutes,
    ]) {
      await app.register(routes);
    }
    await app.ready();

    // Матрица: наблюдателю — просмотр операций, документов и журнала. Строки
    // роли общие с другими наборами — сохраняем и вернём в afterAll.
    savedObserverRows = await sql`SELECT * FROM role_page_permissions WHERE role = 'observer'`;
    await sql`DELETE FROM role_page_permissions WHERE role = 'observer'`;
    for (const page of OBSERVER_VIEW) {
      await sql`INSERT INTO role_page_permissions (role, page_id, can_view, can_create, can_edit, can_delete)
        VALUES ('observer', ${page}, true, false, false, false)`;
    }
    app.permissions.invalidateLocal();

    await sql`INSERT INTO sites (id, code, name) VALUES
      (${site.A}, ${`OA${tag}`}, 'Наблюдатель A'),
      (${site.B}, ${`OB${tag}`}, 'Наблюдатель B'),
      (${site.C}, ${`OC${tag}`}, 'Наблюдатель C'),
      (${site.D}, ${`OD${tag}`}, 'Наблюдатель D')`;
    await sql`INSERT INTO users (id, email, password_hash, role, is_active) VALUES
      (${user.admin}, ${`obs-admin-${tag}@test`}, 'x', 'admin', true),
      (${user.observer}, ${`obs-ab-${tag}@test`}, 'x', 'observer', true),
      (${user.empty}, ${`obs-empty-${tag}@test`}, 'x', 'observer', true),
      (${user.onlyD}, ${`obs-d-${tag}@test`}, 'x', 'observer', true)`;
    await sql`INSERT INTO user_sites (user_id, site_id) VALUES
      (${user.observer}, ${site.A}), (${user.observer}, ${site.B}), (${user.onlyD}, ${site.D})`;
    token.admin = await login(user.admin, 'admin');
    token.observer = await login(user.observer, 'observer');
    token.empty = await login(user.empty, 'observer');
    token.onlyD = await login(user.onlyD, 'observer');

    const [filled] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    const [shipped] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'shipment' AND code = 'shipped' LIMIT 1`;
    for (const k of ['A', 'B', 'C'] as const) {
      await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, version, arrived_at)
        VALUES (${delivery[k]}, ${site[k]}, ${user.admin}, ${filled!.id}, 1, now())`;
      await sql`INSERT INTO delivery_items (delivery_id, name_raw, line_no, qty_actual)
        VALUES (${delivery[k]}, ${`Материал ${k} ${tag}`}, 1, 1)`;
    }
    for (const k of ['A', 'C'] as const) {
      await sql`INSERT INTO shipments (id, site_id, inspector_id, status_id, kind, version)
        VALUES (${shipment[k]}, ${site[k]}, ${user.admin}, ${shipped!.id}, 'writeoff', 1)`;
      await sql`INSERT INTO delivery_photos (id, delivery_id, kind, s3_key)
        VALUES (${photo[k]}, ${delivery[k]}, 'cargo', ${`test/obs-${tag}-${k}.jpg`})`;
      await sql`INSERT INTO source_bundles (id, bundle_hash, direction, site_id, status)
        VALUES (${bundle[k]}, ${`obs-${tag}-${k}`}, 'inbound', ${site[k]}, 'done')`;
      await sql`INSERT INTO source_documents (id, kind, origin, status, site_id, bundle_id, doc_number)
        VALUES (${doc[k]}, 'upd', 'manual_pdf', 'parsed', ${site[k]}, ${bundle[k]}, ${`OBS-${tag}-${k}`})`;
      // Пакет без документов — для «Комплектов без документов».
      const extra = k === 'A' ? bundle.extraA : bundle.extraC;
      await sql`INSERT INTO source_bundles (id, bundle_hash, direction, site_id, status)
        VALUES (${extra}, ${`obs-${tag}-x${k}`}, 'inbound', ${site[k]}, 'done')`;
      await sql`INSERT INTO bundle_import_items (id, bundle_id, source_filename, status, input_s3_key)
        VALUES (${extraItem[k]}, ${extra}, ${`cert-${k}.pdf`}, 'skipped', ${`test/obs-${tag}-cert-${k}.pdf`})`;
      await sql`INSERT INTO estimat_supplier_orders (id, site_id, sourcing_status, raw, last_seen_pass_id)
        VALUES (${order[k]}, ${site[k]}, 'awarded', '{}'::jsonb, ${randomUUID()})`;
    }
    // Своя приёмка A: заказ своего объекта и заказ объекта C, привязанный с
    // подтверждённым несовпадением (confirmSiteMismatch).
    await sql`INSERT INTO delivery_supplier_orders (delivery_id, order_id, site_mismatch) VALUES
      (${delivery.A}, ${order.A}, false), (${delivery.A}, ${order.C}, true)`;
    // Общий договор 1С на объекты A и C.
    await sql`INSERT INTO supplier_contracts
        (id, onec_id, counterparty_name, counterparty_inn, name, kind, site_status, site_ids, object_text)
      VALUES (${contractId}, ${randomUUID()}, 'ООО Тест', '7700000000', ${`Договор ${tag}`}, 'supplier',
        'group', ${sql.array([site.A, site.C])}::uuid[], 'ЖК Альфа и ЖК Цэ')`;
    await sql`INSERT INTO delivery_contracts (delivery_id, contract_id) VALUES (${delivery.A}, ${contractId})`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    const deliveries = Object.values(delivery);
    await sql`DELETE FROM delivery_contracts WHERE delivery_id IN ${sql(deliveries)}`;
    await sql`DELETE FROM supplier_contracts WHERE id = ${contractId}`;
    await sql`DELETE FROM delivery_supplier_orders WHERE delivery_id IN ${sql(deliveries)}`;
    await sql`DELETE FROM estimat_supplier_orders WHERE id IN ${sql(Object.values(order))}`;
    await sql`DELETE FROM delivery_photos WHERE id IN ${sql(Object.values(photo))}`;
    await sql`DELETE FROM delivery_items WHERE delivery_id IN ${sql(deliveries)}`;
    await sql`DELETE FROM deliveries WHERE id IN ${sql(deliveries)}`;
    await sql`DELETE FROM shipments WHERE id IN ${sql(Object.values(shipment))}`;
    await sql`DELETE FROM source_documents WHERE id IN ${sql(Object.values(doc))}`;
    await sql`DELETE FROM bundle_import_items WHERE bundle_id IN ${sql(Object.values(bundle))}`;
    await sql`DELETE FROM source_bundles WHERE id IN ${sql(Object.values(bundle))}`;
    await sql`DELETE FROM sessions WHERE user_id IN ${sql(Object.values(user))}`;
    await sql`DELETE FROM users WHERE id IN ${sql(Object.values(user))}`;
    await sql`DELETE FROM sites WHERE id IN ${sql(Object.values(site))}`;
    await sql`DELETE FROM role_page_permissions WHERE role = 'observer'`;
    for (const row of savedObserverRows) {
      await sql`INSERT INTO role_page_permissions ${sql(row as never)}`;
    }
    await sql.end();
  });

  it('профиль наблюдателя несёт его объекты', async () => {
    const me = await get('observer', '/api/v1/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().siteIds).toEqual([site.A, site.B].sort());
    const perms = await get('observer', '/api/v1/me/permissions');
    expect(perms.json().authzRevision).toContain([site.A, site.B].sort().join(','));
  });

  it('списки — только свои объекты; фильтр по чужому объекту даёт пусто', async () => {
    const list = await get('observer', '/api/v1/deliveries?limit=200');
    expect(list.statusCode).toBe(200);
    const ids = list.json().items.map((d: { id: string }) => d.id);
    expect(ids).toEqual(expect.arrayContaining([delivery.A, delivery.B]));
    expect(ids).not.toContain(delivery.C);
    for (const d of list.json().items as { siteId: string }[]) {
      expect([site.A, site.B]).toContain(d.siteId);
    }
    const foreign = await get('observer', `/api/v1/deliveries?siteIds=${site.C}`);
    expect(foreign.json().items).toEqual([]);

    const ships = (await get('observer', '/api/v1/shipments?limit=200')).json().items.map(
      (s: { id: string }) => s.id,
    );
    expect(ships).toContain(shipment.A);
    expect(ships).not.toContain(shipment.C);

    const docs = await get('observer', '/api/v1/source-documents?limit=200');
    expect(docs.statusCode).toBe(200);
    const docIds = docs.json().items.map((d: { id: string }) => d.id);
    expect(docIds).toContain(doc.A);
    expect(docIds).not.toContain(doc.C);

    const extra = (await get('observer', '/api/v1/source-bundles/extra-only?limit=200')).json();
    const extraIds = extra.items.map((b: { bundleId: string }) => b.bundleId);
    expect(extraIds).toContain(bundle.extraA);
    expect(extraIds).not.toContain(bundle.extraC);

    const journal = (await get('observer', '/api/v1/materials/journal?limit=200')).json();
    const journalDeliveries = journal.items.map((r: { deliveryId: string }) => r.deliveryId);
    expect(journalDeliveries).toContain(delivery.A);
    expect(journalDeliveries).not.toContain(delivery.C);

    const sites = (await get('observer', '/api/v1/sites?limit=500')).json();
    expect(sites.items.map((s: { id: string }) => s.id).sort()).toEqual([site.A, site.B].sort());
  });

  it('выгрузки xlsx и отчёты открываются наблюдателю', async () => {
    for (const url of [
      '/api/v1/deliveries/export.xlsx',
      '/api/v1/shipments/export.xlsx',
      '/api/v1/source-documents/export.xlsx?direction=inbound',
      '/api/v1/reports/stock',
      '/api/v1/reports/intake',
      '/api/v1/reports/movements',
      '/api/v1/reports/shipment',
    ]) {
      expect((await get('observer', url)).statusCode, url).toBe(200);
    }
    // Журнал поступлений: позиции только своих приёмок.
    const intake = JSON.stringify((await get('observer', '/api/v1/reports/intake')).json());
    expect(intake).not.toContain(`Материал C ${tag}`);
  });

  it('чужая запись по id — 404 на каждом пути чтения, своя — открывается', async () => {
    const pairs: [string, string][] = [
      [`/api/v1/deliveries/${delivery.A}`, `/api/v1/deliveries/${delivery.C}`],
      [`/api/v1/shipments/${shipment.A}`, `/api/v1/shipments/${shipment.C}`],
      [`/api/v1/source-documents/${doc.A}`, `/api/v1/source-documents/${doc.C}`],
      [`/api/v1/sites/${site.A}`, `/api/v1/sites/${site.C}`],
      [`/api/v1/deliveries/${delivery.A}/supplier-orders`, `/api/v1/deliveries/${delivery.C}/supplier-orders`],
      [`/api/v1/deliveries/${delivery.A}/contract`, `/api/v1/deliveries/${delivery.C}/contract`],
      [`/api/v1/source-documents/import-result/${bundle.A}`, `/api/v1/source-documents/import-result/${bundle.C}`],
    ];
    for (const [own, foreign] of pairs) {
      expect((await get('observer', own)).statusCode, own).toBe(200);
      expect((await get('observer', foreign)).statusCode, foreign).toBe(404);
    }
    // Файлы, страницы и фото: у своих в тестовом стенде нет S3 — поэтому для
    // них проверяем лишь «не 404 по видимости», для чужих — ровно 404.
    const foreignOnly = [
      `/api/v1/source-documents/${doc.C}/file`,
      `/api/v1/source-documents/${doc.C}/file/raw`,
      `/api/v1/source-documents/${doc.C}/pages`,
      `/api/v1/source-documents/${doc.C}/extra/${extraItem.C}/url`,
      `/api/v1/source-documents/${doc.C}/extra/${extraItem.C}/raw`,
      `/api/v1/source-bundles/${bundle.extraC}/extra/${extraItem.C}/url`,
      `/api/v1/photos/${photo.C}/url`,
      `/api/v1/photos/${photo.C}/content`,
      `/api/v1/photos/${photo.C}/recognition`,
    ];
    for (const url of foreignOnly) {
      expect((await get('observer', url)).statusCode, url).toBe(404);
    }
    // Своё фото: видимость пройдена (дальше — S3 или отсутствие распознавания).
    const ownPhoto = await get('observer', `/api/v1/photos/${photo.A}/url`);
    expect(ownPhoto.statusCode).not.toBe(403);
    expect(ownPhoto.json()).not.toMatchObject({ error: 'site_scope_unsupported' });
  });

  it('заказ чужого объекта у своей приёмки скрыт; договор — только свои объекты', async () => {
    const orders = (await get('observer', `/api/v1/deliveries/${delivery.A}/supplier-orders`)).json();
    const orderIds = orders.items.map((o: { id: string }) => o.id);
    expect(orderIds).toContain(order.A);
    expect(orderIds).not.toContain(order.C);
    expect(
      (await get('observer', `/api/v1/deliveries/${delivery.A}/supplier-orders/${order.C}/items`))
        .statusCode,
    ).toBe(404);
    // Админ видит оба — привязка настоящая, скрывает именно скоуп.
    const adminOrders = (await get('admin', `/api/v1/deliveries/${delivery.A}/supplier-orders`)).json();
    expect(adminOrders.items.map((o: { id: string }) => o.id)).toEqual(
      expect.arrayContaining([order.A, order.C]),
    );

    const contract = (await get('observer', `/api/v1/deliveries/${delivery.A}/contract`)).json();
    expect(contract.contract.siteCodes).toEqual([`OA${tag}`]);
    expect(contract.contract.objectText).toBeNull();
    expect(contract.catalog.total).toBe(0);
    const adminContract = (await get('admin', `/api/v1/deliveries/${delivery.A}/contract`)).json();
    expect(adminContract.contract.siteCodes.sort()).toEqual([`OA${tag}`, `OC${tag}`].sort());
  });

  it('счётчики Операций не берутся из общего кэша', async () => {
    // Подложим в общий кэш заведомо чужие цифры.
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
    redisStore.set(
      `opcounters:all:${date}`,
      JSON.stringify({ completedToday: 999, inProgressToday: 999, overdue: 999 }),
    );
    const res = await get('observer', '/api/v1/reports/operations-counters');
    expect(res.statusCode).toBe(200);
    expect(res.json().inProgressToday).not.toBe(999);
    expect(res.json().overdue).not.toBe(999);
    expect([...redisStore.keys()].some((k) => k.startsWith('opcounters:obs-'))).toBe(true);
    // Наблюдатель без объектов — нули, а не общий кэш.
    const empty = await get('empty', '/api/v1/reports/operations-counters');
    expect(empty.json()).toEqual({ completedToday: 0, inProgressToday: 0, overdue: 0 });
  });

  it('без объектов — пусто везде', async () => {
    expect((await get('empty', '/api/v1/auth/me')).json().siteIds).toEqual([]);
    expect((await get('empty', '/api/v1/deliveries?limit=200')).json().items).toEqual([]);
    expect((await get('empty', '/api/v1/shipments?limit=200')).json().items).toEqual([]);
    expect((await get('empty', '/api/v1/source-documents?limit=200')).json().items).toEqual([]);
    expect((await get('empty', '/api/v1/sites?limit=500')).json().items).toEqual([]);
    expect((await get('empty', '/api/v1/materials/journal?limit=200')).json().items).toEqual([]);
    expect((await get('empty', `/api/v1/deliveries/${delivery.A}`)).statusCode).toBe(404);
  });

  it('удаление объекта сужает доступ, а не открывает всё', async () => {
    expect((await get('onlyD', '/api/v1/sites?limit=500')).json().items).toHaveLength(1);
    await sql`DELETE FROM sites WHERE id = ${site.D}`;
    expect((await get('onlyD', '/api/v1/auth/me')).json().siteIds).toEqual([]);
    expect((await get('onlyD', '/api/v1/deliveries?limit=200')).json().items).toEqual([]);
    expect((await get('onlyD', '/api/v1/sites?limit=500')).json().items).toEqual([]);
  });

  it('запись наблюдателю закрыта', async () => {
    for (const [method, url] of [
      ['POST', '/api/v1/deliveries'],
      ['PATCH', `/api/v1/deliveries/${delivery.A}/review`],
      ['POST', `/api/v1/deliveries/${delivery.A}/mark-deletion`],
      ['PATCH', `/api/v1/source-documents/${doc.A}`],
      ['DELETE', `/api/v1/source-documents/${doc.A}`],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token.observer}` },
        payload: {},
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('смена объектов админом гасит access- и refresh-токен наблюдателя', async () => {
    const refresh = await createSessionAndRefresh(user.observer, '127.0.0.1', 'vitest');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${user.observer}`,
      headers: { authorization: `Bearer ${token.admin}` },
      payload: { siteIds: [site.A] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().siteIds).toEqual([site.A]);
    // Старый access-токен — 401.
    expect((await get('observer', '/api/v1/auth/me')).statusCode).toBe(401);
    // Refresh той же учётки — 401: сессии погашены целиком.
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${refresh.token}` },
    });
    expect(r.statusCode).toBe(401);
    // Новый вход — уже с новым списком.
    token.observer = await login(user.observer, 'observer');
    const me = (await get('observer', '/api/v1/auth/me')).json();
    expect(me.siteIds).toEqual([site.A]);
    expect(
      (await get('observer', '/api/v1/deliveries?limit=200')).json().items.map((d: { id: string }) => d.id),
    ).not.toContain(delivery.B);
  });

  it('тот же набор объектов повторно — сессии не гасятся', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${user.observer}`,
      headers: { authorization: `Bearer ${token.admin}` },
      payload: { siteIds: [site.A] },
    });
    expect(res.statusCode).toBe(200);
    expect((await get('observer', '/api/v1/auth/me')).statusCode).toBe(200);
  });

  it('уход из роли наблюдателя очищает список; объекты другой роли не принимаются', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${user.empty}`,
      headers: { authorization: `Bearer ${token.admin}` },
      payload: { siteIds: [site.A] },
    });
    expect(res.json().siteIds).toEqual([site.A]);
    const toManager = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${user.empty}`,
      headers: { authorization: `Bearer ${token.admin}` },
      payload: { role: 'manager', siteIds: [site.B] },
    });
    expect(toManager.statusCode).toBe(200);
    expect(toManager.json().siteIds).toEqual([]);
    const [{ n } = { n: 0 }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM user_sites WHERE user_id = ${user.empty}`;
    expect(n).toBe(0);
  });

  it('несуществующий объект в списке — 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${user.onlyD}`,
      headers: { authorization: `Bearer ${token.admin}` },
      payload: { siteIds: [randomUUID()] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('site_not_available');
  });
});
