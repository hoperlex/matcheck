import type { FastifyInstance } from 'fastify';
import {
  MePermissionsResponseSchema,
  type PagePermissions,
  type PageId,
} from '@matcheck/contracts';
import { asZod } from '../lib/fastify.js';
import { effectiveFor } from '../lib/permissions/matrix.js';

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

      // При выключенном enforcement отдаём ДЕФОЛТЫ, игнорируя сохранённые
      // overrides. Без этого «выключить флаг и перезапустить» не было бы
      // полным откатом: сервер уже ничего не запрещает, а интерфейс всё ещё
      // прятал бы кнопки по настройкам, которые не применяются.
      const overrides = app.permissions.enforced
        ? await app.permissions.get()
        : new Map<string, PagePermissions>();

      return {
        // Фронт сверяет userId с текущим пользователем перед записью в стор:
        // запрос мог стартовать до смены пользователя во вкладке и
        // завершиться после неё.
        userId: user.id,
        role: user.role,
        enforced: app.permissions.enforced,
        pages: effectiveFor(overrides, user.role) as Record<PageId, PagePermissions>,
      };
    },
  );
}
