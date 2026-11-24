/**
 * «API-доступ» не выдаётся никому, даже строкой, записанной в БД в обход
 * матрицы. Общий перебор permissions-grant-revoke эту страницу пропускает (она
 * в NEVER_GRANTABLE), поэтому проверка — отдельная, на настоящем плагине прав и
 * с тем же allow-list маршрутов, что в бою.
 *
 * Контроль: та же принудительная строка для расширяемой страницы (почта)
 * маршрут ОТКРЫВАЕТ — значит 403 ниже даёт именно запрет страницы, а не
 * сломанный стенд.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageId, UserRole } from '@matcheck/contracts';

const ORIGINAL_ENV = { ...process.env };
let app: FastifyInstance | undefined;

type Row = {
  role: string;
  pageId: string;
  canView: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canReview: boolean;
  canReparse: boolean;
};

const forced = (page: PageId): Row => ({
  role: 'manager',
  pageId: page,
  canView: true,
  canCreate: true,
  canEdit: true,
  canDelete: true,
  canReview: false,
  canReparse: false,
});

const ROUTES: [string, string][] = [
  ['GET', '/api/v1/admin/api-keys'],
  ['POST', '/api/v1/admin/api-keys'],
  ['PATCH', '/api/v1/admin/api-keys/:id'],
  ['POST', '/api/v1/admin/api-keys/:id/rotate-secret'],
  ['POST', '/api/v1/admin/api-keys/:id/revoke'],
];

async function buildApp(overrides: Row[]): Promise<FastifyInstance> {
  process.env.PERMISSIONS_ENFORCE = '1';
  process.env.REDIS_URL = 'redis://127.0.0.1:6399';
  vi.resetModules();
  const { default: permissionsPlugin } = await import('../src/plugins/permissions.js');
  const { ALLOWED_ROLES } = await import('../src/plugins/auth.js');

  const instance = Fastify({ logger: false });
  instance.setValidatorCompiler(validatorCompiler);
  instance.setSerializerCompiler(serializerCompiler);
  instance.decorate('db', { select: () => ({ from: () => Promise.resolve(overrides) }) } as never);
  instance.decorate('redis', { publish: async () => 0 } as never);
  instance.decorate('logUnauthorized', (async () => {}) as never);
  instance.decorate('authenticate', (async () => {}) as never);
  // Тот же страж, что в plugins/auth.ts: явное расширение матрицы обходит allow-list.
  instance.decorate('authorize', (...roles: UserRole[]) => {
    const guard = async (
      req: { user?: { role: UserRole }; permissionExpanded?: boolean },
      reply: { code: (c: number) => { send: (b: unknown) => void } },
    ) => {
      if (req.permissionExpanded) return;
      if (!req.user || !roles.includes(req.user.role)) reply.code(403).send({ error: 'forbidden' });
    };
    (guard as unknown as Record<symbol, unknown>)[ALLOWED_ROLES] = roles;
    return guard;
  });
  instance.addHook('onRequest', async (req) => {
    req.user = {
      id: '11111111-1111-1111-1111-111111111111',
      role: 'manager',
      siteId: null,
      contractorCustomerId: null,
      sessionId: 'sess',
    };
  });
  await instance.register(permissionsPlugin);
  const authorize = (instance as unknown as { authorize: (...r: UserRole[]) => unknown }).authorize;
  for (const [method, url] of [...ROUTES, ['GET', '/api/v1/admin/mail-accounts'] as [string, string]]) {
    instance.route({
      method: method as 'GET',
      url,
      preHandler: [authorize('admin')] as never,
      handler: async () => ({ ok: true }),
    });
  }
  await instance.ready();
  return instance;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  process.env = { ...ORIGINAL_ENV };
});

describe('API-доступ не выдаётся менеджеру даже строкой в БД', () => {
  it('контроль: та же строка для почты открывает маршрут', async () => {
    app = await buildApp([forced('admin.mail_accounts')]);
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/mail-accounts' });
    expect(res.statusCode).toBe(200);
  });

  it.each(ROUTES)('%s %s — 403 при принудительном view/create/edit/delete', async (method, url) => {
    app = await buildApp([forced('admin.api_access')]);
    const res = await app.inject({
      method: method as 'GET',
      url: url.replace(':id', '00000000-0000-4000-8000-000000000001'),
      payload: method === 'GET' ? undefined : {},
    });
    expect(res.statusCode).toBe(403);
  });
});
