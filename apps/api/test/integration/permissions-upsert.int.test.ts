/**
 * Ветвление upsert: create или edit — на РЕАЛЬНОМ PostgreSQL.
 *
 * Самое хрупкое место всей фичи. POST /api/v1/deliveries — единственный
 * маршрут, дающий право «Создавать» на Операциях, и он же даёт «Редактировать».
 * Различить их по наличию `input.id` НЕЛЬЗЯ: офлайн-запись с планшета КПП
 * приходит с уже сгенерированным на клиенте UUID. Решает наличие строки в
 * БД — а это проверяется только против настоящей базы.
 *
 * Запуск:
 *   docker start matcheck-test-pg
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test \
 *     npx vitest run test/integration/permissions-upsert.int.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.PERMISSIONS_ENFORCE = '1';
  process.env.REDIS_URL = 'redis://127.0.0.1:6399';
});

import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { deliveryRoutes } from '../../src/routes/deliveries.js';
import { shipmentRoutes } from '../../src/routes/shipments.js';
import { registerErrorHandler } from '../../src/lib/error-handler.js';
import permissionsPlugin from '../../src/plugins/permissions.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('матрица прав: create и edit различаются наличием строки (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;

  const siteId = randomUUID();
  const managerId = randomUUID();
  // Отдельный пользователь-монитор: цель задачи — чтобы ЕМУ можно было выдать
  // создание приёмок, и проверять это надо на настоящей роли, а не подменой.
  const monitorId = randomUUID();
  const monitorSessionId = randomUUID();
  // Инспектор с ЧУЖИМ объектом и админ: на них держатся бизнес-правила
  // удаления, которые шаг 6 обязан был сохранить.
  const inspectorId = randomUUID();
  const inspectorSessionId = randomUUID();
  const foreignSiteId = randomUUID();
  const adminId = randomUUID();
  const adminSessionId = randomUUID();
  // Реальная строка в sessions: deliveries.created_by_session_id ссылается на
  // неё внешним ключом, и выдуманный UUID уронил бы INSERT.
  const sessionId = randomUUID();
  let filledStatusId: string;
  let draftDeliveryStatusId: string;
  let draftShipmentStatusId: string;

  const upsert = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/deliveries', payload: body });

  const payload = (id: string) => ({
    id,
    statusCode: 'filled',
    siteId,
    items: [],
    sourceDocumentIds: [],
  });

  const shipmentUpsert = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/shipments', payload: body });

  // writeoff — единственный вид, которому не нужен получатель: тест про права,
  // а не про validateKindLinks.
  const shipmentPayload = (id: string) => ({
    id,
    statusCode: 'draft',
    kind: 'writeoff',
    siteId,
    items: [],
    sourceDocumentIds: [],
  });

  /** Записать override и сбросить кеш, как это делает админский PATCH. */
  async function setPermissions(
    perms: {
      view?: boolean;
      create?: boolean;
      edit?: boolean;
      delete?: boolean;
      review?: boolean;
    },
    page: 'operations.deliveries' | 'operations.shipments' = 'operations.deliveries',
    role: 'manager' | 'monitor' = 'manager',
  ) {
    await sql`DELETE FROM role_page_permissions WHERE role = ${role} AND page_id = ${page}`;
    await sql`INSERT INTO role_page_permissions
        (role, page_id, can_view, can_create, can_edit, can_delete, can_review)
      VALUES (${role}, ${page},
        ${perms.view ?? true}, ${perms.create ?? true},
        ${perms.edit ?? true}, ${perms.delete ?? true}, ${perms.review ?? false})`;
    app.permissions.invalidateLocal();
  }

  async function seedDelivery(): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, version)
      VALUES (${id}, ${siteId}, ${managerId}, ${filledStatusId}, 1)`;
    return id;
  }

  /** Черновик: только его hard-delete удаляет без предварительной пометки. */
  async function seedDraftDelivery(): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, version)
      VALUES (${id}, ${siteId}, ${managerId}, ${draftDeliveryStatusId}, 1)`;
    return id;
  }

  async function seedShipment(): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO shipments (id, site_id, inspector_id, status_id, kind, version)
      VALUES (${id}, ${siteId}, ${managerId}, ${draftShipmentStatusId}, 'writeoff', 1)`;
    return id;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    // Полная схема: buildShipmentDto ходит в связанные таблицы, частичной ему мало.
    const db = drizzle(sql, { schema });

    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerErrorHandler(app);
    app.decorate('db', db as never);
    app.decorate('redis', { publish: async () => 0 } as never);
    app.decorate('logUnauthorized', async () => {});
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = currentUser;
    });
    app.decorate(
      'authorize',
      (...roles: AuthUser['role'][]) =>
        async (
          req: { user?: AuthUser; permissionExpanded?: boolean },
          reply: { code: (c: number) => { send: (b: unknown) => void } },
        ) => {
          // Как боевой authorize: выданное сверх дефолта право снимает
          // allow-list. Без этой ветки монитор не дошёл бы до обработчика, и
          // тест «выданное create создаёт приёмку» проверял бы не то.
          if (req.permissionExpanded) return;
          if (!req.user || !roles.includes(req.user.role)) {
            reply.code(403).send({ error: 'forbidden' });
          }
        },
    );
    // Как настоящий authPlugin: заполняет req.user до хуков плагина прав.
    app.addHook('onRequest', async (req) => {
      req.user = currentUser;
    });
    await app.register(permissionsPlugin);
    await app.register(deliveryRoutes);
    await app.register(shipmentRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'PRM'}, 'Permissions upsert')
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO users (id, email, password_hash, role) VALUES
      (${managerId}, ${`perm-mgr-${managerId}@test`}, 'x', 'manager') ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO sessions (id, user_id) VALUES (${sessionId}, ${managerId})
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO users (id, email, password_hash, role) VALUES
      (${monitorId}, ${`perm-mon-${monitorId}@test`}, 'x', 'monitor') ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO sessions (id, user_id) VALUES (${monitorSessionId}, ${monitorId})
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO sites (id, code, name) VALUES (${foreignSiteId}, ${'FRN'}, 'Чужой объект')
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id) VALUES
      (${inspectorId}, ${`perm-insp-${inspectorId}@test`}, 'x', 'inspector_kpp', ${foreignSiteId})
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO sessions (id, user_id) VALUES (${inspectorSessionId}, ${inspectorId})
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO users (id, email, password_hash, role) VALUES
      (${adminId}, ${`perm-adm-${adminId}@test`}, 'x', 'admin') ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO sessions (id, user_id) VALUES (${adminSessionId}, ${adminId})
      ON CONFLICT DO NOTHING`;

    const [f] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    filledStatusId = f!.id;

    const [d] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'shipment' AND code = 'draft' LIMIT 1`;
    draftShipmentStatusId = d!.id;

    const [dd] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'draft' LIMIT 1`;
    draftDeliveryStatusId = dd!.id;

    currentUser = {
      id: managerId,
      role: 'manager',
      siteId: null,
      contractorCustomerId: null,
      sessionId,
    };
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM shipments WHERE site_id = ${siteId}`;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM role_page_permissions WHERE role IN ('manager', 'monitor')`;
    await sql`DELETE FROM sessions WHERE id IN
      (${sessionId}, ${monitorSessionId}, ${inspectorSessionId}, ${adminSessionId})`;
    await sql`DELETE FROM users WHERE id IN
      (${managerId}, ${monitorId}, ${inspectorId}, ${adminId})`;
    await sql`DELETE FROM sites WHERE id IN (${siteId}, ${foreignSiteId})`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`DELETE FROM role_page_permissions WHERE role IN ('manager', 'monitor')`;
    // Каждый сценарий начинается от менеджера; тесты монитора переключают сами.
    currentUser = {
      id: managerId,
      role: 'manager',
      siteId: null,
      contractorCustomerId: null,
      sessionId,
    };
    app.permissions.invalidateLocal();
  });

  /** Инспектор, привязанный к ДРУГОМУ объекту, чем тестовые записи. */
  function asForeignInspector() {
    currentUser = {
      id: inspectorId,
      role: 'inspector_kpp',
      siteId: foreignSiteId,
      contractorCustomerId: null,
      sessionId: inspectorSessionId,
    };
  }

  function asAdmin() {
    currentUser = {
      id: adminId,
      role: 'admin',
      siteId: null,
      contractorCustomerId: null,
      sessionId: adminSessionId,
    };
  }

  /** Переключить запрос на роль «Мониторинг». */
  function asMonitor() {
    currentUser = {
      id: monitorId,
      role: 'monitor',
      siteId: null,
      contractorCustomerId: null,
      sessionId: monitorSessionId,
    };
  }

  it('create=false, edit=true: НОВАЯ запись → 403, СУЩЕСТВУЮЩАЯ → 200', async () => {
    await setPermissions({ create: false, edit: true });

    // Клиент присылает собственный UUID — ровно как офлайн-планшет.
    const freshId = randomUUID();
    const created = await upsert(payload(freshId));
    expect(created.statusCode).toBe(403);
    expect(created.json()).toMatchObject({ error: 'permission_denied' });
    expect(await sql`SELECT id FROM deliveries WHERE id = ${freshId}`).toHaveLength(0);

    const existingId = await seedDelivery();
    const edited = await upsert(payload(existingId));
    expect(edited.statusCode).toBe(200);
  });

  it('create=true, edit=false: НОВАЯ запись → 200, СУЩЕСТВУЮЩАЯ → 403', async () => {
    await setPermissions({ create: true, edit: false });

    const freshId = randomUUID();
    const created = await upsert(payload(freshId));
    expect(created.statusCode).toBe(200);
    expect(await sql`SELECT id FROM deliveries WHERE id = ${freshId}`).toHaveLength(1);

    const existingId = await seedDelivery();
    const edited = await upsert(payload(existingId));
    expect(edited.statusCode).toBe(403);
    // Запись не тронута: version остался прежним.
    const [row] = await sql<{ version: number }[]>`
      SELECT version FROM deliveries WHERE id = ${existingId}`;
    expect(row!.version).toBe(1);
  });

  it('POST без id при create=false тоже 403', async () => {
    await setPermissions({ create: false, edit: true });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/deliveries',
      payload: { statusCode: 'filled', siteId, items: [], sourceDocumentIds: [] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('отказ приходит как permission_denied с кодом 403, а не как 500', async () => {
    // Если бы PermissionError не наследовал HttpError, общий обработчик отдал
    // бы 500 — а на 5xx мобильный MutationProcessor делает Backoff вместо
    // Drop, и очередь мутаций на планшете встала бы намертво.
    await setPermissions({ create: false });
    const res = await upsert(payload(randomUUID()));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'permission_denied' });
  });

  it('без overrides (дефолт) upsert работает в обе стороны', async () => {
    const freshId = randomUUID();
    expect((await upsert(payload(freshId))).statusCode).toBe(200);
    expect((await upsert(payload(freshId))).statusCode).toBe(200);
  });

  // Отгрузки — вторая, симметричная реализация того же ветвления в другом
  // файле (routes/shipments.ts). Одинаковый код ещё не значит одинаковое
  // поведение: разойтись они могут при любой будущей правке одного из двух.
  it('shipments: create=false, edit=true → новая 403, существующая 200', async () => {
    await setPermissions({ create: false, edit: true }, 'operations.shipments');

    const freshId = randomUUID();
    const created = await shipmentUpsert(shipmentPayload(freshId));
    expect(created.statusCode).toBe(403);
    expect(created.json()).toMatchObject({ error: 'permission_denied' });
    expect(await sql`SELECT id FROM shipments WHERE id = ${freshId}`).toHaveLength(0);

    const existingId = await seedShipment();
    const edited = await shipmentUpsert(shipmentPayload(existingId));
    expect(edited.statusCode).toBe(200);
  });

  it('shipments: create=true, edit=false → новая 200, существующая 403', async () => {
    await setPermissions({ create: true, edit: false }, 'operations.shipments');

    const freshId = randomUUID();
    const created = await shipmentUpsert(shipmentPayload(freshId));
    expect(created.statusCode).toBe(200);
    expect(await sql`SELECT id FROM shipments WHERE id = ${freshId}`).toHaveLength(1);

    const existingId = await seedShipment();
    const edited = await shipmentUpsert(shipmentPayload(existingId));
    expect(edited.statusCode).toBe(403);
    const [row] = await sql<{ version: number }[]>`
      SELECT version FROM shipments WHERE id = ${existingId}`;
    expect(row!.version).toBe(1);
  });

  describe('ЦЕЛЬ ЗАДАЧИ: Мониторинг создаёт приёмку на настоящей БД', () => {
    // Здесь проверяется не цепочка прав (это делает permissions-monitor-e2e), а
    // факт: строка появляется в deliveries. Роль настоящая, роуты настоящие,
    // база настоящая — иначе «монитору можно выдать создание» остаётся словами.

    it('без выданных прав монитор не создаёт: гард отбивает до обработчика', async () => {
      asMonitor();
      const id = randomUUID();
      const res = await upsert(payload(id));
      expect(res.statusCode).toBe(403);
      expect(await sql`SELECT id FROM deliveries WHERE id = ${id}`).toHaveLength(0);
    });

    it('с выданным «Создавать» приёмка появляется в БД', async () => {
      await setPermissions(
        { view: true, create: true, edit: false, delete: false },
        'operations.deliveries',
        'monitor',
      );
      asMonitor();

      const id = randomUUID();
      const res = await upsert(payload(id));
      expect(res.statusCode).toBe(200);

      const rows = await sql<{ id: string; site_id: string }[]>`
        SELECT id, site_id FROM deliveries WHERE id = ${id}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.site_id).toBe(siteId);
    });

    it('но правка существующей записи закрыта: выдан только create', async () => {
      await setPermissions(
        { view: true, create: true, edit: false, delete: false },
        'operations.deliveries',
        'monitor',
      );
      const existingId = await seedDelivery();
      asMonitor();

      const res = await upsert(payload(existingId));
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'permission_denied' });
    });

    it('с выданным «Редактировать» правка проходит, а создание — нет', async () => {
      await setPermissions(
        { view: true, create: false, edit: true, delete: false },
        'operations.deliveries',
        'monitor',
      );
      const existingId = await seedDelivery();
      asMonitor();

      expect((await upsert(payload(existingId))).statusCode).toBe(200);

      const freshId = randomUUID();
      expect((await upsert(payload(freshId))).statusCode).toBe(403);
      expect(await sql`SELECT id FROM deliveries WHERE id = ${freshId}`).toHaveLength(0);
    });

    it('права на Приёмки не открывают Отгрузки', async () => {
      await setPermissions(
        { view: true, create: true, edit: false, delete: false },
        'operations.deliveries',
        'monitor',
      );
      asMonitor();

      const id = randomUUID();
      const res = await shipmentUpsert(shipmentPayload(id));
      expect(res.statusCode).toBe(403);
      expect(await sql`SELECT id FROM shipments WHERE id = ${id}`).toHaveLength(0);
    });
  });

  describe('удаление: матрица решает доступ, бизнес-правила остались', () => {
    // Шаг 6 заменил в этих маршрутах проверку имени роли на assertPermission.
    // Правила, которые обязаны были уцелеть, проверяются здесь — иначе их
    // потеря прошла бы молча: тесты на них до сих пор не писались.

    const markDeletion = (id: string) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/deliveries/${id}/mark-deletion`,
        payload: { reason: 'тест' },
      });
    const unmarkDeletion = (id: string) =>
      app.inject({ method: 'POST', url: `/api/v1/deliveries/${id}/unmark-deletion`, payload: {} });
    const hardDelete = (id: string) =>
      app.inject({ method: 'DELETE', url: `/api/v1/deliveries/${id}` });

    it('монитор с выданным «Удалять» помечает приёмку и снимает СВОЮ пометку', async () => {
      await setPermissions(
        { view: true, create: false, edit: false, delete: true },
        'operations.deliveries',
        'monitor',
      );
      const id = await seedDelivery();
      asMonitor();

      expect((await markDeletion(id)).statusCode).toBe(200);
      const [marked] = await sql<{ pending_deletion_by_user_id: string | null }[]>`
        SELECT pending_deletion_by_user_id FROM deliveries WHERE id = ${id}`;
      expect(marked!.pending_deletion_by_user_id).toBe(monitorId);

      expect((await unmarkDeletion(id)).statusCode).toBe(200);
      const [restored] = await sql<{ pending_deletion_at: Date | null }[]>`
        SELECT pending_deletion_at FROM deliveries WHERE id = ${id}`;
      expect(restored!.pending_deletion_at).toBeNull();
    });

    it('чужую пометку монитор снять не может — это правило автора, не право', async () => {
      await setPermissions(
        { view: true, create: false, edit: false, delete: true },
        'operations.deliveries',
        'monitor',
      );
      const id = await seedDelivery();
      // Пометил менеджер.
      expect((await markDeletion(id)).statusCode).toBe(200);

      asMonitor();
      const res = await unmarkDeletion(id);
      expect(res.statusCode).toBe(403);
      // Пометка на месте.
      const [row] = await sql<{ pending_deletion_at: Date | null }[]>`
        SELECT pending_deletion_at FROM deliveries WHERE id = ${id}`;
      expect(row!.pending_deletion_at).not.toBeNull();
    });

    it('добить помеченную запись может только admin, даже с правом «Удалять»', async () => {
      await setPermissions(
        { view: true, create: false, edit: false, delete: true },
        'operations.deliveries',
        'monitor',
      );
      const id = await seedDelivery();
      asMonitor();
      expect((await markDeletion(id)).statusCode).toBe(200);

      // Право есть, но запись помечена — окончательное удаление за админом.
      const res = await hardDelete(id);
      expect(res.statusCode).toBe(403);
      expect(await sql`SELECT id FROM deliveries WHERE id = ${id}`).toHaveLength(1);
    });

    it('снятое «Удалять» закрывает и пометку', async () => {
      await setPermissions(
        { view: true, create: false, edit: false, delete: false },
        'operations.deliveries',
        'monitor',
      );
      const id = await seedDelivery();
      asMonitor();
      expect((await markDeletion(id)).statusCode).toBe(403);
    });
  });

  describe('инспектор на чужом объекте и окончательное удаление', () => {
    const markDeletion = (id: string) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/deliveries/${id}/mark-deletion`,
        payload: { reason: 'тест' },
      });
    const unmarkDeletion = (id: string) =>
      app.inject({ method: 'POST', url: `/api/v1/deliveries/${id}/unmark-deletion`, payload: {} });
    const hardDelete = (id: string) =>
      app.inject({ method: 'DELETE', url: `/api/v1/deliveries/${id}` });

    it('пометка чужой записи маскируется под 404', () => {
      // Здесь скоуп проверяется ДО прав, и код ответа не выдаёт существование
      // записи. Это тот случай, где маскировка работает.
      return (async () => {
        const id = await seedDelivery();
        asForeignInspector();
        const res = await markDeletion(id);
        expect(res.statusCode).toBe(404);
      })();
    });

    it('ЗАФИКСИРОВАНО КАК ЕСТЬ: hard-delete чужой записи отвечает 403, а не 404', async () => {
      // Ожидание описывает ФАКТИЧЕСКОЕ поведение, а не желаемое. Ранее в плане
      // было записано «инспектор получает 404 на чужом объекте» — это описание
      // не соответствовало коду ни до шага 6, ни после.
      //
      // Приведение к 404 сюда НЕ входит: DELETE и unmark-deletion в мобильном
      // периметре, планшет 403 не показывает вовсе, а 404 умеет понимать как
      // «записи больше нет» — смена кода способна спровоцировать удаление на
      // устройстве. Это отдельная задача с проверкой Android-клиента.
      // Именно черновик: у оформленной записи раньше срабатывает
      // must_mark_first (409), и до проверки объекта дело не доходит.
      const id = await seedDraftDelivery();
      asForeignInspector();
      const res = await hardDelete(id);
      expect(res.statusCode).toBe(403);
      expect(await sql`SELECT id FROM deliveries WHERE id = ${id}`).toHaveLength(1);
    });

    it('ЗАФИКСИРОВАНО КАК ЕСТЬ: снятие чужой пометки отвечает 403 раньше проверки объекта', async () => {
      // Порядок проверок в unmark-deletion: сначала «автор или админ», затем
      // siteId. Поэтому инспектор-неавтор получает 403 и по коду ответа узнаёт,
      // что запись существует. Так было и до шага 6; менять порядок — та же
      // отдельная задача про мобильный контракт.
      const id = await seedDelivery();
      expect((await markDeletion(id)).statusCode).toBe(200); // пометил менеджер
      asForeignInspector();
      expect((await unmarkDeletion(id)).statusCode).toBe(403);
    });

    it('admin добивает помеченную запись — успешный путь, а не только отказ', async () => {
      const id = await seedDelivery();
      expect((await markDeletion(id)).statusCode).toBe(200);

      asAdmin();
      const res = await hardDelete(id);
      expect(res.statusCode).toBe(200);
      expect(await sql`SELECT id FROM deliveries WHERE id = ${id}`).toHaveLength(0);
    });
  });
});
