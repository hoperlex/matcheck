/**
 * Поведение хуков применения матрицы прав.
 *
 * Проверяем именно те свойства, на которых держится безопасность выката:
 * выключенный флаг — полный no-op; неизвестный маршрут не режем (fail-open,
 * иначе забытый роут положил бы прод); admin вне матрицы; недоступная БД не
 * превращается в отказ; заблокированные ячейки нельзя отключить даже прямой
 * записью в БД.
 */
import Fastify, { type FastifyInstance } from 'fastify';
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
const logUnauthorized = vi.fn(async () => {});

type BuildOpts = {
  role: UserRole;
  enforce?: '0' | '1';
  overrides?: OverrideRow[];
  /** Бросить ошибку при чтении матрицы — проверка fail-open. */
  dbFails?: boolean;
};

async function buildApp(opts: BuildOpts): Promise<FastifyInstance> {
  process.env.PERMISSIONS_ENFORCE = opts.enforce ?? '1';
  // Redis намеренно недоступен: инвалидация деградирует до TTL, а тест не
  // должен зависеть от внешнего сервиса.
  process.env.REDIS_URL = 'redis://127.0.0.1:6399';
  vi.resetModules();
  const { default: permissionsPlugin } = await import('../src/plugins/permissions.js');

  const instance = Fastify({ logger: false });
  instance.decorate('db', {
    select: () => ({
      from: () =>
        opts.dbFails
          ? Promise.reject(new Error('db down'))
          : Promise.resolve(opts.overrides ?? []),
    }),
  } as never);
  instance.decorate('redis', { publish: async () => 0 } as never);
  instance.decorate('logUnauthorized', logUnauthorized as never);

  // Хук ставится ДО регистрации плагина, значит выполнится раньше его хуков —
  // ровно как настоящий authPlugin.
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

  // static: references.sites:create
  instance.post('/api/v1/sites', async () => ({ ok: 'created' }));
  // static: references.sites:edit
  instance.patch('/api/v1/sites/:id', async () => ({ ok: 'edited' }));
  // static: operations.deliveries:view
  instance.get('/api/v1/deliveries', async () => ({ ok: 'list' }));
  // always: lookup-справочник
  instance.get('/api/v1/sites', async () => ({ ok: 'lookup' }));
  // dynamic: страница берётся из тела
  instance.post('/api/v1/photos/presign', async () => ({ ok: 'presigned' }));
  // Маршрута нет в реестре — намеренно.
  instance.get('/api/v1/not-in-registry', async () => ({ ok: 'unknown' }));

  await instance.ready();
  return instance;
}

beforeEach(() => {
  logUnauthorized.mockClear();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  process.env = { ...ORIGINAL_ENV };
});

const denyAll = (role: string, pageId: string): OverrideRow => ({
  role,
  pageId,
  canView: false,
  canCreate: false,
  canEdit: false,
  canDelete: false,
});

describe('хук применения матрицы', () => {
  it('запрещает static-маршрут и пишет отказ в журнал', async () => {
    app = await buildApp({
      role: 'manager',
      overrides: [denyAll('manager', 'references.sites')],
    });
    const res = await app.inject({ method: 'POST', url: '/api/v1/sites', payload: {} });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      // Тот же код, что у in-handler-пути (PermissionError): один класс
      // отказа — один код, иначе клиент обязан знать два.
      error: 'permission_denied',
      details: { page: 'references.sites', action: 'create' },
    });
    expect(logUnauthorized).toHaveBeenCalledOnce();
    expect(logUnauthorized.mock.calls[0]?.[2]).toBe(
      'permission_denied:references.sites:create',
    );
  });

  it('пропускает разрешённое действие', async () => {
    app = await buildApp({ role: 'manager', overrides: [] });
    const res = await app.inject({ method: 'POST', url: '/api/v1/sites', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(logUnauthorized).not.toHaveBeenCalled();
  });

  it('admin обходит матрицу даже когда запрещено всё', async () => {
    app = await buildApp({
      role: 'admin',
      // Строки для admin в БД быть не может (CHECK), но даже подложная не
      // должна на него влиять.
      overrides: [denyAll('admin', 'references.sites'), denyAll('manager', 'references.sites')],
    });
    const res = await app.inject({ method: 'POST', url: '/api/v1/sites', payload: {} });
    expect(res.statusCode).toBe(200);
  });

  it('PERMISSIONS_ENFORCE=0 делает хук no-op', async () => {
    app = await buildApp({
      role: 'manager',
      enforce: '0',
      overrides: [denyAll('manager', 'references.sites')],
    });
    const res = await app.inject({ method: 'POST', url: '/api/v1/sites', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(logUnauthorized).not.toHaveBeenCalled();
  });

  it('маршрут вне реестра проходит (fail-open)', async () => {
    app = await buildApp({ role: 'manager', overrides: [] });
    const res = await app.inject({ method: 'GET', url: '/api/v1/not-in-registry' });
    expect(res.statusCode).toBe(200);
  });

  it('always-маршрут не режется даже при полном запрете страницы', async () => {
    app = await buildApp({
      role: 'manager',
      overrides: [denyAll('manager', 'references.sites')],
    });
    // GET /api/v1/sites — общий lookup: он кормит комбобоксы формы приёмки,
    // а не только вкладку справочника.
    const res = await app.inject({ method: 'GET', url: '/api/v1/sites' });
    expect(res.statusCode).toBe(200);
  });

  it('недоступная БД не превращается в отказ (fail-open на дефолты)', async () => {
    app = await buildApp({ role: 'manager', dbFails: true });
    const res = await app.inject({ method: 'POST', url: '/api/v1/sites', payload: {} });
    expect(res.statusCode).toBe(200);
  });

  it('dynamic-правило берёт страницу из тела запроса', async () => {
    app = await buildApp({
      role: 'manager',
      // Запрещаем только отгрузки — приёмки должны остаться доступны.
      overrides: [denyAll('manager', 'operations.shipments')],
    });

    const shipment = await app.inject({
      method: 'POST',
      url: '/api/v1/photos/presign',
      payload: { operationKind: 'shipment', operationId: 'x' },
    });
    expect(shipment.statusCode).toBe(403);
    expect(shipment.json()).toMatchObject({
      details: { page: 'operations.shipments', action: 'create' },
    });

    const delivery = await app.inject({
      method: 'POST',
      url: '/api/v1/photos/presign',
      payload: { operationKind: 'delivery', operationId: 'x' },
    });
    expect(delivery.statusCode).toBe(200);
  });

  it('заблокированную ячейку не отключает даже прямая запись в БД', async () => {
    // Сценарий: кто-то выполнил UPDATE в psql в обход API. Планшет КПП не
    // показывает 403 — он просто перестал бы работать, поэтому резолвер
    // форсирует эти ячейки в true.
    app = await buildApp({
      role: 'inspector_kpp',
      overrides: [denyAll('inspector_kpp', 'operations.deliveries')],
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/deliveries' });
    expect(res.statusCode).toBe(200);
  });

  it('роль без права на страницу получает отказ, а другая роль — нет', async () => {
    app = await buildApp({
      role: 'monitor',
      overrides: [denyAll('monitor', 'operations.deliveries')],
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/deliveries' });
    expect(res.statusCode).toBe(403);
  });
});
