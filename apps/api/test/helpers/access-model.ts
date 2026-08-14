import type { ManagedRole } from '@matcheck/contracts';
import { routeKey } from '../../src/lib/permissions/route-map.js';
import { INLINE_ROLE_ACCESS } from '../fixtures/permissions-baseline.js';
import type { RouteRow } from './route-inventory.js';

/**
 * Эталон «как было бы БЕЗ матрицы прав» — общий для тестов, которые
 * доказывают, что фича ничего не меняет на дефолтах.
 *
 * Раньше эта модель жила внутри permissions-defaults и не включала read-only
 * гард в его нынешнем виде: гард был отдельным хардкодом в server.ts, и любой
 * тест воспроизводил его копией. После переезда гарда в плагин копия обязана
 * жить в одном месте — иначе наборы разойдутся, и ошибку заметит не CI, а бой.
 */

export const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Роли, которым read-only-гард запрещает мутации (кроме самообслуживания).
 *
 * Копия рантайм-списка из src/lib/roles.ts — намеренная: модель обязана
 * описывать поведение независимо, и её расхождение с рантаймом должно быть
 * видно как падение теста, а не «сойтись» через общий импорт.
 */
export const WEB_ONLY_ROLES: ManagedRole[] = ['contractor', 'monitor', 'observer'];

/**
 * Единственные мутации, оставленные монитору ДО матрицы — отметка проверки.
 * Это baseline-поведение: ровно так гард работает и сейчас при
 * PERMISSIONS_ENFORCE=0.
 */
export const MONITOR_WRITE_ROUTES = new Set([
  '/api/v1/deliveries/:id/review',
  '/api/v1/shipments/:id/review',
]);

/** Отбивает ли read-only-гард этот запрос при выключенной матрице. */
export function guardBlocks(role: ManagedRole, r: RouteRow): boolean {
  if (!WEB_ONLY_ROLES.includes(role)) return false;
  if (!MUTATING.has(r.method.toUpperCase())) return false;
  if (r.url.startsWith('/api/v1/auth/')) return false;
  return !(role === 'monitor' && MONITOR_WRITE_ROUTES.has(r.url));
}

/**
 * Известен ли для маршрута baseline «кто имеет доступ сегодня».
 *
 * Не известен ровно у публичного периметра: login, refresh, страница по
 * share-токену. Там `req.user` не заполняется вовсе — ни матрице, ни гарду
 * проверять нечего, и ролей у маршрута нет по определению. Такие маршруты в
 * сравнении не участвуют; что их немного и все они действительно публичные,
 * проверяет отдельный тест — иначе этим фильтром можно было бы незаметно
 * вывести из-под проверки что-то важное.
 */
export function hasBaseline(r: RouteRow): boolean {
  return r.roles.length > 0 || INLINE_ROLE_ACCESS[routeKey(r.method, r.url)] !== undefined;
}

/**
 * Пропускает ли роль ВСЁ, что стоит ПОСЛЕ гарда: allow-list маршрута и
 * inline-проверка внутри хендлера.
 *
 * Вынесено отдельно от `apiAllows` не для красоты. Модель системы с включённой
 * матрицей заканчивалась вызовом `apiAllows`, а тот внутри повторно применял
 * СТАРЫЙ гард — и излишне разрешающий новый гард оказался бы скрыт: запрос
 * прошёл бы модель нового, а затем его молча остановил бы старый внутри
 * baseline. Сравнение перестало бы что-либо доказывать ровно в том случае,
 * ради которого писалось.
 *
 * Бросает, если маршрут не описан ни allow-list'ом, ни фикстурой: неполный
 * baseline хуже отсутствующего — он создаёт видимость проверки.
 */
export function routeAllows(role: ManagedRole, r: RouteRow): boolean {
  if (r.roles.length > 0) return (r.roles as string[]).includes(role);

  const inline = INLINE_ROLE_ACCESS[routeKey(r.method, r.url)];
  if (inline) return inline.includes(role);

  throw new Error(
    `Маршрут «${routeKey(r.method, r.url)}» объявлен без app.authorize(...) и отсутствует в ` +
      'INLINE_ROLE_ACCESS. Добавьте его в test/fixtures/permissions-baseline.ts с указанием ' +
      'фактических ролей — иначе baseline перестаёт быть полным.',
  );
}

/**
 * Имеет ли роль доступ к маршруту СЕГОДНЯ — как если бы матрицы не было вовсе:
 * старый гард → allow-list → inline.
 */
export function apiAllows(role: ManagedRole, r: RouteRow): boolean {
  if (guardBlocks(role, r)) return false;
  return routeAllows(role, r);
}
