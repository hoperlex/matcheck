import type { FastifyInstance, RouteOptions } from 'fastify';
import type { UserRole } from '@matcheck/contracts';
import { ALLOWED_ROLES, type AuthorizeGuard } from '../../plugins/auth.js';
import { routeKey } from './route-map.js';

/**
 * Рантайм-инвентарь «маршрут → allow-list ролей».
 *
 * Зачем. Ячейка матрицы не равна одной возможности: за парой «страница ×
 * действие» стоят маршруты с РАЗНЫМИ списками ролей. Чтобы интерфейс не рисовал
 * кнопки, дающие 403, сервер обязан знать фактический allow-list каждого
 * маршрута — а не только то, что разрешает матрица.
 *
 * Почему собираем, а не перечисляем в реестре прав. Вторая копия ролей
 * разъезжалась бы с роутами молча: достаточно поменять authorize у одного
 * маршрута и забыть про список. Здесь источник один — сам вызов app.authorize,
 * который помечает возвращаемого стража символом ALLOWED_ROLES.
 *
 * Тестовый test/helpers/route-inventory.ts снимает те же данные независимым
 * способом (подменяет декоратор целиком) — он остаётся перекрёстной проверкой,
 * а не дублем.
 *
 * Пустой массив = маршрут без authorize. Это НЕ «доступен всем»: у части
 * маршрутов (DELETE /deliveries/:id) роли проверяются внутри хендлера, и
 * вычислить их снаружи нельзя. Отличать «нет ограничений» от «ограничение
 * внутри» вызывающий обязан сам — см. capabilityFor в capabilities.ts.
 */
export type RouteRolesMap = ReadonlyMap<string, UserRole[]>;

export function collectRouteRoles(app: FastifyInstance): RouteRolesMap {
  const map = new Map<string, UserRole[]>();

  app.addHook('onRoute', (route: RouteOptions) => {
    const handlers = [route.preHandler, route.onRequest].flatMap((h) =>
      Array.isArray(h) ? h : h ? [h] : [],
    );
    const roles = handlers.flatMap(
      (h) => (h as AuthorizeGuard)[ALLOWED_ROLES] ?? [],
    );
    if (roles.length === 0) return;
    const key = routeKey(
      Array.isArray(route.method) ? (route.method[0] ?? 'GET') : route.method,
      route.url,
    );
    // Один и тот же ключ может прийти дважды (HEAD нормализуется в GET) —
    // объединяем, а не перезаписываем: иначе вторая регистрация сузила бы
    // список до пустого.
    const prev = map.get(key);
    map.set(key, prev ? [...new Set([...prev, ...roles])] : roles);
  });

  return map;
}
