/**
 * Read-only-гард для web-only ролей, выведенный из матрицы.
 *
 * Пока гард был отдельным хардкодом в server.ts, он отбивал любую мутацию
 * монитора раньше матрицы — выданное администратором «Создавать» упиралось в
 * него и не работало никогда. Теперь при включённом enforcement решение
 * принимает матрица.
 *
 * Главное, что проверяется здесь: при PERMISSIONS_ENFORCE=0 поведение осталось
 * ПРЕЖНИМ до мелочей. «Вернуть флаг в 0 и перезапустить» обязано возвращать
 * систему в исходное состояние целиком, иначе откат неполон.
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

async function buildApp(opts: {
  role: UserRole;
  overrides?: OverrideRow[];
  enforce?: '0' | '1';
}): Promise<FastifyInstance> {
  process.env.PERMISSIONS_ENFORCE = opts.enforce ?? '1';
  process.env.REDIS_URL = 'redis://127.0.0.1:6399';
  vi.resetModules();
  const { default: permissionsPlugin } = await import('../src/plugins/permissions.js');

  const instance = Fastify({ logger: false });
  instance.setValidatorCompiler(validatorCompiler);
  instance.setSerializerCompiler(serializerCompiler);
  instance.decorate('db', {
    select: () => ({ from: () => Promise.resolve(opts.overrides ?? []) }),
  } as never);
  instance.decorate('redis', { publish: async () => 0 } as never);
  instance.decorate('logUnauthorized', (async () => {}) as never);
  instance.decorate('authenticate', (async () => {}) as never);
  instance.decorate('authorize', () => async () => {
    /* allow-list в этом наборе не предмет проверки */
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

  // Маршруты с боевыми шаблонами: гард смотрит именно на routeOptions.url.
  instance.patch('/api/v1/deliveries/:id/review', async () => ({ ok: 'review' }));
  instance.patch('/api/v1/deliveries/:id/flags', async () => ({ ok: 'flags' }));
  instance.post('/api/v1/deliveries', async () => ({ ok: 'upsert' }));
  instance.post('/api/v1/sites', async () => ({ ok: 'site' }));
  instance.get('/api/v1/deliveries', async () => ({ ok: 'list' }));
  instance.post('/api/v1/auth/logout', async () => ({ ok: 'logout' }));
  // Маршрут вне реестра прав — проверяем fail-closed для read-only ролей.
  instance.post('/api/v1/unknown-route', async () => ({ ok: 'unknown' }));
  // Синхронизация ЭДО: legacy-правило ссылается на действие `edit`, которого у
  // страницы «ЭДО» нет вовсе (учётку пересоздают, PATCH-роута нет). Гард обязан
  // читать это как «под матрицей ячеек нет» и НЕ пускать web-only роль.
  // authorize здесь намеренно пропускает всех — иначе он замаскировал бы
  // ошибку гарда, и тест проверял бы не то.
  instance.post('/api/v1/admin/edo-accounts/:id/sync', async () => ({ ok: 'edo-sync' }));

  await instance.ready();
  return instance;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  process.env = { ...ORIGINAL_ENV };
});

const send = (instance: FastifyInstance, method: 'POST' | 'PATCH' | 'GET', url: string) =>
  instance.inject({ method, url, payload: method === 'GET' ? undefined : {} });

describe('при выключенном флаге гард ведёт себя ровно как прежде', () => {
  it('монитору разрешена только отметка проверки', async () => {
    app = await buildApp({ role: 'monitor', enforce: '0' });
    expect((await send(app, 'PATCH', '/api/v1/deliveries/1/review')).statusCode).toBe(200);
    expect((await send(app, 'PATCH', '/api/v1/deliveries/1/flags')).statusCode).toBe(403);
    expect((await send(app, 'POST', '/api/v1/deliveries')).statusCode).toBe(403);
  });

  it('выданное право НЕ открывает маршрут, пока матрица выключена', async () => {
    // Иначе «вернуть флаг в 0» перестало бы быть полным откатом.
    app = await buildApp({
      role: 'monitor',
      enforce: '0',
      overrides: [row('monitor', 'operations.deliveries', { canView: true, canCreate: true })],
    });
    const res = await send(app, 'POST', '/api/v1/deliveries');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ message: 'Read-only role' });
  });

  it('подрядчик не пишет ничего', async () => {
    app = await buildApp({ role: 'contractor', enforce: '0' });
    expect((await send(app, 'POST', '/api/v1/deliveries')).statusCode).toBe(403);
    expect((await send(app, 'PATCH', '/api/v1/deliveries/1/review')).statusCode).toBe(403);
  });
});

describe('при включённом флаге решает матрица', () => {
  it('отметка проверки работает без всякой выдачи — она базовая', async () => {
    app = await buildApp({ role: 'monitor' });
    expect((await send(app, 'PATCH', '/api/v1/deliveries/1/review')).statusCode).toBe(200);
  });

  it('ЦЕЛЬ: выданное «Создавать» пропускает upsert через гард', async () => {
    // Ровно то, ради чего гард переезжал: раньше он отбивал запрос до матрицы.
    app = await buildApp({
      role: 'monitor',
      overrides: [row('monitor', 'operations.deliveries', { canView: true, canCreate: true })],
    });
    expect((await send(app, 'POST', '/api/v1/deliveries')).statusCode).toBe(200);
    // Соседний маршрут той же роли остаётся закрытым: права на него не выдавали.
    expect((await send(app, 'POST', '/api/v1/sites')).statusCode).toBe(403);
  });

  it('снятая отметка проверки закрывает и её маршрут', async () => {
    app = await buildApp({
      role: 'monitor',
      overrides: [row('monitor', 'operations.deliveries', { canView: true, canReview: false })],
    });
    expect((await send(app, 'PATCH', '/api/v1/deliveries/1/review')).statusCode).toBe(403);
  });

  it('подрядчику запись по-прежнему закрыта везде', async () => {
    // Ему право выдать нельзя (WRITE_BLOCKED_ROLES), но строку можно записать
    // руками в psql — гард обязан устоять и в этом случае.
    app = await buildApp({
      role: 'contractor',
      overrides: [row('contractor', 'references.sites', { canView: true, canCreate: true })],
    });
    expect((await send(app, 'POST', '/api/v1/sites')).statusCode).toBe(403);
  });

  it('РЕГРЕСС: sync ЭДО закрыт, хотя его ячейка неприменима к странице', async () => {
    // Эту дыру нашёл exhaustive-перебор: judgeRuleCells отсеивал неприменимое
    // действие, список ячеек пустел, и «нет ячеек» читалось как «вне матрицы»
    // — гард пропускал. Сквозной no-op её НЕ ловит: там роль всё равно
    // отсекает allow-list маршрута. Держится проверка только здесь.
    for (const role of ['monitor', 'contractor'] as const) {
      app = await buildApp({ role });
      const res = await send(app, 'POST', '/api/v1/admin/edo-accounts/42/sync');
      expect(res.statusCode, `${role} прошёл гард на sync ЭДО`).toBe(403);
      expect(res.json()).toMatchObject({ message: 'Read-only role' });
      await app.close();
      app = undefined;
    }
  });

  it('маршрут вне реестра для read-only роли закрыт (fail-closed)', async () => {
    // Матрица снаружи fail-open — пропускает незнакомое. Гард наоборот:
    // незнакомый мутирующий маршрут не должен открываться сам собой.
    app = await buildApp({ role: 'monitor' });
    expect((await send(app, 'POST', '/api/v1/unknown-route')).statusCode).toBe(403);
  });
});

describe('что гард не трогает', () => {
  it('чтение и самообслуживание проходят при любом флаге', async () => {
    for (const enforce of ['0', '1'] as const) {
      app = await buildApp({ role: 'contractor', enforce });
      expect((await send(app, 'GET', '/api/v1/deliveries')).statusCode).toBe(200);
      expect((await send(app, 'POST', '/api/v1/auth/logout')).statusCode).toBe(200);
      await app.close();
      app = undefined;
    }
  });

  it('роли вне web-only гард не касается', async () => {
    app = await buildApp({ role: 'inspector_kpp' });
    expect((await send(app, 'POST', '/api/v1/deliveries')).statusCode).toBe(200);
  });
});
