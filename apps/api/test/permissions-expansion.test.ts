/**
 * РАСШИРЕНИЕ прав матрицей — и границы, за которые оно не выходит.
 *
 * Главный риск фичи не в том, что расширение не сработает, а в том, что оно
 * сработает шире, чем задумано. Одна ячейка матрицы охраняет несколько
 * маршрутов с разными allow-list'ами: `operations.*:edit` есть у monitor ради
 * отметки проверки, но той же ячейкой помечены manager-only flags/link-source;
 * ячейкой `operations.*:delete` — admin-only bulk-hard-delete. Поэтому обход
 * allow-list разрешён ТОЛЬКО по явно выданному праву (дефолт запрещал, админ
 * выдал), и первый же тест здесь проверяет именно это.
 *
 * Второй слой — резолвер: запреты обязаны держаться на нём, а не на валидации
 * PATCH, потому что строку в role_page_permissions можно записать руками.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserRole } from '@matcheck/contracts';

type OverrideRow = {
  role: string;
  pageId: string;
  canView: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
};

const ORIGINAL_ENV = { ...process.env };
let app: FastifyInstance | undefined;

/** Строка overrides: по умолчанию всё как в дефолте, точечно переопределяем. */
const row = (
  role: string,
  pageId: string,
  patch: Partial<Omit<OverrideRow, 'role' | 'pageId'>>,
): OverrideRow => ({
  role,
  pageId,
  canView: patch.canView ?? false,
  canCreate: patch.canCreate ?? false,
  canEdit: patch.canEdit ?? false,
  canDelete: patch.canDelete ?? false,
});

/**
 * Приложение с настоящими плагинами прав и авторизации: `authorize` берём
 * реальный, иначе тест не проверял бы главное — обходит его отметка или нет.
 */
async function buildApp(opts: {
  role: UserRole;
  overrides?: OverrideRow[];
  enforce?: '0' | '1';
}): Promise<FastifyInstance> {
  process.env.PERMISSIONS_ENFORCE = opts.enforce ?? '1';
  process.env.REDIS_URL = 'redis://127.0.0.1:6399';
  vi.resetModules();
  const { default: permissionsPlugin } = await import('../src/plugins/permissions.js');
  const { meRoutes } = await import('../src/routes/me.js');

  const instance = Fastify({ logger: false });
  instance.setValidatorCompiler(validatorCompiler);
  instance.setSerializerCompiler(serializerCompiler);
  instance.decorate('db', {
    select: () => ({ from: () => Promise.resolve(opts.overrides ?? []) }),
  } as never);
  instance.decorate('redis', { publish: async () => 0 } as never);
  instance.decorate('logUnauthorized', (async () => {}) as never);
  instance.decorate('authenticate', (async () => {}) as never);

  // Копия боевого authorize (plugins/auth.ts): отметка расширения снимает
  // проверку роли, всё остальное — как было.
  instance.decorate('authorize', (...roles: UserRole[]) => {
    return async (req: { user?: { role: UserRole }; permissionExpanded?: boolean }, reply: {
      code: (c: number) => { send: (b: unknown) => void };
    }) => {
      if (req.permissionExpanded) return;
      if (!req.user || !roles.includes(req.user.role)) {
        reply.code(403).send({ error: 'forbidden', message: 'Insufficient role' });
      }
    };
  });

  instance.addHook('onRequest', async (req) => {
    req.user = {
      id: '11111111-1111-1111-1111-111111111111',
      role: opts.role,
      siteId: null,
      contractorCustomerId: null,
      sessionId: 'sess',
    };
  });

  await instance.register(permissionsPlugin);
  await instance.register(meRoutes);

  const authorize = (...roles: UserRole[]) =>
    (instance as unknown as { authorize: (...r: UserRole[]) => unknown }).authorize(...roles);

  // Маршруты с ТЕМ ЖЕ allow-list, что в бою (см. соответствующие routes/*.ts).
  instance.get(
    '/api/v1/admin/llm-providers',
    { preHandler: [authorize('admin')] as never },
    async () => ({ ok: 'llm' }),
  );
  instance.delete(
    '/api/v1/sites/:id',
    { preHandler: [authorize('admin')] as never },
    async () => ({ ok: 'deleted' }),
  );
  // Та же ячейка operations.deliveries:edit, что у review, но роут manager-only.
  instance.patch(
    '/api/v1/deliveries/:id/flags',
    { preHandler: [authorize('admin', 'manager')] as never },
    async () => ({ ok: 'flags' }),
  );
  // Ячейка operations.deliveries:delete, роут admin-only.
  instance.post(
    '/api/v1/deliveries/bulk-hard-delete',
    { preHandler: [authorize('admin')] as never },
    async () => ({ ok: 'hard-deleted' }),
  );
  // legacy: GET /admin/settings доступен manager исторически.
  instance.get(
    '/api/v1/admin/settings',
    { preHandler: [authorize('admin', 'manager')] as never },
    async () => ({ ok: 'settings' }),
  );

  await instance.ready();
  return instance;
}

const perms = async (instance: FastifyInstance) =>
  (await instance.inject({ method: 'GET', url: '/api/v1/me/permissions' })).json() as {
    pages: Record<string, Record<string, boolean>>;
  };

beforeEach(() => {
  app = undefined;
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  process.env = { ...ORIGINAL_ENV };
});

describe('отметка расширения не ставится на дефолтных правах', () => {
  it('monitor НЕ получает manager-only маршрут своей же ячейки operations:edit', async () => {
    // У monitor operations.deliveries:edit = true по дефолту — ради отметки
    // проверки. Если бы отметка ставилась на любом разрешении матрицы, он
    // получил бы заодно flags/link-source, которых у него никогда не было.
    app = await buildApp({ role: 'monitor' });
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/deliveries/x/flags' });
    expect(res.statusCode).toBe(403);
  });

  it('manager НЕ получает admin-only bulk-hard-delete своей же ячейки operations:delete', async () => {
    app = await buildApp({ role: 'manager' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/deliveries/bulk-hard-delete',
      payload: { ids: [] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('при пустой таблице overrides ни один allow-list не обходится', async () => {
    for (const role of ['manager', 'inspector_kpp', 'contractor', 'monitor'] as UserRole[]) {
      const instance = await buildApp({ role });
      try {
        const res = await instance.inject({ method: 'GET', url: '/api/v1/admin/llm-providers' });
        expect(res.statusCode, `роль ${role}`).toBe(403);
      } finally {
        await instance.close();
      }
    }
  });
});

describe('явное расширение открывает маршрут', () => {
  it('view: inspector_kpp с выданным admin.llm_providers:view проходит admin-only роут', async () => {
    app = await buildApp({
      role: 'inspector_kpp',
      overrides: [row('inspector_kpp', 'admin.llm_providers', { canView: true })],
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/llm-providers' });
    expect(res.statusCode).toBe(200);
  });

  it('write: manager с выданным references.sites:delete проходит admin-only удаление', async () => {
    // Мутация, а не чтение: отметка обязана работать и на write-пути.
    app = await buildApp({
      role: 'manager',
      overrides: [
        row('manager', 'references.sites', {
          canView: true,
          canCreate: true,
          canEdit: true,
          canDelete: true,
        }),
      ],
    });
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/sites/abc' });
    expect(res.statusCode).toBe(200);
  });
});

describe('резолвер держит запреты сам, без помощи PATCH', () => {
  it('write-расширение для contractor игнорируется даже при строке в БД', async () => {
    app = await buildApp({
      role: 'contractor',
      overrides: [row('contractor', 'references.sites', { canView: true, canCreate: true })],
    });
    const body = await perms(app);
    expect(body.pages['references.sites']).toMatchObject({ view: true, create: false });
  });

  it('inspector_kpp тоже не получает write-расширения', async () => {
    app = await buildApp({
      role: 'inspector_kpp',
      overrides: [row('inspector_kpp', 'documents.list', { canView: true, canEdit: true })],
    });
    const body = await perms(app);
    expect(body.pages['documents.list']).toMatchObject({ view: true, edit: false });
  });

  it('admin.users:edit не выдаётся никому, admin.roles тоже', async () => {
    app = await buildApp({
      role: 'manager',
      overrides: [
        row('manager', 'admin.users', { canView: true, canEdit: true, canDelete: true }),
        row('manager', 'admin.roles', { canView: true, canEdit: true }),
      ],
    });
    const body = await perms(app);
    // Просмотр списка выдать можно, правку и удаление — нет.
    expect(body.pages['admin.users']).toMatchObject({ view: true, edit: false, delete: false });
    expect(body.pages['admin.roles']).toMatchObject({ view: false, edit: false });
  });

  it('запрет write-расширения НЕ отнимает базовое право', async () => {
    // У monitor operations.*:review базовый (отметка проверки). Правило про
    // write-расширение касается только того, чего в дефолте не было.
    app = await buildApp({ role: 'monitor' });
    const body = await perms(app);
    expect(body.pages['operations.deliveries']).toMatchObject({ view: true, review: true });
  });

  it('отметка проверки отделена от правки: у monitor есть review, но не edit', async () => {
    // Ради этого действие и разводилось. Пока отметка сидела внутри edit,
    // право монитора было БАЗОВЫМ — то есть никогда не считалось расширением и
    // не обходило authorize('admin','manager') на flags/link-source/share-link.
    // Галочка «Редактировать» стояла, означала одну лишь отметку, а выдать
    // настоящую правку было нечем: включать уже нечего.
    app = await buildApp({ role: 'monitor' });
    const body = await perms(app);
    expect(body.pages['operations.deliveries']).toMatchObject({ review: true, edit: false });
    expect(body.pages['operations.shipments']).toMatchObject({ review: true, edit: false });
  });

  it('ЦЕЛЬ: выданный монитору edit действует, и отметка проверки не страдает', async () => {
    // Ради этой строчки затевалась работа. До разделения review и edit
    // сценарий был невыразим: право монитора совпадало с дефолтом, расширением
    // не считалось никогда, и authorize отказывал всегда.
    app = await buildApp({
      role: 'monitor',
      overrides: [row('monitor', 'operations.deliveries', { canView: true, canEdit: true })],
    });
    const body = await perms(app);
    expect(body.pages['operations.deliveries']).toMatchObject({ view: true, edit: true });
    // Отметка проверки — базовое право, выдача соседнего его не трогает.
    expect(body.pages['operations.deliveries'].review).toBe(true);
  });

  it('подрядчику выданная запись игнорируется резолвером, а не только PATCH', async () => {
    // Строку можно записать прямым UPDATE в psql — запрет обязан держаться на
    // резолвере. У подрядчика нет сверки принадлежности на путях записи.
    app = await buildApp({
      role: 'contractor',
      overrides: [row('contractor', 'references.sites', { canView: true, canCreate: true })],
    });
    const body = await perms(app);
    expect(body.pages['references.sites']).toMatchObject({ view: true, create: false });
  });
});

describe('legacy-маршруты', () => {
  it('manager ходит на /admin/settings без override — как и раньше', async () => {
    app = await buildApp({ role: 'manager' });
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/settings' })).statusCode).toBe(
      200,
    );
  });

  it('отрицательный override не отбирает legacy-доступ у manager', async () => {
    // Маршрут для legacy-ролей выведен из-под матрицы целиком: сужение по нему
    // — отдельное согласование, а не побочный эффект снятой галочки.
    app = await buildApp({
      role: 'manager',
      overrides: [row('manager', 'admin.settings', {})],
    });
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/settings' })).statusCode).toBe(
      200,
    );
  });

  it('inspector_kpp без override получает 403', async () => {
    app = await buildApp({ role: 'inspector_kpp' });
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/settings' })).statusCode).toBe(
      403,
    );
  });

  it('inspector_kpp с выданным admin.settings:view получает 200', async () => {
    app = await buildApp({
      role: 'inspector_kpp',
      overrides: [row('inspector_kpp', 'admin.settings', { canView: true })],
    });
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/settings' })).statusCode).toBe(
      200,
    );
  });
});

describe('PERMISSIONS_ENFORCE=0 — полный откат и для расширений', () => {
  it('положительный override не влияет ни на API, ни на /me/permissions', async () => {
    app = await buildApp({
      role: 'inspector_kpp',
      enforce: '0',
      overrides: [row('inspector_kpp', 'admin.llm_providers', { canView: true })],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/llm-providers' });
    expect(res.statusCode, 'выключенный флаг обязан оставлять маршрут закрытым').toBe(403);

    const body = await perms(app);
    expect(body.pages['admin.llm_providers']).toMatchObject({ view: false });
  });
});
