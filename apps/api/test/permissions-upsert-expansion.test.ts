/**
 * Двухфазная проверка прав на маршрутах, где действие выясняется в рантайме.
 *
 * У upsert приёмки `authorize` отрабатывает РАНЬШЕ, чем обработчик узнает из
 * БД, создание это или правка. Поэтому проверок две:
 *
 *   1) до обработчика — пускаем, если администратор расширил ХОТЬ ОДНУ из
 *      возможных ячеек маршрута (иначе allow-list отсечёт монитора прежде, чем
 *      станет известна ветка, и выданное право осталось бы мёртвым);
 *   2) после SELECT — assertPermission сверяет уже точную пару и отказывает,
 *      если расширена была соседняя.
 *
 * Здесь проверяется именно стык: обе фазы вместе, с настоящими плагином прав и
 * копией боевого authorize. Риск, который тест закрывает, — «пустили до
 * обработчика» незаметно превратилось бы в «разрешили любую ветку».
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserRole } from '@matcheck/contracts';

type OverrideRow = {
  role: string;
  pageId: string;
  canView: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canReview: boolean;
};

const ORIGINAL_ENV = { ...process.env };
let app: FastifyInstance | undefined;

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
  canReview: patch.canReview ?? false,
});

/**
 * Приложение с настоящими плагином прав и assertPermission. Маршруты — копии
 * боевых по allow-list; ветка upsert выбирается query-параметром вместо SELECT,
 * потому что предмет теста — стык хука и assertPermission, а не работа с БД.
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
  const { assertPermission } = await import('../src/lib/permissions/assert.js');

  const instance = Fastify({ logger: false });
  instance.setValidatorCompiler(validatorCompiler);
  instance.setSerializerCompiler(serializerCompiler);
  instance.decorate('db', {
    select: () => ({ from: () => Promise.resolve(opts.overrides ?? []) }),
  } as never);
  instance.decorate('redis', { publish: async () => 0 } as never);
  instance.decorate('logUnauthorized', (async () => {}) as never);
  instance.decorate('authenticate', (async () => {}) as never);
  instance.decorate('authorize', (...roles: UserRole[]) => {
    return async (
      req: { user?: { role: UserRole }; permissionExpanded?: boolean },
      reply: { code: (c: number) => { send: (b: unknown) => void } },
    ) => {
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

  // PermissionError → 403, как боевой error-handler.
  instance.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({ error: err.name, message: err.message });
  });

  await instance.register(permissionsPlugin);

  const authorize = (...roles: UserRole[]) =>
    (instance as unknown as { authorize: (...r: UserRole[]) => unknown }).authorize(...roles);

  // Upsert приёмки: тот же allow-list, что в бою (routes/deliveries.ts).
  instance.post(
    '/api/v1/deliveries',
    { preHandler: [authorize('admin', 'manager', 'inspector_kpp')] as never },
    async (req) => {
      const branch = (req.query as { branch?: string }).branch === 'edit' ? 'edit' : 'create';
      await assertPermission(req, 'operations.deliveries', branch);
      return { ok: branch };
    },
  );

  // Фото: dynamic-правило, вид операции из тела.
  instance.post(
    '/api/v1/photos/presign',
    { preHandler: [authorize('admin', 'manager', 'inspector_kpp')] as never },
    async () => ({ ok: 'presign' }),
  );

  await instance.ready();
  return instance;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  process.env = { ...ORIGINAL_ENV };
});

const post = (instance: FastifyInstance, url: string, payload?: unknown) =>
  instance.inject({ method: 'POST', url, payload: payload ?? {} });

describe('upsert: пускаем до обработчика, решаем после SELECT', () => {
  it('без выданных прав монитор не проходит даже до обработчика', async () => {
    app = await buildApp({ role: 'monitor' });
    expect((await post(app, '/api/v1/deliveries?branch=create')).statusCode).toBe(403);
  });

  it('выдан create → ветка создания проходит', async () => {
    app = await buildApp({
      role: 'monitor',
      overrides: [row('monitor', 'operations.deliveries', { canView: true, canCreate: true })],
    });
    const res = await post(app, '/api/v1/deliveries?branch=create');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: 'create' });
  });

  it('ГЛАВНОЕ: выдан только create, но запись существует → ветка edit отказывает', async () => {
    // Хук пустил запрос дальше (одна из ячеек расширена), и если бы на этом всё
    // заканчивалось, монитор правил бы чужие приёмки по праву «Создавать».
    app = await buildApp({
      role: 'monitor',
      overrides: [row('monitor', 'operations.deliveries', { canView: true, canCreate: true })],
    });
    const res = await post(app, '/api/v1/deliveries?branch=edit');
    expect(res.statusCode).toBe(403);
    // Тот же код отказа, что у хука: один класс отказа — один код, иначе
    // фронтовый onForbidden и интеграции знали бы два.
    expect(res.json()).toMatchObject({ error: 'permission_denied' });
  });

  it('зеркально: выдан только edit → ветка создания отказывает', async () => {
    app = await buildApp({
      role: 'monitor',
      overrides: [row('monitor', 'operations.deliveries', { canView: true, canEdit: true })],
    });
    expect((await post(app, '/api/v1/deliveries?branch=create')).statusCode).toBe(403);
    expect((await post(app, '/api/v1/deliveries?branch=edit')).statusCode).toBe(200);
  });

  it('при PERMISSIONS_ENFORCE=0 действует прежний allow-list', async () => {
    // Полнота отката: выданное право не должно открывать маршрут, пока
    // матрица выключена, — иначе «вернуть флаг в 0» перестало бы быть откатом.
    app = await buildApp({
      role: 'monitor',
      enforce: '0',
      overrides: [row('monitor', 'operations.deliveries', { canView: true, canCreate: true })],
    });
    expect((await post(app, '/api/v1/deliveries?branch=create')).statusCode).toBe(403);
  });
});

describe('фото: dynamic-правило получает отметку в preHandler', () => {
  it('выданный create открывает presign приёмки', async () => {
    // Проверяет и порядок хуков: instance-preHandler плагина обязан выполниться
    // раньше route-preHandler с authorize, иначе отметка не успеет.
    app = await buildApp({
      role: 'monitor',
      overrides: [row('monitor', 'operations.deliveries', { canView: true, canCreate: true })],
    });
    const res = await post(app, '/api/v1/photos/presign', { operationKind: 'delivery' });
    expect(res.statusCode).toBe(200);
  });

  it('право приёмок не открывает фото отгрузки', async () => {
    app = await buildApp({
      role: 'monitor',
      overrides: [row('monitor', 'operations.deliveries', { canView: true, canCreate: true })],
    });
    const res = await post(app, '/api/v1/photos/presign', { operationKind: 'shipment' });
    expect(res.statusCode).toBe(403);
  });
});
