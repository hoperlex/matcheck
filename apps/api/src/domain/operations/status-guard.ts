/**
 * Защита от downgrade жизненного статуса приёмки/отгрузки при обычном
 * upsert через POST /deliveries и POST /shipments.
 *
 * История бага: мобильное приложение завершает 1 этап → серверный
 * статус становится `filled` (для shipment — `shipped`). Менеджер на
 * портале открывает запись, что-то правит (материалы, фото, УПД).
 * Веб-портал собирает payload из локального IDB-snapshot'а, в котором
 * статус ещё может быть `not_filled` (stale). Сервер охотно понижает
 * `filled → not_filled`. Мобильный Stage 2 фильтрует записи только
 * со статусом `filled` — после downgrade запись пропадает из 2 этапа,
 * инспектор её больше не видит, не может подтвердить МОЛ.
 *
 * Решение — серверная защита от downgrade. НЕ полагаемся на то, что
 * веб когда-нибудь будет идеально собирать payload: defense-in-depth.
 *
 * Разрешённые переходы (через обычный upsert):
 *   not_filled → not_filled         (новая запись без материалов)
 *   not_filled → filled / shipped   (появились материалы / УПД)
 *   not_filled → confirmed_mol      (мобила сразу финализирует)
 *   filled / shipped → confirmed_mol (МОЛ подтвердил)
 *   confirmed_mol → confirmed_mol   (повторное «Сохранить» в финал-статусе)
 *
 * Запрещённые (откатываемся на existing):
 *   filled / shipped → not_filled
 *   confirmed_mol → что-либо ниже
 *
 * Откат не блокирует операцию — просто сохраняем data-поля без
 * понижения статуса. Если в будущем понадобится «вернуть в 1 этап»,
 * это должно быть отдельным явным действием с правами админа,
 * а не побочным эффектом Сохранить.
 */

/**
 * Жизненные статусы delivery в порядке возрастания.
 * Цифры внутри функции игнорируем — сравнение по коду.
 */
export type DeliveryStatusCode = 'not_filled' | 'filled' | 'confirmed_mol';

/**
 * Жизненные статусы shipment в порядке возрастания.
 */
export type ShipmentStatusCode = 'not_filled' | 'shipped' | 'confirmed_mol';

/**
 * Возвращает true, если переход из existing в requested — это
 * запрещённый downgrade жизненного статуса. true = НЕ применять
 * requested, оставить existing.
 *
 * Чистая функция, без побочных эффектов. Тестируется без БД.
 */
export function isDeliveryDowngrade(
  existing: DeliveryStatusCode | string,
  requested: DeliveryStatusCode | string,
): boolean {
  // confirmed_mol защищён от ВСЕГО ниже (это была первоначальная защита).
  if (existing === 'confirmed_mol' && requested !== 'confirmed_mol') return true;
  // filled защищён от downgrade в not_filled (новая защита).
  if (existing === 'filled' && requested === 'not_filled') return true;
  return false;
}

/**
 * Симметрично для shipment. Жизненный путь: not_filled → shipped → confirmed_mol.
 * Не путать с shipments.kind / shipments.purpose — это другое поле.
 */
export function isShipmentDowngrade(
  existing: ShipmentStatusCode | string,
  requested: ShipmentStatusCode | string,
): boolean {
  if (existing === 'confirmed_mol' && requested !== 'confirmed_mol') return true;
  if (existing === 'shipped' && requested === 'not_filled') return true;
  return false;
}
