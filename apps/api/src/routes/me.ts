import type { FastifyInstance } from 'fastify';
import {
  MePermissionsResponseSchema,
  type PagePermissions,
  type PageId,
} from '@matcheck/contracts';
import { asZod } from '../lib/fastify.js';
import { effectiveFor } from '../lib/permissions/matrix.js';
import { capabilitiesFor, effectiveOverrides } from '../lib/permissions/capabilities.js';

/**
 * Эффективные права текущего пользователя.
 *
 * Почему отдельный маршрут, а не поле в UserDto: UserDto и LoginResponse
 * зарегистрированы в openapi (packages/contracts/src/openapi/registry.ts), и
 * из них генерируется Kotlin-клиент мобильного приложения. Новое поле там —
 * дифф контракта, пересборка клиента и риск строгого парсера ради данных,
 * которые планшету не нужны вовсе. Здесь влияние на мобильный контракт
 * нулевое.
 *
 * Маршрут помечен в реестре прав как always: закрыв его, мы лишили бы UI
 * возможности узнать собственные права — и он навсегда остался бы на
 * дефолтах.
 */
export async function meRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  app.get(
    '/api/v1/me/permissions',
    {
      preHandler: [app.authenticate],
      schema: { response: { 200: MePermissionsResponseSchema } },
    },
    async (req) => {
      const user = req.user!;

      // При выключенном enforcement — дефолты (см. effectiveOverrides). Тем же
      // помощником сервер повторяет решения интерфейса в фильтрах списков.
      const overrides = await effectiveOverrides(app.permissions);

      return {
        // Фронт сверяет userId с текущим пользователем перед записью в стор:
        // запрос мог стартовать до смены пользователя во вкладке и
        // завершиться после неё.
        userId: user.id,
        role: user.role,
        enforced: app.permissions.enforced,
        pages: effectiveFor(overrides, user.role) as Record<PageId, PagePermissions>,
        // Возможности считаются от тех же overrides, что и страницы: при
        // выключенном enforcement — от дефолтов, то есть повторяют сегодняшний
        // доступ. Разъехаться эти два поля не могут.
        capabilities: capabilitiesFor(overrides, user.role, app.permissions.routeRoles),
        // Отпечаток authz-состояния: роль и обе привязки скоупа. Значение
        // непрозрачно для клиента — он только сравнивает его с прошлым.
        authzRevision: [user.role, user.siteId ?? '-', user.contractorCustomerId ?? '-'].join(':'),
      };
    },
  );
}
