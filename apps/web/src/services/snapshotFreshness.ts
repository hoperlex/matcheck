/**
 * Защита IndexedDB от записи устаревшего серверного snapshot'а.
 *
 * Детальные запросы приёмки/отгрузки поллятся раз в 5 секунд и безусловно
 * пишут ответ в IDB. GET может стартовать до PATCH комментария, а вернуться
 * после него — и затереть свежую правку старым DTO. cancelQueries + AbortSignal
 * закрывают основной сценарий, эта проверка — страховка для запросов, которые
 * всё же успели вернуться.
 *
 * Порядок сравнения: сначала version, при равных версиях — updatedAt. Второй
 * шаг здесь не косметика: PATCH /:id/comment намеренно НЕ бампает version
 * (иначе мобильный клиент ловил бы 409 OCC и парковал мутации), так что версия
 * у свежего и устаревшего снимка совпадает, и решает только время.
 */

export interface SnapshotStamp {
  version: number;
  updatedAt: string;
}

export function isStaleSnapshot(
  existing: SnapshotStamp | null | undefined,
  incoming: SnapshotStamp,
): boolean {
  if (!existing) return false;
  if (existing.version > incoming.version) return true;
  if (existing.version < incoming.version) return false;
  const prev = Date.parse(existing.updatedAt);
  const next = Date.parse(incoming.updatedAt);
  // Неразбираемая дата — не блокируем запись: лучше обновить, чем застрять
  // на старом снимке из-за кривого значения.
  if (Number.isNaN(prev) || Number.isNaN(next)) return false;
  return prev > next;
}
