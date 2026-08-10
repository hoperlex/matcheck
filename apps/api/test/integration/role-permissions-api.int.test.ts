/**
 * API матрицы прав на реальном PostgreSQL.
 *
 * Почему интеграционные, а не моки: проверяемое здесь держится на SQL —
 * ON CONFLICT, который не должен затирать соседние колонки; транзакция,
 * которая обязана откатить всё при отказе в середине; DELETE-сброс.
 * На моках проверялась бы выдумка.
 *
 * Запуск (та же тестовая база, что у прочих int-наборов; нужна миграция 0092):
 *   docker start matcheck-test-pg
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test \
 *     npx vitest run test/integration/role-permissions-api.int.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  // Матрица должна применяться — иначе GET отдавал бы дефолты и половина
  // проверок стала бы бессмысленной.
  process.env.PERMISSIONS_ENFORCE = '1';
  process.env.REDIS_URL = 'redis://127.0.0.1:6399';
});

import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { DEFAULT_MATRIX } from '@matcheck/contracts';
import { rolePermissionRoutes } from '../../src/routes/admin/role-permissions.js';
import { authEvents, rolePagePermissions, users } from '../../src/db/schema.js';
import { registerErrorHandler } from '../../src/lib/error-handler.js';
import permissionsPlugin from '../../src/plugins/permissions.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('матрица прав: админское API (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  const adminId = randomUUID();

  const patch = (changes: unknown[]) =>
    app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/role-permissions',
      payload: { changes },
    });

  const rowOf = async (role: string, pageId: string) => {
    const [row] = await sql<
      { can_view: boolean; can_create: boolean; can_edit: boolean; can_delete: boolean }[]
    >`SELECT can_view, can_create, can_edit, can_delete
        FROM role_page_permissions WHERE role = ${role} AND page_id = ${pageId}`;
    return row;
  };

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    const db = drizzle(sql, { schema: { rolePagePermissions, authEvents, users } });

    await db.insert(users).values({
      id: adminId,
      email: `perm-admin-${adminId}@example.com`,
      passwordHash: 'x',
      role: 'admin',
      isActive: true,
    });

    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerErrorHandler(app);
    app.decorate('db', db as never);
    app.decorate('redis', { publish: async () => 0 } as never);
    app.decorate('logUnauthorized', async () => {});
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = {
        id: adminId,
        role: 'admin',
        siteId: null,
        contractorCustomerId: null,
        sessionId: 'sess',
      };
    });
    app.decorate(
      'authorize',
      () => async () => {
        /* админ уже подставлен в authenticate */
      },
    );
    await app.register(permissionsPlugin);
    await app.register(rolePermissionRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await sql`DELETE FROM role_page_permissions`;
    await sql`DELETE FROM auth_events WHERE user_id = ${adminId}`;
    await sql`DELETE FROM users WHERE id = ${adminId}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`DELETE FROM role_page_permissions`;
    await sql`DELETE FROM auth_events WHERE user_id = ${adminId}`;
    app.permissions.invalidateLocal();
  });

  it('GET при пустой таблице отдаёт ровно дефолтную матрицу', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/role-permissions' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      matrix: Record<string, Record<string, Record<string, boolean>>>;
      catalog: unknown[];
      lockedCells: string[];
    };
    expect(body.catalog).toHaveLength(23);
    expect(body.lockedCells).toHaveLength(8);
    expect(body.matrix.manager!['references.sites']).toEqual(
      DEFAULT_MATRIX.manager['references.sites'],
    );
    expect(body.matrix.contractor!['operations.deliveries']).toEqual(
      DEFAULT_MATRIX.contractor['operations.deliveries'],
    );
  });

  it('PATCH одной ячейки НЕ обнуляет соседние (строка создаётся из дефолта)', async () => {
    // Самый вероятный баг реализации: INSERT со значениями по умолчанию false
    // вместо дефолтных прав роли.
    const res = await patch([
      { role: 'manager', page: 'references.sites', action: 'edit', allowed: false },
    ]);
    expect(res.statusCode).toBe(200);

    const row = await rowOf('manager', 'references.sites');
    expect(row).toMatchObject({ can_edit: false });
    // view и create у менеджера были true — они обязаны остаться.
    expect(row).toMatchObject({ can_view: true, can_create: true });
  });

  it('два последовательных PATCH разных действий одной строки сохраняют оба', async () => {
    await patch([{ role: 'manager', page: 'references.sites', action: 'create', allowed: false }]);
    await patch([{ role: 'manager', page: 'references.sites', action: 'edit', allowed: false }]);

    const row = await rowOf('manager', 'references.sites');
    // Регресс на ON CONFLICT: обновляя все четыре колонки, второй запрос
    // вернул бы create в true и молча отменил первую правку.
    expect(row).toMatchObject({ can_create: false, can_edit: false, can_view: true });
  });

  it('параллельные PATCH разных действий одной строки не затирают друг друга', async () => {
    const [a, b] = await Promise.all([
      patch([{ role: 'manager', page: 'references.suppliers', action: 'create', allowed: false }]),
      patch([{ role: 'manager', page: 'references.suppliers', action: 'edit', allowed: false }]),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);

    const row = await rowOf('manager', 'references.suppliers');
    expect(row).toMatchObject({ can_create: false, can_edit: false });
  });

  it('снятие «Просмотра» каскадом гасит остальные действия и пишет аудит', async () => {
    const res = await patch([
      { role: 'manager', page: 'references.units', action: 'view', allowed: false },
    ]);
    expect(res.statusCode).toBe(200);

    const row = await rowOf('manager', 'references.units');
    expect(row).toMatchObject({
      can_view: false,
      can_create: false,
      can_edit: false,
    });

    const events = await sql<{ meta: Record<string, unknown> }[]>`
      SELECT meta FROM auth_events
       WHERE user_id = ${adminId} AND event = 'role_permission_changed'`;
    // Явное изменение + два производных (create, edit); delete у справочников
    // и так был false.
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.map((e) => e.meta.action).sort()).toEqual(['create', 'edit', 'view']);
  });

  it('действие без «Просмотра» отклоняется целиком: 400 view_required', async () => {
    const res = await patch([
      { role: 'manager', page: 'references.units', action: 'view', allowed: false },
      { role: 'manager', page: 'references.units', action: 'edit', allowed: true },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'view_required' });
    // Транзакция обязана откатиться целиком.
    expect(await rowOf('manager', 'references.units')).toBeUndefined();
  });

  it('view_required срабатывает и МЕЖДУ запросами, по состоянию в БД', async () => {
    // Просмотр уже снят предыдущим запросом (строка в БД: view=false), и
    // отдельным PATCH приходит edit=true. Итог тот же, что и внутри одной
    // дельты, — 400, — но опирается на чтение фактического состояния строки.
    // Считай сервер каскад по дефолтам или по устаревшему кешу, запрос прошёл
    // бы и оставил в БД невозможное «редактировать без просмотра».
    await patch([{ role: 'manager', page: 'references.units', action: 'view', allowed: false }]);

    const res = await patch([
      { role: 'manager', page: 'references.units', action: 'edit', allowed: true },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'view_required' });

    const row = await rowOf('manager', 'references.units');
    expect(row).toMatchObject({ can_view: false, can_edit: false });
  });

  it('дубль координаты в дельте отклоняется', async () => {
    const res = await patch([
      { role: 'manager', page: 'references.units', action: 'edit', allowed: false },
      { role: 'manager', page: 'references.units', action: 'edit', allowed: true },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'duplicate_change' });
  });

  it('неприменимое действие отклоняется даже при allowed: false', async () => {
    // У «Статистики» есть только просмотр — строка про удаление означала бы,
    // что у страницы вообще есть такое измерение.
    const res = await patch([
      { role: 'manager', page: 'stats', action: 'delete', allowed: false },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'action_not_applicable' });
  });

  it('заблокированную ячейку мобильного клиента изменить нельзя', async () => {
    const res = await patch([
      { role: 'inspector_kpp', page: 'operations.deliveries', action: 'create', allowed: false },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'locked_cell' });
  });

  it('выдать право, которого нет в коде, нельзя', async () => {
    // У менеджера нет удаления в справочниках (canDelete = только admin).
    const res = await patch([
      { role: 'manager', page: 'references.sites', action: 'delete', allowed: true },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'cannot_grant' });
  });

  it('роль admin в матрицу не принимается', async () => {
    const res = await patch([
      { role: 'admin', page: 'references.sites', action: 'edit', allowed: false },
    ]);
    // Схема ManagedRoleSchema отсекает admin ещё на валидации тела.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await rowOf('admin', 'references.sites')).toBeUndefined();
  });

  it('частичный отказ не оставляет записанных изменений', async () => {
    // Первая ячейка корректна, вторая заблокирована: не должно примениться
    // НИЧЕГО, включая аудит.
    const res = await patch([
      { role: 'manager', page: 'references.sites', action: 'edit', allowed: false },
      { role: 'inspector_kpp', page: 'operations.shipments', action: 'view', allowed: false },
    ]);
    expect(res.statusCode).toBe(400);
    expect(await rowOf('manager', 'references.sites')).toBeUndefined();

    const [{ count }] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM auth_events WHERE user_id = ${adminId}`;
    expect(count).toBe('0');
  });

  it('DELETE сбрасывает роль к дефолту и пишет прежние значения в аудит', async () => {
    await patch([
      { role: 'manager', page: 'references.sites', action: 'edit', allowed: false },
      { role: 'manager', page: 'references.suppliers', action: 'create', allowed: false },
    ]);
    expect(await rowOf('manager', 'references.sites')).toBeDefined();

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/role-permissions/manager',
    });
    expect(res.statusCode).toBe(200);

    // Тело ответа — уже пересчитанная матрица: вкладка «Роли» перерисовывается
    // по нему, без второго запроса. Отдай сюда состояние «до сброса» — админ
    // увидел бы снятые галочки и решил, что кнопка не сработала.
    const afterReset = res.json() as {
      matrix: Record<string, Record<string, Record<string, boolean>>>;
    };
    expect(afterReset.matrix.manager!['references.sites']).toEqual(
      DEFAULT_MATRIX.manager['references.sites'],
    );
    expect(afterReset.matrix.manager!['references.suppliers']).toEqual(
      DEFAULT_MATRIX.manager['references.suppliers'],
    );

    // Сброс — это УДАЛЕНИЕ строк, а не запись сегодняшних значений: иначе
    // дефолт застыл бы слепком и перестал следовать за кодом.
    expect(await rowOf('manager', 'references.sites')).toBeUndefined();
    expect(await rowOf('manager', 'references.suppliers')).toBeUndefined();

    const resets = await sql<{ meta: Record<string, unknown> }[]>`
      SELECT meta FROM auth_events
       WHERE user_id = ${adminId} AND event = 'role_permission_reset'`;
    expect(resets).toHaveLength(2);
    const sites = resets.find((r) => r.meta.page === 'references.sites');
    expect((sites!.meta.previous as Record<string, boolean>).edit).toBe(false);
  });

  it('сброс роли не трогает overrides другой роли', async () => {
    await patch([
      { role: 'manager', page: 'references.sites', action: 'edit', allowed: false },
      { role: 'monitor', page: 'operations.deliveries', action: 'edit', allowed: false },
    ]);
    await app.inject({ method: 'DELETE', url: '/api/v1/admin/role-permissions/manager' });

    expect(await rowOf('manager', 'references.sites')).toBeUndefined();
    expect(await rowOf('monitor', 'operations.deliveries')).toBeDefined();
  });

  it('сохранённое сужение видно в ответе GET', async () => {
    await patch([
      { role: 'manager', page: 'references.sites', action: 'edit', allowed: false },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/role-permissions' });
    const body = res.json() as { matrix: Record<string, Record<string, Record<string, boolean>>> };
    expect(body.matrix.manager!['references.sites']).toMatchObject({
      view: true,
      create: true,
      edit: false,
    });
  });

  it('при выключенном enforcement GET отдаёт СОХРАНЁННУЮ матрицу, а не дефолты', async () => {
    // Второй инстанс тех же роутов, но с enforced: false — второй раз поднять
    // сам плагин нельзя, флаг читается из env один раз на процесс.
    //
    // Отдай админский GET дефолты (как /me/permissions, где это правильно) —
    // правка в UI «отскакивала» бы: PATCH записал, а ответ и следующий GET
    // показывают прежнюю галочку. И сценарий «настроить матрицу заранее →
    // включить флаг» стал бы невыполнимым.
    await patch([{ role: 'manager', page: 'references.sites', action: 'edit', allowed: false }]);

    const off = Fastify({ logger: false });
    off.setValidatorCompiler(validatorCompiler);
    off.setSerializerCompiler(serializerCompiler);
    registerErrorHandler(off);
    off.decorate('db', app.db as never);
    off.decorate('permissions', {
      enforced: false,
      get: async () => new Map(),
      invalidateLocal: () => {},
      invalidateEverywhere: async () => {},
    } as never);
    off.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = {
        id: adminId,
        role: 'admin',
        siteId: null,
        contractorCustomerId: null,
        sessionId: 'sess',
      };
    });
    off.decorate('authorize', () => async () => {});
    await off.register(rolePermissionRoutes);
    await off.ready();

    try {
      const res = await off.inject({ method: 'GET', url: '/api/v1/admin/role-permissions' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        enforced: boolean;
        matrix: Record<string, Record<string, Record<string, boolean>>>;
      };
      // Матрица — из БД…
      expect(body.matrix.manager!['references.sites']).toMatchObject({ view: true, edit: false });
      // …а то, что она не применяется, клиент узнаёт из этого флага и рисует баннер.
      expect(body.enforced).toBe(false);
    } finally {
      await off.close();
    }
  });

  it('CHECK в БД не даёт создать строку для admin даже в обход API', async () => {
    await expect(
      sql`INSERT INTO role_page_permissions(role, page_id) VALUES ('admin', 'admin.roles')`,
    ).rejects.toThrow(/role_page_permissions_no_admin/);
  });

  it('drizzle-схема согласована с БД: чтение и запись через ORM работают', async () => {
    const db = drizzle(sql, { schema: { rolePagePermissions } });
    await db
      .insert(rolePagePermissions)
      .values({ role: 'monitor', pageId: 'operations.shipments', canView: false });
    const rows = await db
      .select()
      .from(rolePagePermissions)
      .where(eq(rolePagePermissions.role, 'monitor'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pageId: 'operations.shipments', canView: false });
  });
});
