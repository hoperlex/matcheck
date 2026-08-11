import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ManagedRole } from '@matcheck/contracts';
import { loadEnv } from '../lib/env.js';
import { isAllowed, isExpanded } from '../lib/permissions/matrix.js';
import { createMatrixStore, type MatrixStore } from '../lib/permissions/store.js';
import { lookupRule, type RouteRule } from '../lib/permissions/route-map.js';

declare module 'fastify' {
  interface FastifyInstance {
    permissions: MatrixStore & { enforced: boolean };
  }
  interface FastifyRequest {
    /**
     * Право на этот маршрут РАСШИРЕНО матрицей: в дефолте роли его не было,
     * админ выдал его явной строкой. Только в этом случае запрос обходит
     * allow-list маршрута (app.authorize) — см. комментарий у хуков ниже.
     */
    permissionExpanded?: boolean;
  }
}

/**
 * Применение матрицы прав ролей.
 *
 * Регистрируется ПОСЛЕ authPlugin (нужен req.user) и после read-only-хука
 * для contractor/monitor. Порядок между ними семантически безразличен —
 * оба только запрещают, итог конъюнкция, — но так существующее сообщение
 * 'Read-only role' и его тесты не меняются ни в одном сценарии.
 *
 * Хуков ДВА, и это не дублирование:
 *
 *   onRequest  — правила класса `static`. Отказ до чтения тела: маршруты
 *                загрузки УПД принимают multipart до 10 МБ, и качать их
 *                ради заведомого 403 незачем. Тот же приём использует
 *                read-only-хук в server.ts.
 *
 *   preHandler — правила класса `dynamic`, где страница берётся из тела
 *                (POST /photos/presign: приёмка или отгрузка). На onRequest
 *                тела ещё нет, на preHandler оно уже разобрано и
 *                провалидировано zod.
 *
 * Правила класса `in-handler` не проверяет ни один хук: там страница или
 * действие выясняются только после обращения к БД, и хендлер сам зовёт
 * assertPermission (см. lib/permissions/assert.ts).
 *
 * Маршрут, которого нет в реестре, ПРОПУСКАЕТСЯ (fail-open) — иначе первый
 * же забытый роут положил бы прод, а обещание «в день выката ничего не
 * меняется» перестало бы выполняться. Полноту реестра стережёт CI
 * (permissions-registry.test.ts), а рантайм пишет однократный warn.
 */
export default fp(async (app) => {
  const env = loadEnv();
  const store = createMatrixStore(app);
  const enforced = env.PERMISSIONS_ENFORCE;

  app.decorate('permissions', Object.assign(store, { enforced }));

  if (!enforced) {
    app.log.info('permissions: enforcement выключен (PERMISSIONS_ENFORCE=0)');
    return;
  }

  store.startSubscriber(env.REDIS_URL);
  app.addHook('onClose', async () => {
    await store.stop();
  });
  // Прогрев: первый запрос не должен платить за SELECT.
  app.addHook('onReady', async () => {
    await store.get();
  });

  const warned = new Set<string>();

  async function deny(
    req: FastifyRequest,
    reply: FastifyReply,
    page: string,
    action: string,
  ): Promise<void> {
    await app.logUnauthorized(req, 403, `permission_denied:${page}:${action}`, req.user?.id);
    // Код ошибки — тот же, что у in-handler-пути (PermissionError в
    // lib/permissions/error.ts). Один класс отказа обязан иметь один код:
    // иначе фронтовый onForbidden и будущие интеграции вынуждены знать два.
    // От authorize(...) отличается только этим полем; details добавочные
    // (в ErrorResponseSchema поле необязательное).
    return reply.code(403).send({
      error: 'permission_denied',
      message: 'Недостаточно прав для этого действия',
      details: { page, action },
    });
  }

  /** Общая часть обоих хуков: вернуть правило, если его вообще надо проверять. */
  function ruleFor(req: FastifyRequest): RouteRule | null {
    const user = req.user;
    // Публичный роут (req.user не заполняется) либо 401, уже отправленный
    // auth-хуком, — матрице нечего проверять.
    if (!user) return null;
    // admin вне матрицы: иначе он способен запереть себя вне вкладки «Роли».
    if (user.role === 'admin') return null;

    const tmpl = req.routeOptions?.url;
    // На 404 шаблона нет — поведение прежнее.
    if (!tmpl) return null;

    const rule = lookupRule(req.method, tmpl);
    if (!rule) {
      const key = `${req.method} ${tmpl}`;
      if (!warned.has(key)) {
        warned.add(key);
        req.log.warn({ route: tmpl, method: req.method }, 'permissions: маршрут вне реестра прав');
      }
      return null;
    }
    return rule;
  }

  app.addHook('onRequest', async (req, reply) => {
    const rule = ruleFor(req);
    if (rule?.kind !== 'static' && rule?.kind !== 'legacy') return;

    // legacy: роли, у которых доступ к маршруту есть исторически, идут мимо
    // матрицы целиком — в том числе мимо сужения. Маршрут для них вне матрицы,
    // и снятая галочка не должна молча отбирать работающий доступ.
    if (rule.kind === 'legacy' && rule.roles.includes(req.user!.role as ManagedRole)) return;

    const overrides = await store.get();
    if (isAllowed(overrides, req.user!.role, rule.page, rule.action)) {
      // Отметка ставится ТОЛЬКО на явном расширении (дефолт запрещал, админ
      // выдал). Ставить её на любом разрешении нельзя: одна ячейка охраняет
      // маршруты с разными allow-list'ами, и тогда monitor получил бы
      // manager-only правку операций (его operations.*:edit существует ради
      // отметки проверки), а manager — admin-only bulk-hard-delete. То есть
      // права расширились бы у всех сразу, без единой строки в БД.
      if (isExpanded(overrides, req.user!.role, rule.page, rule.action)) {
        req.permissionExpanded = true;
      }
      return;
    }
    return deny(req, reply, rule.page, rule.action);
  });

  app.addHook('preHandler', async (req, reply) => {
    const rule = ruleFor(req);
    if (rule?.kind !== 'dynamic') return;

    const { page, action } = rule.resolve(req);
    const overrides = await store.get();
    if (isAllowed(overrides, req.user!.role, page, action)) return;
    return deny(req, reply, page, action);
  });
});
