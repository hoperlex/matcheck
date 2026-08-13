/**
 * «Выдать → маршрут отвечает 200 → снять → 403» по каждому расширяемому
 * маршруту реестра — настоящими HTTP-запросами.
 *
 * Прошлая версия этого набора вызывала только резолвер и честно об этом
 * писала. Это было полезно, но не покрывало заявленного: между решением
 * матрицы и ответом сервера лежат гард, `permissionExpanded` и `app.authorize`,
 * и сломаться могло любое звено. Здесь поднимается настоящий плагин, а
 * маршруты-заглушки регистрируются по данным инвентаря — с теми же
 * шаблонами и теми же allow-list, что в бою.
 *
 * Заглушки вместо реальных обработчиков намеренно: предмет проверки — цепочка
 * до хендлера. Ветки внутри хендлеров (upsert, удаление) покрыты
 * permissions-upsert.int на живой БД.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MATRIX,
  MANAGED_ROLES,
  canExpand,
  isLockedCell,
  type ManagedRole,
  type PageAction,
  type PageId,
  type UserRole,
} from '@matcheck/contracts';
import { ROUTE_PERMISSIONS, routeKey } from '../src/lib/permissions/route-map.js';
import { matrixCellsOf } from '../src/lib/permissions/rule-cells.js';
import { collectRoutes, isSyntheticMethod, type RouteRow } from './helpers/route-inventory.js';

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
};

/** Строка overrides: дефолт роли с одной изменённой ячейкой. */
function overrideRow(role: ManagedRole, page: PageId, action: PageAction, allowed: boolean): Row {
  const base = { ...DEFAULT_MATRIX[role][page], [action]: allowed };
  return {
    role,
    pageId: page,
    canView: base.view,
    canCreate: base.create,
    canEdit: base.edit,
    canDelete: base.delete,
    canReview: base.review,
  };
}

/**
 * Приложение с настоящим плагином прав и боевым allow-list у каждого маршрута.
 * Роль и overrides задаются на вызов — приложение поднимается заново, потому
 * что плагин читает флаг и кеш при старте.
 */
async function buildApp(role: UserRole, overrides: Row[]): Promise<FastifyInstance> {
  process.env.PERMISSIONS_ENFORCE = '1';
  process.env.REDIS_URL = 'redis://127.0.0.1:6399';
  vi.resetModules();
  const { default: permissionsPlugin } = await import('../src/plugins/permissions.js');
  const { ALLOWED_ROLES } = await import('../src/plugins/auth.js');

  const instance = Fastify({ logger: false });
  instance.setValidatorCompiler(validatorCompiler);
  instance.setSerializerCompiler(serializerCompiler);
  instance.decorate('db', {
    select: () => ({ from: () => Promise.resolve(overrides) }),
  } as never);
  instance.decorate('redis', { publish: async () => 0 } as never);
  instance.decorate('logUnauthorized', (async () => {}) as never);
  instance.decorate('authenticate', (async () => {}) as never);
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
      role,
      siteId: null,
      contractorCustomerId: null,
      sessionId: 'sess',
    };
  });
  instance.setErrorHandler((err, _req, reply) =>
    reply.code((err as { statusCode?: number }).statusCode ?? 500).send({ error: err.name }),
  );

  await instance.register(permissionsPlugin);

  const authorize = (...roles: UserRole[]) =>
    (instance as unknown as { authorize: (...r: UserRole[]) => unknown }).authorize(...roles);

  // Заглушки по инвентарю: тот же метод, шаблон и allow-list, что в бою.
  for (const r of inventory) {
    const handler = async () => ({ ok: true });
    const opts = r.roles.length > 0 ? { preHandler: [authorize(...r.roles)] as never } : {};
    const method = r.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
    if (!['get', 'post', 'patch', 'put', 'delete'].includes(method)) continue;
    instance[method](r.url, opts, handler);
  }

  await instance.ready();
  return instance;
}

let inventory: RouteRow[] = [];

type Case = {
  r: RouteRow;
  role: ManagedRole;
  page: PageId;
  action: PageAction;
};

/**
 * Пары, где выдача права вообще осмысленна: право не базовое, выдать его можно
 * и матрице есть что проверять. Только `static` — у dynamic/in-handler ветку
 * выбирает тело запроса или БД, и заглушкой это не воспроизвести.
 */
function grantableCases(): Case[] {
  const out: Case[] = [];
  for (const r of inventory) {
    const rule = ROUTE_PERMISSIONS.get(routeKey(r.method, r.url));
    if (rule?.kind !== 'static') continue;
    for (const { page, action } of matrixCellsOf(rule)) {
      for (const role of MANAGED_ROLES) {
        if (isLockedCell(role, page, action)) continue;
        if (DEFAULT_MATRIX[role][page][action]) continue;
        if (!canExpand(role, page, action)) continue;
        if (!(rule.expandableBy?.includes(role) ?? true)) continue;
        out.push({ r, role, page, action });
      }
    }
  }
  return out;
}

beforeAll(async () => {
  inventory = (await collectRoutes()).filter((x) => !isSyntheticMethod(x.method));
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  process.env = { ...ORIGINAL_ENV };
});

describe('выдача и снятие права меняют ответ маршрута', () => {
  it('перебор не пуст', () => {
    expect(inventory.length).toBeGreaterThan(150);
    expect(grantableCases().length).toBeGreaterThan(30);
  });

  it('выдал — 200, снял — 403, и так на каждом расширяемом маршруте', async () => {
    const failures: string[] = [];

    for (const c of grantableCases()) {
      const method = c.r.method.toUpperCase() as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
      // :params заполняем чем угодно — до хендлера дело не дойдёт, а роутер
      // должен сматчить шаблон.
      const url = c.r.url.replace(/:[A-Za-z0-9_]+/g, '42');

      app = await buildApp(c.role, [overrideRow(c.role, c.page, c.action, true)]);
      const granted = await app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
      await app.close();

      app = await buildApp(c.role, [overrideRow(c.role, c.page, c.action, false)]);
      const revoked = await app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
      await app.close();
      app = undefined;

      const key = `${routeKey(c.r.method, c.r.url)} × ${c.role} × ${c.page}:${c.action}`;
      if (granted.statusCode !== 200) {
        failures.push(`${key}: выданное право не открыло маршрут (${granted.statusCode})`);
      }
      if (revoked.statusCode !== 403) {
        failures.push(`${key}: снятое право не закрыло маршрут (${revoked.statusCode})`);
      }
    }

    expect(
      failures.sort(),
      'Галочка обязана менять фактический ответ сервера, а не только решение резолвера.',
    ).toEqual([]);
  }, 120_000);
});
