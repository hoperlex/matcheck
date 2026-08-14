/**
 * Роль «Наблюдатель» (observer) — единственная роль БЕЗ исторического доступа:
 * в дефолте у неё нет ни одного права, всё выдаётся галочками матрицы.
 *
 * Почему для неё отдельный набор, а не строчка в существующих. Наборы
 * permissions-noop и permissions-defaults доказывают «фича ничего не меняет»,
 * сверяя матрицу с эталоном «как было до неё». У новой роли никакого «до» нет:
 * прогнать её через те же перечисления — значит сравнить пустоту с пустотой и
 * назвать это доказательством. Здесь проверяется противоположное утверждение:
 * без галочек закрыто ВСЁ, включая маршруты класса `always`, которые матрица не
 * смотрит вовсе, — а с галочкой открывается ровно то, что нужно странице, и
 * ничего сверх.
 *
 * Приложение поднимается настоящим плагином прав, маршруты-заглушки берутся из
 * инвентаря с боевыми allow-list — как в permissions-grant-revoke.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MATRIX,
  MANAGED_ROLES,
  PAGE_ACTIONS,
  PAGE_IDS,
  canExpand,
  type PageAction,
  type PageId,
  type UserRole,
} from '@matcheck/contracts';
import { ROUTE_PERMISSIONS, routeKey } from '../src/lib/permissions/route-map.js';
import { collectRoutes, isSyntheticMethod, type RouteRow } from './helpers/route-inventory.js';

const ORIGINAL_ENV = { ...process.env };
let app: FastifyInstance | undefined;
let inventory: RouteRow[] = [];

type Row = {
  role: string;
  pageId: string;
  canView: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canReview: boolean;
};

/** Строка overrides: дефолт роли (у observer — все false) с одной ячейкой true. */
function grant(page: PageId, action: PageAction): Row {
  const base = { ...DEFAULT_MATRIX.observer[page], [action]: true };
  return {
    role: 'observer',
    pageId: page,
    canView: base.view,
    canCreate: base.create,
    canEdit: base.edit,
    canDelete: base.delete,
    canReview: base.review,
  };
}

async function buildApp(overrides: Row[], enforce: '0' | '1' = '1'): Promise<FastifyInstance> {
  process.env.PERMISSIONS_ENFORCE = enforce;
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

  // req.user ставим ровно там, где его ставит боевой auth-плагин: на публичном
  // периметре он выходит рано и пользователя не заполняет. Без этого тест
  // «наблюдатель залогинен на публичном роуте» проверял бы состояние, которого
  // в бою не бывает, и read-only-гард отбивал бы анонимную загрузку документов
  // поставщиком.
  const PUBLIC_PREFIXES = ['/api/v1/public/', '/api/v1/share/', '/health'];
  instance.addHook('onRequest', async (req) => {
    if (PUBLIC_PREFIXES.some((p) => req.url.startsWith(p))) return;
    req.user = {
      id: '11111111-1111-1111-1111-111111111111',
      role: 'observer',
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

  for (const r of inventory) {
    const method = r.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
    if (!['get', 'post', 'patch', 'put', 'delete'].includes(method)) continue;
    const opts = r.roles.length > 0 ? { preHandler: [authorize(...r.roles)] as never } : {};
    instance[method](r.url, opts, async () => ({ ok: true }));
  }

  await instance.ready();
  return instance;
}

/** Шаблон → конкретный URL: :params заполняем чем угодно, до хендлера не дойдёт. */
function urlOf(pattern: string): string {
  return pattern.replace(/:[A-Za-z]+/g, 'x');
}

async function status(instance: FastifyInstance, method: string, pattern: string): Promise<number> {
  const res = await instance.inject({
    method: method.toUpperCase() as 'GET',
    url: urlOf(pattern),
    payload: method.toUpperCase() === 'GET' ? undefined : {},
  });
  return res.statusCode;
}

/** Маршруты, открытые наблюдателю всегда: самообслуживание и публичный периметр. */
function alwaysOpen(): RouteRow[] {
  return inventory.filter((r) => {
    const rule = ROUTE_PERMISSIONS.get(routeKey(r.method, r.url));
    return rule?.matrixOnly?.mode === 'allow';
  });
}

/**
 * Всё остальное — бизнес-маршруты, которые без галочек обязаны быть закрыты.
 *
 * `in-handler` исключены: их страница выясняется только после SELECT, и
 * отказывает не хук, а assertPermission внутри обработчика (photos.ts:514, 560,
 * 1124). Заглушка его не зовёт, поэтому здесь такой маршрут отвечал бы 200 —
 * это свойство теста, а не дыра. Что assertPermission действительно откажет,
 * проверяется отдельным блоком ниже через тот же резолвер, на котором он
 * построен.
 */
function businessRoutes(): RouteRow[] {
  return inventory.filter((r) => {
    const rule = ROUTE_PERMISSIONS.get(routeKey(r.method, r.url));
    return rule?.matrixOnly?.mode !== 'allow' && rule?.kind !== 'in-handler';
  });
}

beforeAll(async () => {
  inventory = (await collectRoutes()).filter((x) => !isSyntheticMethod(x.method));
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  process.env = { ...ORIGINAL_ENV };
});

describe('дефолт наблюдателя пуст', () => {
  it('ни одной разрешённой ячейки во всей матрице', () => {
    const granted: string[] = [];
    for (const page of PAGE_IDS) {
      for (const action of PAGE_ACTIONS) {
        if (DEFAULT_MATRIX.observer[page][action]) granted.push(`${page}:${action}`);
      }
    }
    expect(
      granted,
      'У наблюдателя появилось базовое право. Дефолт обязан быть пустым: роль ' +
        'настраивается галочками, и любое право «по умолчанию» — это доступ, ' +
        'который администратор не выдавал.',
    ).toEqual([]);
  });

  it('роль под матрицей и участвует в общих перечислениях', () => {
    expect(MANAGED_ROLES).toContain('observer');
  });

  it('просмотр выдаваем везде, кроме матрицы прав', () => {
    for (const page of PAGE_IDS) {
      const expected = page !== 'admin.roles';
      expect(canExpand('observer', page, 'view'), `${page}:view`).toBe(expected);
    }
  });
});

describe('без единой галочки закрыто всё', () => {
  it('перебор не пуст и покрывает always-маршруты', () => {
    const alwaysBusiness = businessRoutes().filter(
      (r) => ROUTE_PERMISSIONS.get(routeKey(r.method, r.url))?.kind === 'always',
    );
    expect(businessRoutes().length).toBeGreaterThan(150);
    // Ради этих маршрутов набор и написан: матрица их не проверяет, и до
    // matrixOnly они были открыты любому аутентифицированному.
    expect(alwaysBusiness.length).toBeGreaterThan(15);
  });

  it('каждый бизнес-маршрут отвечает 403', async () => {
    app = await buildApp([]);
    const open: string[] = [];
    for (const r of businessRoutes()) {
      const code = await status(app, r.method, r.url);
      if (code !== 403) open.push(`${r.method} ${r.url} → ${code}`);
    }
    expect(
      open,
      'Наблюдатель без прав достучался до бизнес-маршрута. Проверьте matrixOnly ' +
        'у этого правила: отсутствие политики означает deny, значит маршрут ' +
        'помечен allow или cells там, где не должен.',
    ).toEqual([]);
  });

  it('самообслуживание остаётся доступным', async () => {
    app = await buildApp([]);
    const blocked: string[] = [];
    for (const r of alwaysOpen()) {
      const code = await status(app, r.method, r.url);
      if (code === 403) blocked.push(`${r.method} ${r.url}`);
    }
    expect(
      blocked,
      'Закрыт маршрут самообслуживания. Без /auth/me, /auth/logout и ' +
        '/me/permissions роль не сможет ни войти, ни выйти, ни узнать свои права.',
    ).toEqual([]);
  });
});

describe('выданная галочка открывает страницу целиком', () => {
  /** Автозапросы страницы Операций — то, что грузится при её открытии. */
  const OPERATIONS_PAGE = [
    'GET /api/v1/deliveries',
    // Вкладка «Ожидаемые» открыта по умолчанию и грузит именно этот список.
    'GET /api/v1/source-documents',
    'GET /api/v1/source-documents/export.xlsx',
    'GET /api/v1/reports/operations-counters',
    'GET /api/v1/sites',
    'GET /api/v1/counterparties',
    'GET /api/v1/customer-counterparties',
    'GET /api/v1/suppliers',
    'GET /api/v1/responsible-persons',
    'GET /api/v1/units',
  ];

  /** Не часть страницы: своя capability, мобильный канал или чужой справочник. */
  const NOT_OPERATIONS_PAGE = [
    'GET /api/v1/share-links',
    'GET /api/v1/share-messages/threads',
    'GET /api/v1/sync',
    'GET /api/v1/statuses',
    'GET /api/v1/mol',
    'GET /api/v1/materials',
    'GET /api/v1/assets',
    'GET /api/v1/admin/users',
  ];

  it('«Операции: просмотр» открывает все автозапросы страницы', async () => {
    app = await buildApp([grant('operations.deliveries', 'view')]);
    const broken: string[] = [];
    for (const key of OPERATIONS_PAGE) {
      const [method, url] = key.split(' ') as [string, string];
      const code = await status(app, method, url);
      if (code !== 200) broken.push(`${key} → ${code}`);
    }
    expect(
      broken,
      'Раздел выдан, но часть его запросов закрыта — пользователь увидит открытую ' +
        'страницу с ошибкой загрузки. Добавьте ячейку страницы в matrixOnly.openedBy ' +
        'этих маршрутов.',
    ).toEqual([]);
  });

  it('и не открывает ничего сверх неё', async () => {
    app = await buildApp([grant('operations.deliveries', 'view')]);
    const leaked: string[] = [];
    for (const key of NOT_OPERATIONS_PAGE) {
      const [method, url] = key.split(' ') as [string, string];
      const code = await status(app, method, url);
      if (code === 200) leaked.push(key);
    }
    expect(
      leaked,
      'Одна галочка открыла лишнее. openedBy обязан перечислять только те ячейки, ' +
        'чьи страницы этот маршрут реально обслуживают.',
    ).toEqual([]);
  });

  it('изоляция справочников: «Статистика» открывает объекты и только их', async () => {
    app = await buildApp([grant('stats', 'view')]);
    // Страница статистики грузит /sites (фильтр по объектам) и свои отчёты.
    expect(await status(app, 'GET', '/api/v1/sites')).toBe(200);
    expect(await status(app, 'GET', '/api/v1/reports/stats-summary')).toBe(200);
    // Остальные справочники ей не нужны — и открываться не должны.
    for (const url of [
      '/api/v1/units',
      '/api/v1/suppliers',
      '/api/v1/mol',
      '/api/v1/materials',
      '/api/v1/assets',
      '/api/v1/responsible-persons',
      '/api/v1/customer-counterparties',
    ]) {
      expect(await status(app, 'GET', url), url).toBe(403);
    }
  });

  it('«Документы: просмотр» открывает чтение УПД, но не операции', async () => {
    app = await buildApp([grant('documents.list', 'view')]);
    expect(await status(app, 'GET', '/api/v1/source-documents')).toBe(200);
    expect(await status(app, 'GET', '/api/v1/source-documents/export.xlsx')).toBe(200);
    expect(await status(app, 'GET', '/api/v1/deliveries')).toBe(403);
    expect(await status(app, 'GET', '/api/v1/reports/operations-counters')).toBe(403);
  });

  it('снятая галочка возвращает 403', async () => {
    app = await buildApp([]);
    expect(await status(app, 'GET', '/api/v1/deliveries')).toBe(403);
    expect(await status(app, 'GET', '/api/v1/source-documents')).toBe(403);
    expect(await status(app, 'GET', '/api/v1/sites')).toBe(403);
  });
});

describe('in-handler маршруты закрыты резолвером', () => {
  it('без галочек резолвер запрещает каждую пару, которой они прикрыты', async () => {
    // assertPermission внутри обработчика построен на isAllowed: если тот
    // отказывает по всем ячейкам маршрута, откажет и он. Перебираем ячейки
    // именно in-handler правил — тех, что выпали из HTTP-перебора выше.
    const { isAllowed } = await import('../src/lib/permissions/matrix.js');
    const { cellsOfRule } = await import('../src/lib/permissions/rule-cells.js');
    const empty = new Map();
    const allowed: string[] = [];
    let checked = 0;
    for (const [key, rule] of ROUTE_PERMISSIONS) {
      if (rule.kind !== 'in-handler') continue;
      for (const c of cellsOfRule(rule)) {
        checked++;
        if (isAllowed(empty, 'observer', c.page, c.action)) {
          allowed.push(`${key} → ${c.page}:${c.action}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
    expect(allowed).toEqual([]);
  });
});

describe('запись без права закрыта', () => {
  it('мутации отбиваются даже на выданном просмотре', async () => {
    app = await buildApp([grant('operations.deliveries', 'view')]);
    for (const [method, url] of [
      ['POST', '/api/v1/deliveries'],
      ['DELETE', '/api/v1/deliveries/x'],
      ['POST', '/api/v1/sites'],
      ['PATCH', '/api/v1/admin/users/x'],
    ] as const) {
      expect(await status(app, method, url), `${method} ${url}`).toBe(403);
    }
  });
});

describe('полнота разметки реестра', () => {
  it('у каждого always и legacy задана политика matrixOnly', () => {
    const missing: string[] = [];
    for (const [key, rule] of ROUTE_PERMISSIONS) {
      if (rule.kind !== 'always' && rule.kind !== 'legacy') continue;
      if (!rule.matrixOnly) missing.push(key);
    }
    expect(
      missing,
      'Маршрут вне матрицы без политики. Решите явно: allow (самообслуживание), ' +
        'deny (роли не положено) или cells (какие галочки его открывают). ' +
        'Умолчание — deny, и молча закрытый маршрут так же плох, как молча открытый.',
    ).toEqual([]);
  });

  it('openedBy ссылается только на применимые ячейки', () => {
    const bad: string[] = [];
    for (const [key, rule] of ROUTE_PERMISSIONS) {
      if (rule.matrixOnly?.mode !== 'cells') continue;
      if (rule.matrixOnly.openedBy.length === 0) bad.push(`${key}: пустой openedBy`);
      for (const c of rule.matrixOnly.openedBy) {
        if (!PAGE_IDS.includes(c.page)) bad.push(`${key}: нет страницы ${c.page}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('откат флага не открывает роль', () => {
  it('при PERMISSIONS_ENFORCE=0 доступно только самообслуживание', async () => {
    // Возврат флага в 0 — штатный откат матрицы. Если бы matrix-only ветка жила
    // за ранним выходом, этот откат вернул бы наблюдателю весь authenticate-only
    // API: справочники и список УПД класса `always`.
    app = await buildApp([grant('operations.deliveries', 'view')], '0');
    expect(await status(app, 'GET', '/api/v1/deliveries')).toBe(403);
    expect(await status(app, 'GET', '/api/v1/source-documents')).toBe(403);
    expect(await status(app, 'GET', '/api/v1/units')).toBe(403);
    expect(await status(app, 'GET', '/api/v1/me/permissions')).toBe(200);
    expect(await status(app, 'GET', '/api/v1/auth/me')).toBe(200);
  });
});
