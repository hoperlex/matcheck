/**
 * Визуальная группировка строк «машины» в списке документов.
 *
 * Одна загрузка = одна машина = несколько УПД. Сервер об этом знает
 * (`groupId` — корневой пакет), но в таблице документы стояли обычными
 * строками, ничем не связанными: менеджер не видел, что три накладные приехали
 * вместе, а инспектор на планшете видел их одной карточкой.
 *
 * Здесь только представление: строки помечаются общим цветом и подтягиваются
 * друг к другу. Ни состав данных, ни счётчики вкладок, ни экспорт не меняются.
 */

/**
 * Метка машины для строки списка.
 *
 * `portalGroupId` вперёд, потому что он шире: планшетный `groupId` пуст, пока
 * пачка не собрана и не опубликована, и совсем пуст после отката сборки. Для
 * менеджера машина существует с момента загрузки — иначе он видит россыпь
 * строк и не понимает, что они приехали одним рейсом.
 *
 * Оба поля необязательные: у документов из почты и внутренних загрузок машины
 * нет вовсе.
 */
export function documentGroupKey(row: {
  groupId?: string | null;
  portalGroupId?: string | null;
}): string | null {
  return row.portalGroupId ?? row.groupId ?? null;
}

/**
 * Строки одной машины — подряд, с сохранением исходного порядка.
 *
 * Стабильная кластеризация, а не сортировка: позицию кластера задаёт ПЕРВОЕ
 * появление его groupId, остальные члены подтягиваются следом. Поэтому список,
 * уже отсортированный по дате, остаётся отсортированным — просто разорванная
 * машина собирается вместе.
 *
 * Возвращает НОВЫЙ массив. Мутировать вход нельзя: сюда приходит массив из
 * кэша React Query, и `.sort()` по месту рассинхронизировал бы кэш с сервером.
 */
export function clusterRowsByGroup<T extends { groupId?: string | null; portalGroupId?: string | null }>(
  rows: readonly T[],
): T[] {
  const clusters = new Map<string, T[]>();
  const order: Array<{ groupId: string | null; row: T }> = [];

  for (const row of rows) {
    const groupId = documentGroupKey(row);
    if (!groupId) {
      order.push({ groupId: null, row });
      continue;
    }
    const existing = clusters.get(groupId);
    if (existing) {
      existing.push(row);
      continue;
    }
    clusters.set(groupId, [row]);
    // Место кластера — там, где встретился его первый документ.
    order.push({ groupId, row });
  }

  return order.flatMap((entry) =>
    entry.groupId === null ? [entry.row] : (clusters.get(entry.groupId) ?? [entry.row]),
  );
}

/**
 * Палитра меток. Шесть оттенков: больше глаз в таблице не различает, а строка
 * со статусом «не распознано» и без того выделена цветом — метка машины не
 * должна её перекрикивать.
 *
 * Экспортируется, чтобы CSS-правила генерировались из этого же списка:
 * разъедься палитра со счётчиком — часть машин осталась бы без полосы.
 */
export const GROUP_COLORS = ['#1677ff', '#52c41a', '#fa8c16', '#722ed1', '#13c2c2', '#eb2f96'] as const;

export const GROUP_COLOR_COUNT = GROUP_COLORS.length;

/** Класс строки машины либо пустая строка для одиночных документов. */
export function groupRowClass(groupId?: string | null): string {
  if (!groupId) return '';
  return `matcheck-doc-group-${groupColorIndex(groupId)}`;
}

/**
 * Индекс цвета по groupId — детерминированно.
 *
 * Именно по id, а не по позиции в списке: при пагинации, фильтре или обновлении
 * данных позиция меняется, и цвет машины прыгал бы на каждой перерисовке.
 */
export function groupColorIndex(groupId: string): number {
  let hash = 0;
  for (let i = 0; i < groupId.length; i++) {
    // Классический polynomial rolling hash: | 0 держит результат в int32.
    hash = (hash * 31 + groupId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % GROUP_COLOR_COUNT;
}
