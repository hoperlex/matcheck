import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { UserRole } from '@matcheck/contracts';

/**
 * Инвентаризация HTTP-маршрутов для тестов-инвариантов прав.
 *
 * Зачем не regex по исходникам. Роли надо знать ФАКТИЧЕСКИЕ, а grep по
 * `app.authorize(...)` их не даёт: например DELETE /api/v1/deliveries/:id
 * висит на голом authenticate, а роли проверяет внутри хендлера по
 * pendingDeletionAt и коду статуса. Здесь мы вместо этого подменяем
 * декоратор `authorize` на записывающий и снимаем аргументы ровно в том
 * виде, в каком их передал роут.
 *
 * Список route-модулей НЕ хардкодится, а вычитывается из src/server.ts:
 * иначе новый модуль, добавленный в сервер, молча выпал бы из инварианта
 * «каждый маршрут есть в реестре прав».
 *
 * БД, Redis и очереди замоканы — регистрация роутов их не касается,
 * хендлеры здесь не выполняются.
 */

export type RouteRow = {
  method: string;
  /** Шаблон роута с :params — то же, что даёт req.routeOptions.url. */
  url: string;
  /** Роли из app.authorize(...); пустой массив = authorize не вызывался. */
  roles: UserRole[];
  /** Стоит ли app.authenticate в preHandler. */
  authenticated: boolean;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_TS = path.resolve(HERE, '../../src/server.ts');

/**
 * Пары «имя экспорта → относительный путь» из импортов server.ts,
 * ограниченные теми, что реально регистрируются через app.register(...).
 */
async function readRouteModules(): Promise<{ name: string; from: string }[]> {
  const src = await readFile(SERVER_TS, 'utf8');

  const registered = new Set<string>();
  for (const m of src.matchAll(/app\.register\(\s*([A-Za-z0-9_]+)\s*[),]/g)) {
    registered.add(m[1]!);
  }

  const out: { name: string; from: string }[] = [];
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.\/routes\/[^']+)'/g)) {
    const from = m[2]!;
    for (const raw of m[1]!.split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0]?.trim();
      if (name && registered.has(name)) out.push({ name, from });
    }
  }
  if (out.length === 0) {
    throw new Error('route-inventory: не удалось разобрать импорты роутов из server.ts');
  }
  return out;
}

export async function collectRoutes(): Promise<RouteRow[]> {
  const rows: RouteRow[] = [];
  const roleTags = new Map<unknown, UserRole[]>();

  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  const authenticate = async () => {};
  app.decorate('authenticate', authenticate as never);
  app.decorate('authorize', ((...roles: UserRole[]) => {
    const fn = async () => {};
    roleTags.set(fn, roles);
    return fn;
  }) as never);

  // Заглушки инфраструктуры: на этапе регистрации роутов до них не доходит,
  // но некоторые модули дотрагиваются до них в теле плагина.
  const chainStub: unknown = new Proxy(
    {},
    {
      get: () =>
        new Proxy(() => undefined, {
          apply: () => chainStub,
          get: () => (chainStub as Record<string, unknown>).any,
        }),
    },
  );
  app.decorate('db', chainStub as never);
  app.decorate('redis', { on: () => undefined } as never);
  app.decorate('queues', {
    updParse: { add: async () => undefined },
    s3Cleanup: { add: async () => undefined },
    mailPoll: { add: async () => undefined },
  } as never);
  // Из @fastify/rate-limit (регистрируется securityPlugin, который здесь не нужен).
  app.decorate('createRateLimit', (() => async () => ({
    isAllowed: false,
    isExceeded: false,
  })) as never);

  app.addHook('onRoute', (route) => {
    const raw = route.preHandler;
    const pre = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const roles = pre.flatMap((f) => roleTags.get(f) ?? []);
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      rows.push({
        method,
        url: route.url,
        roles,
        authenticated: pre.includes(authenticate as never),
      });
    }
  });

  for (const mod of await readRouteModules()) {
    const imported = (await import(mod.from.replace(/^\.\//, '../../src/'))) as Record<
      string,
      unknown
    >;
    const fn = imported[mod.name];
    if (typeof fn !== 'function') {
      throw new Error(`route-inventory: ${mod.name} не найден в ${mod.from}`);
    }
    await app.register(fn as never);
  }
  await app.ready();
  await app.close();

  rows.sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
  return rows;
}

/** HEAD Fastify создаёт автоматически для каждого GET; OPTIONS — CORS-преflight. */
export function isSyntheticMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === 'HEAD' || m === 'OPTIONS';
}
