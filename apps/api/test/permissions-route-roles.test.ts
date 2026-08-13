/**
 * Боевая цепочка инвентаря прав: app.authorize → onRoute → routeRoles →
 * /me/permissions.
 *
 * Остальные тесты возможностей работают на карте ролей, собранной независимым
 * способом (test/helpers/route-inventory подменяет декоратор). Это хорошо для
 * перекрёстной проверки, но поломку САМОЙ сборки инвентаря такая карта не
 * поймает: если бы метка ALLOWED_ROLES перестала попадать на стража или
 * onRoute-хук не успевал до регистрации маршрутов, capabilities молча
 * опустели бы — а тесты остались зелёными.
 *
 * Здесь всё настоящее: реальный декоратор authorize из plugins/auth, реальный
 * плагин прав со своим onRoute, реальный маршрут /me/permissions.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserRole } from '@matcheck/contracts';

const ORIGINAL_ENV = { ...process.env };
let app: FastifyInstance | undefined;

async function buildApp(role: UserRole): Promise<FastifyInstance> {
  process.env.PERMISSIONS_ENFORCE = '1';
  process.env.REDIS_URL = 'redis://127.0.0.1:6399';
  process.env.JWT_SECRET = 'x'.repeat(32);
  vi.resetModules();
  const { default: permissionsPlugin } = await import('../src/plugins/permissions.js');
  const { meRoutes } = await import('../src/routes/me.js');
  const { ALLOWED_ROLES } = await import('../src/plugins/auth.js');

  const instance = Fastify({ logger: false });
  instance.setValidatorCompiler(validatorCompiler);
  instance.setSerializerCompiler(serializerCompiler);
  instance.decorate('db', {
    select: () => ({ from: () => Promise.resolve([]) }),
  } as never);
  instance.decorate('redis', { publish: async () => 0 } as never);
  instance.decorate('logUnauthorized', (async () => {}) as never);
  instance.decorate('authenticate', (async () => {}) as never);

  // НАСТОЯЩИЙ authorize из plugins/auth.ts — вместе с меткой ALLOWED_ROLES.
  // Ради неё тест и написан: подменённый декоратор её бы не поставил.
  instance.decorate('authorize', (...roles: UserRole[]) => {
    const guard = async (req: { permissionExpanded?: boolean; user?: { role: UserRole } }, reply: {
      code: (c: number) => { send: (b: unknown) => void };
    }) => {
      if (req.permissionExpanded) return;
      if (!req.user || !roles.includes(req.user.role)) {
        reply.code(403).send({ error: 'forbidden' });
      }
    };
    (guard as unknown as Record<symbol, unknown>)[ALLOWED_ROLES] = roles;
    return guard;
  });

  instance.addHook('onRequest', async (req) => {
    req.user = {
      id: '11111111-1111-1111-1111-111111111111',
      role,
      siteId: null,
      contractorCustomerId: null,
      sessionId: 'sess',
    };
  });

  await instance.register(permissionsPlugin);
  await instance.register(meRoutes);

  const authorize = (...roles: UserRole[]) =>
    (instance as unknown as { authorize: (...r: UserRole[]) => unknown }).authorize(...roles);

  // Маршруты с боевыми allow-list — те, что несут capability.
  instance.patch(
    '/api/v1/deliveries/:id/flags',
    { preHandler: [authorize('admin', 'manager')] as never },
    async () => ({ ok: true }),
  );
  instance.get(
    '/api/v1/share-links',
    { preHandler: [authorize('admin', 'manager', 'inspector_kpp')] as never },
    async () => ({ ok: true }),
  );
  instance.post(
    '/api/v1/share-links/:id/revoke',
    { preHandler: [authorize('admin', 'manager')] as never },
    async () => ({ ok: true }),
  );

  await instance.ready();
  return instance;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  process.env = { ...ORIGINAL_ENV };
});

const caps = async (instance: FastifyInstance): Promise<string[]> => {
  const res = await instance.inject({ method: 'GET', url: '/api/v1/me/permissions' });
  return (res.json() as { capabilities?: string[] }).capabilities ?? [];
};

describe('инвентарь allow-list собирается из настоящего authorize', () => {
  it('роли маршрутов доезжают до /me/permissions, а не теряются по дороге', async () => {
    app = await buildApp('manager');
    const list = await caps(app);
    // Пустой список означал бы, что метка не попала на стража или onRoute
    // опоздал: именно эту поломку карта из тестового helper'а не заметила бы.
    expect(list.length).toBeGreaterThan(0);
    expect(list).toContain('operations.edit.flags');
    expect(list).toContain('operations.share.revoke');
  });

  it('инспектор видит список ссылок, но не их отзыв', async () => {
    app = await buildApp('inspector_kpp');
    const list = await caps(app);
    expect(list).toContain('operations.share.manage');
    expect(list).not.toContain('operations.share.revoke');
    // Флаги закрыты, хотя базовый edit на приёмках у него есть.
    expect(list).not.toContain('operations.edit.flags');
  });

  it('монитору без выданных прав возможности записи не достаются', async () => {
    app = await buildApp('monitor');
    const list = await caps(app);
    expect(list).not.toContain('operations.edit.flags');
    expect(list).not.toContain('operations.share.manage');
  });
});
