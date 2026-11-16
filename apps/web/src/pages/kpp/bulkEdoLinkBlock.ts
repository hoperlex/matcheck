import type { Delivery } from '@matcheck/contracts';

/** Сколько приёмок за раз в групповой привязке УПД — тот же предел, что у сервера. */
export const BULK_EDO_MAX = 50;

/**
 * Почему одну УПД нельзя привязать к отмеченным приёмкам; null — можно.
 * Сервер проверит то же самое, здесь — чтобы кнопка не обещала невозможного.
 *
 * Отдельным модулем: тем же правилом пользуются список «Принятые» и привязка
 * ко всей группе приёмок (GroupEdoLinkFlow).
 */
export function bulkEdoLinkBlock(
  rows: readonly Pick<Delivery, 'siteId' | 'pendingDeletionAt' | 'sourceShipmentId'>[],
): string | null {
  if (rows.length === 0) return 'Отметьте приёмки';
  if (rows.length > BULK_EDO_MAX) return `Не больше ${BULK_EDO_MAX} приёмок за раз`;
  if (new Set(rows.map((r) => r.siteId)).size > 1)
    return 'Выбраны приёмки разных объектов: одна УПД привязывается к приёмкам одного объекта';
  if (rows.some((r) => r.pendingDeletionAt)) return 'Среди отмеченных есть помеченные на удаление';
  if (rows.some((r) => r.sourceShipmentId))
    return 'Среди отмеченных есть приёмки, созданные из отгрузки';
  return null;
}
