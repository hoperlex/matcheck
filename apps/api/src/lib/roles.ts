import type { UserRole } from '@matcheck/contracts';

/**
 * Роли, живущие только в веб-портале.
 *
 * Мобильный клиент не обрабатывает 403 ни на одном экране — он залипает молча,
 * без сообщения пользователю. Поэтому такие роли отсекаются на входе
 * (routes/auth.ts), а не на первом же закрытом маршруте: web-token у планшета
 * не должен появляться вовсе.
 *
 * Список был продублирован в трёх местах (логин, смена роли, read-only-гард) и
 * разъезжался при каждом добавлении роли — отсюда общий модуль. Копия в
 * test/helpers/access-model.ts оставлена намеренно: она моделирует поведение
 * независимо, и её расхождение с этим списком обязано быть видно как падение
 * теста, а не как общий импорт, который «сходится» сам с собой.
 */
export const WEB_ONLY_ROLES: readonly UserRole[] = ['contractor', 'monitor', 'observer'];

export function isWebOnlyRole(role: string): boolean {
  return (WEB_ONLY_ROLES as readonly string[]).includes(role);
}

/**
 * Роли без исторического доступа: в дефолте у них нет ни одного права, всё
 * выдаётся галочками матрицы. Смена роли в такую или из такой обязана
 * инвалидировать сессии — набор доступного меняется целиком, а не в деталях.
 */
export const MATRIX_ONLY_ROLES: readonly UserRole[] = ['observer'];

export function isMatrixOnlyRole(role: string): boolean {
  return (MATRIX_ONLY_ROLES as readonly string[]).includes(role);
}
