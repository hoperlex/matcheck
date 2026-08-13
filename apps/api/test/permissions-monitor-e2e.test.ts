/**
 * Сквозной сценарий цели: администратор выдаёт Мониторингу права на Приёмки, и
 * они доходят до маршрутов через ВСЕ слои разом.
 *
 * Слоёв четыре, и каждый по отдельности уже покрыт своим набором. Здесь
 * проверяется их стык — то, что раньше и ломалось: право проходило матрицу, но
 * упиралось в read-only-гард; проходило гард, но отсекалось allow-list; или
 * доходило до обработчика, где решала не матрица, а имя роли.
 *
 *   read-only-гард → матрица (хук) → allow-list (authorize) → assertPermission
 *
 * Проверяется и обратное: снятое право закрывает маршрут на первом же слое, а
 * выдача одной ячейки не открывает соседние.
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

/** Приложение со всеми слоями: гард, матрица, настоящий authorize, assertPermission. */
async function buildApp(opts: {
  role: UserRole;
  overrides?: OverrideRow[];
  /** Существует ли запись в БД — от этого зависит ветка upsert. */
  exists?: boolean;
}): Promise<FastifyInstance> {
  process.env.PERMISSIONS_ENFORCE = '1';
  process.env.REDIS_URL = 'redis://127.0.0.1:6399';
  vi.resetModules();
  const { default: permissionsPlugin } = await import('../src/plugins/permissions.js');
  const { assertPermission } = await import('../src/lib/permissions/assert.js');
  const { ALLOWED_ROLES } = await import('../src/plugins/auth.js');

  const instance = Fastify({ logger: false });
  instance.setValidatorCompiler(validatorCompiler);
  instance.setSerializerCompiler(serializerCompiler);
  instance.decorate('db', {
    select: () => ({ from: () => Promise.resolve(opts.overrides ?? []) }),
  } as never);
  instance.decorate('redis', { publish: async () => 0 } as never);
  instance.decorate('logUnauthorized', (async () => {}) as never);
  instance.decorate('authenticate', (async () => {}) as never);

  // Копия боевого authorize вместе с меткой ролей: без неё инвентарь пуст, и
  // тест не проверял бы связку «расширение снимает allow-list».
  instance.decorate('authorize', (...roles: UserRole[]) => {
    const guard = async (
      req: { user?: { role: UserRole }; permissionExpanded?: boolean },
      reply: { code: (c: number) => { send: (b: unknown) => void } },
    ) => {
      if (req.permissionExpanded) return;
      if (!req.user || !roles.includes(req.user.role)) {
        reply.code(403).send({ error: 'forbidden', message: 'Insufficient role' });
      }
    };
    (guard as unknown as Record<symbol, unknown>)[ALLOWED_ROLES] = roles;
    return guard;
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

  instance.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({ error: err.name, message: err.message });
  });

  await instance.register(permissionsPlugin);

  const authorize = (...roles: UserRole[]) =>
    (instance as unknown as { authorize: (...r: UserRole[]) => unknown }).authorize(...roles);

  // Маршруты с боевыми allow-list (см. routes/deliveries.ts, photos.ts).
  instance.post(
    '/api/v1/deliveries',
    { preHandler: [authorize('admin', 'manager', 'inspector_kpp')] as never },
    async (req) => {
      // Как в бою: ветка решается наличием строки в БД, а не наличием input.id.
      await assertPermission(req, 'operations.deliveries', opts.exists ? 'edit' : 'create');
      return { ok: opts.exists ? 'edit' : 'create' };
    },
  );
  instance.patch(
    '/api/v1/deliveries/:id/flags',
    { preHandler: [authorize('admin', 'manager')] as never },
    async () => ({ ok: 'flags' }),
  );
  instance.patch('/api/v1/deliveries/:id/review', async () => ({ ok: 'review' }));
  instance.post(
    '/api/v1/deliveries/bulk-hard-delete',
    { preHandler: [authorize('admin')] as never },
    async () => ({ ok: 'hard-delete' }),
  );
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

const post = (i: FastifyInstance, url: string, payload?: unknown) =>
  i.inject({ method: 'POST', url, payload: payload ?? {} });
const patch = (i: FastifyInstance, url: string) => i.inject({ method: 'PATCH', url, payload: {} });

/** Права монитора на Приёмки: то, что администратор проставил бы галочками. */
const monitorGranted = (patchRow: Partial<Omit<OverrideRow, 'role' | 'pageId'>>) => [
  row('monitor', 'operations.deliveries', { canView: true, canReview: true, ...patchRow }),
];

describe('Мониторинг без выданных прав', () => {
  it('пишет только отметку проверки — как и было', async () => {
    app = await buildApp({ role: 'monitor' });
    expect((await patch(app, '/api/v1/deliveries/1/review')).statusCode).toBe(200);
    expect((await post(app, '/api/v1/deliveries')).statusCode).toBe(403);
    expect((await patch(app, '/api/v1/deliveries/1/flags')).statusCode).toBe(403);
    expect((await post(app, '/api/v1/photos/presign', { operationKind: 'delivery' })).statusCode)
      .toBe(403);
  });
});

describe('администратор выдал Мониторингу «Создавать»', () => {
  it('создание приёмки проходит все четыре слоя', async () => {
    app = await buildApp({ role: 'monitor', overrides: monitorGranted({ canCreate: true }) });
    const res = await post(app, '/api/v1/deliveries');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: 'create' });
  });

  it('загрузка фото приёмки тоже открывается', async () => {
    app = await buildApp({ role: 'monitor', overrides: monitorGranted({ canCreate: true }) });
    const res = await post(app, '/api/v1/photos/presign', { operationKind: 'delivery' });
    expect(res.statusCode).toBe(200);
  });

  it('но правка существующей записи — нет: это другое право', async () => {
    // Хук пустил запрос до обработчика (одна ячейка расширена), а
    // assertPermission после SELECT отказал. Без второй фазы монитор правил бы
    // чужие приёмки по праву «Создавать».
    app = await buildApp({
      role: 'monitor',
      exists: true,
      overrides: monitorGranted({ canCreate: true }),
    });
    const res = await post(app, '/api/v1/deliveries');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'permission_denied' });
  });

  it('и соседние маршруты той же страницы остаются закрытыми', async () => {
    app = await buildApp({ role: 'monitor', overrides: monitorGranted({ canCreate: true }) });
    expect((await patch(app, '/api/v1/deliveries/1/flags')).statusCode).toBe(403);
  });
});

describe('администратор выдал Мониторингу «Редактировать»', () => {
  it('правка существующей записи и флаги открываются', async () => {
    app = await buildApp({
      role: 'monitor',
      exists: true,
      overrides: monitorGranted({ canEdit: true }),
    });
    expect((await post(app, '/api/v1/deliveries')).statusCode).toBe(200);
    // flags — manager-only маршрут, открывается расширением (expandableBy).
    expect((await patch(app, '/api/v1/deliveries/1/flags')).statusCode).toBe(200);
  });

  it('создание при этом закрыто', async () => {
    app = await buildApp({ role: 'monitor', overrides: monitorGranted({ canEdit: true }) });
    expect((await post(app, '/api/v1/deliveries')).statusCode).toBe(403);
  });
});

describe('границы выдачи', () => {
  it('«Удалять» не открывает удаление навсегда', async () => {
    // bulk-hard-delete admin-only и помечен expandableBy: [] — иначе выдача
    // дала бы монитору больше, чем есть у менеджера.
    app = await buildApp({ role: 'monitor', overrides: monitorGranted({ canDelete: true }) });
    expect((await post(app, '/api/v1/deliveries/bulk-hard-delete')).statusCode).toBe(403);
  });

  it('снятая отметка проверки закрывает её маршрут', async () => {
    app = await buildApp({
      role: 'monitor',
      overrides: [row('monitor', 'operations.deliveries', { canView: true, canReview: false })],
    });
    expect((await patch(app, '/api/v1/deliveries/1/review')).statusCode).toBe(403);
  });

  it('права на Приёмки не открывают Отгрузки', async () => {
    app = await buildApp({ role: 'monitor', overrides: monitorGranted({ canCreate: true }) });
    const res = await post(app, '/api/v1/photos/presign', { operationKind: 'shipment' });
    expect(res.statusCode).toBe(403);
  });

  it('подрядчику выданная строка не помогает: гард держит его первым слоем', async () => {
    app = await buildApp({
      role: 'contractor',
      overrides: [
        row('contractor', 'operations.deliveries', { canView: true, canCreate: true }),
      ],
    });
    expect((await post(app, '/api/v1/deliveries')).statusCode).toBe(403);
  });
});
