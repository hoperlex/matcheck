import type { ManagedRole, UserRole } from '@matcheck/contracts';
import type { OverrideMap } from './matrix.js';
import { judgeRuleCells } from './rule-cells.js';
import { ROUTE_PERMISSIONS, type RouteRule } from './route-map.js';
import type { RouteRolesMap } from './route-roles.js';

/**
 * Возможности (capabilities) текущего пользователя.
 *
 * Зачем поверх матрицы. Ячейка «страница × действие» не равна одной
 * возможности: у `operations.*:edit` четыре маршрута с разными allow-list —
 * отметка проверки, флаги, привязка УПД, ссылка-шаринг. Интерфейс, спрашивающий
 * только `can(page, action)`, нарисует кнопку «Флаги» инспектору (у которого
 * базовый edit есть, а маршрут закрыт) — и она ответит 403.
 *
 * Поэтому сервер отдаёт вебу ещё и плоский список имён: «что реально можно».
 * Считается здесь, в одном месте, где сходятся матрица (что разрешено роли) и
 * рантайм-инвентарь allow-list (кого пускает сам маршрут). Дублировать эту
 * логику на фронте нельзя — разъедется при первом же изменении allow-list.
 */

/**
 * Доступен ли роли конкретный маршрут — та же цепочка проверок, что в рантайме,
 * но без запроса.
 *
 * Порядок повторяет боевой путь: сначала матрица (хук прав), затем allow-list
 * (app.authorize). Расширение снимает allow-list только если политика маршрута
 * пускает эту роль — см. expandableBy в route-map.
 */
function routeAllowsRole(
  rule: RouteRule,
  routeRoles: RouteRolesMap,
  key: string,
  overrides: OverrideMap,
  role: UserRole,
): boolean {
  // admin вне матрицы и вне allow-list'ов — ему доступно всё.
  if (role === 'admin') return true;

  // 1. Матрица — через общую с рантайм-хуком функцию, чтобы «что разрешено»
  //    считалось одинаково. Она же покрывает dynamic/in-handler: у маршрутов
  //    фото и upsert ячеек несколько, и раньше они здесь не рассматривались
  //    вовсе — выданное монитору право не давало ему capability.
  const verdict = judgeRuleCells(rule, overrides, role as ManagedRole);
  if (!verdict.allowed) return false;
  const expanded = verdict.expanded;

  // legacy: роли из списка идут мимо матрицы целиком и мимо allow-list —
  // их доступ исторический.
  if (rule.kind === 'legacy' && rule.roles.includes(role as ManagedRole)) return true;

  // 2. Allow-list маршрута.
  const roles = routeRoles.get(key);
  if (!roles || roles.length === 0) {
    // Маршрута нет в инвентаре: либо у него нет authorize (роли проверяются
    // внутри хендлера — DELETE /deliveries/:id), либо он вообще не
    // зарегистрирован. Отличить снаружи нельзя, поэтому возможность НЕ
    // подтверждаем: «не знаем» здесь обязано значить «не показываем кнопку», а
    // не «разрешено». Обратный выбор давал бы ложное разрешение всякий раз,
    // когда маршрут выпал из инвентаря, — то есть ровно в случае поломки.
    //
    // На боевом это не сужает ничего: инвариант в тестах требует, чтобы у
    // каждого маршрута с capability allow-list был известен.
    return false;
  }
  return expanded || roles.includes(role);
}

/**
 * Имена возможностей, доступных роли.
 *
 * Возможность считается доступной, если доступен ХОТЬ ОДИН из её маршрутов:
 * `operations.share.manage` держат создание ссылки и список, и наличие любого
 * из них означает, что раздел share пользователю показывать имеет смысл.
 */
export function capabilitiesFor(
  overrides: OverrideMap,
  role: UserRole,
  routeRoles: RouteRolesMap,
): string[] {
  const out = new Set<string>();
  for (const [key, rule] of ROUTE_PERMISSIONS) {
    if (!rule.capability) continue;
    if (out.has(rule.capability)) continue;
    if (routeAllowsRole(rule, routeRoles, key, overrides, role)) out.add(rule.capability);
  }
  return [...out].sort();
}

/** Все объявленные в реестре имена — для тестов и для отладки. */
export function declaredCapabilities(): string[] {
  const out = new Set<string>();
  for (const rule of ROUTE_PERMISSIONS.values()) {
    if (rule.capability) out.add(rule.capability);
  }
  return [...out].sort();
}
