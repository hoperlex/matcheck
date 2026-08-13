import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ManagedRole } from '@matcheck/contracts';
import { loadEnv } from '../lib/env.js';
import { isAllowed, isExpanded } from '../lib/permissions/matrix.js';
import { createMatrixStore, type MatrixStore } from '../lib/permissions/store.js';
import { lookupRule, type RouteRule } from '../lib/permissions/route-map.js';
import { collectRouteRoles, type RouteRolesMap } from '../lib/permissions/route-roles.js';
import { judgeRuleCells, matrixCellsOf } from '../lib/permissions/rule-cells.js';

declare module 'fastify' {
  interface FastifyInstance {
    permissions: MatrixStore & { enforced: boolean; routeRoles: RouteRolesMap };
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
 * Регистрируется ПОСЛЕ authPlugin: обоим хукам нужен req.user, который тот
 * заполняет своим onRequest.
 *
 * Здесь же живёт read-only-гард для web-only ролей: он переехал из server.ts,
 * когда стал выводиться из матрицы. Пока гард был отдельным хардкодом, он
 * отбивал мутации монитора раньше матрицы, и выданное право не работало
 * никогда.
 *
 * Хуков ДВА, и это не дублирование:
 *
 *   onRequest  — правила класса `static`. Отказ до чтения тела: маршруты
 *                загрузки УПД принимают multipart до 10 МБ, и качать их
 *                ради заведомого 403 незачем. Тот же приём использует
 *                read-only-гард ниже.
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

  // Инвентарь allow-list собираем ДО раннего выхода: /me/permissions отдаёт
  // возможности независимо от флага (при выключенном — по дефолтам, то есть
  // повторяя сегодняшний доступ). Хук onRoute обязан быть повешен раньше
  // регистрации маршрутов — плагин для этого и стоит в server.ts перед ними.
  const routeRoles = collectRouteRoles(app);

  app.decorate('permissions', Object.assign(store, { enforced, routeRoles }));

  /**
   * Read-only-гард для web-only ролей: любая мутация contractor и monitor
   * отбивается 403, кроме самообслуживания под /api/v1/auth/ (выход, смена
   * пароля).
   *
   * Метод-ориентированный, а не пер-маршрутный: иммунен к добавлению новых
   * write-эндпоинтов — закрывать каждый вручную не нужно.
   *
   * ПРИ ВЫКЛЮЧЕННОМ ФЛАГЕ поведение ровно прежнее: монитору разрешены только
   * два маршрута отметки проверки, перечисленные ниже. Это условие полноты
   * отката — «вернуть 0 и перезапустить» обязано возвращать систему в
   * исходное состояние целиком, включая гард.
   *
   * ПРИ ВКЛЮЧЁННОМ решение принимает матрица: маршрут проходит, если она
   * разрешает хотя бы одну его ячейку. Иначе выданное монитору «Создавать»
   * упиралось бы сюда и никогда не работало. Список MONITOR_WRITE_ROUTES при
   * этом не нужен: PATCH /:id/review помечен действием `review`, которое у
   * монитора базовое, — матрица пропустит его сама.
   *
   * Защита по умолчанию сохраняется: маршрут вне реестра или помеченный
   * `always` ячеек не имеет, и мутация read-only роли по-прежнему запрещена.
   */
  const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const WEB_ONLY_ROLES = new Set(['contractor', 'monitor']);
  // Шаблоны роутов, а не префиксы сырого url: в сыром URL id стоит в середине
  // пути, и startsWith мог бы случайно открыть лишний mutating-эндпоинт.
  const MONITOR_WRITE_ROUTES = new Set([
    '/api/v1/deliveries/:id/review',
    '/api/v1/shipments/:id/review',
  ]);

  app.addHook('onRequest', async (req, reply) => {
    const role = req.user?.role;
    if (!role || !WEB_ONLY_ROLES.has(role)) return;
    if (!MUTATING.has(req.method.toUpperCase())) return;
    if (req.url.startsWith('/api/v1/auth/')) return;

    let allowed = false;
    if (!enforced) {
      allowed = role === 'monitor' && MONITOR_WRITE_ROUTES.has(req.routeOptions?.url ?? '');
    } else {
      const tmpl = req.routeOptions?.url;
      const rule = tmpl ? lookupRule(req.method, tmpl) : undefined;
      // Критерий — «матрица разрешает», а не «право расширено»: базовые права
      // (отметка проверки у монитора) обязаны работать без всякой выдачи.
      //
      // Fail-closed по построению: пропускаем, только если у маршрута ЕСТЬ
      // ячейки под матрицей и она их разрешает. Маршрут вне реестра, `always`
      // или ячейка с неприменимым действием (legacy sync ЭДО ссылается на
      // `edit`, которого у страницы нет) — всё это «матрица здесь ничего не
      // защищает», и мутацию web-only роли пускать нельзя.
      const cells = rule ? matrixCellsOf(rule) : [];
      allowed =
        cells.length > 0 && judgeRuleCells(rule!, await store.get(), role as ManagedRole).allowed;
    }

    if (allowed) return;
    req.log.warn({ path: req.url, method: req.method, role }, 'read-only role write blocked');
    return reply.code(403).send({ error: 'forbidden', message: 'Read-only role' });
  });

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

  /**
   * Открывает ли выданное сверх дефолта право ИМЕННО ЭТОТ маршрут.
   *
   * Ячейка матрицы шире одного маршрута, и allow-list'ы у них разные. Без
   * пер-ролевой политики выдача «Удалять» монитору открыла бы заодно admin-only
   * bulk-hard-delete — то есть больше, чем есть у менеджера.
   *
   * Общий флаг «этот маршрут не расширяется» тут не годится: `flags` закрыт для
   * inspector_kpp (у которого базовый edit есть), но монитору его открыть надо —
   * ровно ради этого разделяли права. Поэтому решение принимается по роли, а
   * отсутствие политики означает «как раньше»: расширение допускается.
   */
  function expansionOpensRoute(rule: RouteRule, role: ManagedRole): boolean {
    return rule.expandableBy?.includes(role) ?? true;
  }

  /**
   * Расширена ли администратором хотя бы одна из ячеек, которыми маршрут может
   * обернуться в рантайме (upsert — create или edit, фото — приёмка или
   * отгрузка).
   *
   * Ровно «хотя бы одна»: до SELECT неизвестно, какая ветка сработает, а
   * требовать расширения обеих значило бы, что выданное «Создавать» не
   * действует, пока не выдано ещё и «Редактировать».
   */
  async function anyCellExpanded(rule: RouteRule, role: ManagedRole): Promise<boolean> {
    if (!rule.cells?.length) return false;
    // Та же функция, что считает возможности для /me/permissions: разойдись
    // они — интерфейс показывал бы кнопку, которую сервер не пускает, или
    // наоборот. Политика expandableBy учтена внутри.
    return judgeRuleCells(rule, await store.get(), role).expanded;
  }

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

    // in-handler: сама проверка — внутри обработчика, после SELECT. Здесь
    // решается только одно: пускать ли запрос ДО обработчика. Пускаем, если
    // администратор явно расширил хоть одну из возможных ячеек маршрута —
    // иначе allow-list отсечёт монитора раньше, чем станет известно, создание
    // это или правка, и выданное право осталось бы мёртвым.
    //
    // Точность от этого не страдает: assertPermission внутри хендлера сверит
    // уже конкретную пару и откажет, если расширена была соседняя (выдан
    // только create, а запись существует → 403 на ветке edit).
    if (rule?.kind === 'in-handler') {
      if (await anyCellExpanded(rule, req.user!.role as ManagedRole)) {
        req.permissionExpanded = true;
      }
      return;
    }

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
      if (
        isExpanded(overrides, req.user!.role, rule.page, rule.action) &&
        expansionOpensRoute(rule, req.user!.role as ManagedRole)
      ) {
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
    if (isAllowed(overrides, req.user!.role, page, action)) {
      // Как и у static: снимаем allow-list только на явно выданном праве.
      // Instance-preHandler выполняется раньше route-preHandler (там сидит
      // app.authorize), поэтому отметка успевает — это закреплено тестом.
      if (
        isExpanded(overrides, req.user!.role, page, action) &&
        expansionOpensRoute(rule, req.user!.role as ManagedRole)
      ) {
        req.permissionExpanded = true;
      }
      return;
    }
    return deny(req, reply, page, action);
  });
});
