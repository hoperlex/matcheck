/**
 * Полнота отката: PERMISSIONS_ENFORCE=0 возвращает систему в исходное
 * состояние И на сервере, И в интерфейсе.
 *
 * Без этого рубильник был бы половинчатым: сервер перестал бы запрещать, а
 * веб продолжал бы прятать кнопки по сохранённым overrides — то есть
 * «выключить флаг и перезапустить» не откатывало бы фичу, и чинить пришлось
 * бы удалением строк в psql на бою.
 *
 * Сами overrides при этом обязаны сохраниться: включение флага обратно
 * должно восстанавливать настройки, а не начинать с чистого листа.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MATRIX } from '@matcheck/contracts';
import type { AuthUser } from '../src/plugins/auth.js';

const ORIGINAL_ENV = { ...process.env };
let app: FastifyInstance | undefined;

/** Менеджеру запрещено всё на справочнике объектов. */
const OVERRIDES = [
  {
    role: 'manager',
    pageId: 'references.sites',
    canView: false,
    canCreate: false,
    canEdit: false,
    canDelete: false,
  },
];

async function buildApp(enforce: '0' | '1'): Promise<FastifyInstance> {
  process.env.PERMISSIONS_ENFORCE = enforce;
  process.env.REDIS_URL = 'redis://127.0.0.1:6399';
  vi.resetModules();
  const { default: permissionsPlugin } = await import('../src/plugins/permissions.js');
  const { meRoutes } = await import('../src/routes/me.js');

  const instance = Fastify({ logger: false });
  instance.setValidatorCompiler(validatorCompiler);
  instance.setSerializerCompiler(serializerCompiler);
  instance.decorate('db', {
    select: () => ({ from: () => Promise.resolve(OVERRIDES) }),
  } as never);
  instance.decorate('redis', { publish: async () => 0 } as never);
  instance.decorate('logUnauthorized', async () => {});
  const asManager: AuthUser = {
    id: '11111111-1111-1111-1111-111111111111',
    role: 'manager',
    siteId: null,
    contractorCustomerId: null,
    sessionId: 'sess',
  };
  instance.decorate('authenticate', async (req: { user?: AuthUser }) => {
    req.user = asManager;
  });
  // Хук ДО регистрации плагина — как настоящий authPlugin, который заполняет
  // req.user глобально. Без этого плагин считает запрос анонимным и пропускает.
  instance.addHook('onRequest', async (req) => {
    req.user = asManager;
  });

  await instance.register(permissionsPlugin);
  await instance.register(meRoutes);
  instance.post('/api/v1/sites', async () => ({ ok: 'created' }));
  await instance.ready();
  return instance;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  process.env = { ...ORIGINAL_ENV };
});

describe('PERMISSIONS_ENFORCE=0 — полный откат', () => {
  it('при включённом флаге сужение действует и видно в /me/permissions', async () => {
    app = await buildApp('1');

    const me = await app.inject({ method: 'GET', url: '/api/v1/me/permissions' });
    const body = me.json() as {
      enforced: boolean;
      pages: Record<string, Record<string, boolean>>;
    };
    expect(body.enforced).toBe(true);
    expect(body.pages['references.sites']).toMatchObject({ view: false, create: false });

    const write = await app.inject({ method: 'POST', url: '/api/v1/sites', payload: {} });
    expect(write.statusCode).toBe(403);
  });

  it('при выключенном флаге сервер не запрещает, а UI получает ДЕФОЛТЫ', async () => {
    app = await buildApp('0');

    const me = await app.inject({ method: 'GET', url: '/api/v1/me/permissions' });
    const body = me.json() as {
      enforced: boolean;
      pages: Record<string, Record<string, boolean>>;
    };

    expect(body.enforced).toBe(false);
    // Ключевое: сохранённые overrides игнорируются, иначе интерфейс
    // продолжал бы прятать кнопки, которые сервер уже разрешает.
    expect(body.pages['references.sites']).toMatchObject(
      DEFAULT_MATRIX.manager['references.sites'],
    );

    const write = await app.inject({ method: 'POST', url: '/api/v1/sites', payload: {} });
    expect(write.statusCode).toBe(200);
  });

  it('overrides не стираются: обратное включение восстанавливает настройки', async () => {
    // Выключение — это игнорирование строк, а не их удаление.
    app = await buildApp('0');
    const off = (await app.inject({ method: 'GET', url: '/api/v1/me/permissions' })).json() as {
      pages: Record<string, Record<string, boolean>>;
    };
    expect(off.pages['references.sites']!.view).toBe(true);
    await app.close();

    app = await buildApp('1');
    const on = (await app.inject({ method: 'GET', url: '/api/v1/me/permissions' })).json() as {
      pages: Record<string, Record<string, boolean>>;
    };
    expect(on.pages['references.sites']!.view).toBe(false);
  });

  it('/me/permissions отдаёт userId для сверки на клиенте', async () => {
    app = await buildApp('1');
    const body = (await app.inject({ method: 'GET', url: '/api/v1/me/permissions' })).json() as {
      userId: string;
      role: string;
    };
    // Фронт сверяет это поле перед записью в стор: запрос мог стартовать до
    // смены пользователя во вкладке и завершиться после неё.
    expect(body.userId).toBe('11111111-1111-1111-1111-111111111111');
    expect(body.role).toBe('manager');
  });

  it('ПУСТОЕ значение переменной не роняет старт, а читается как выключено', async () => {
    // `PERMISSIONS_ENFORCE=` — ровно то, что получается при копировании
    // env-примера с незаполненным значением. Пустая строка приходит в схему
    // как '', а не undefined, поэтому .default('0') до неё не доходит: без
    // preprocess валидация падала бы и роняла api и worker целиком — из-за
    // переменной, которая по смыслу выключена.
    process.env.PERMISSIONS_ENFORCE = '';
    process.env.REDIS_URL = 'redis://127.0.0.1:6399';
    vi.resetModules();
    const { loadEnv } = await import('../src/lib/env.js');
    expect(loadEnv().PERMISSIONS_ENFORCE).toBe(false);
  });

  it('неприменимые действия приходят как false, а не как разрешённые', async () => {
    app = await buildApp('1');
    const body = (await app.inject({ method: 'GET', url: '/api/v1/me/permissions' })).json() as {
      pages: Record<string, Record<string, boolean>>;
    };
    // У «Статистики» есть только просмотр — UI не должен рисовать остальные.
    expect(body.pages.stats).toMatchObject({ create: false, edit: false, delete: false });
  });
});
