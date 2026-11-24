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
 * `isAnchor` — какие строки вправе задавать место кластера. В «Документах»
 * это документы, а не принятые файлы: файлы идут в начале списка, и застрявший
 * навсегда файл иначе тянул бы наверх всю старую поставку. Кластер без якорных
 * строк стоит на месте своей первой строки. Без предиката якорь — любая строка.
 * Правило то же, что у сервера (apps/api/.../group-paging.ts): иначе страница
 * собралась бы одним порядком, а нарисовалась другим.
 *
 * Возвращает НОВЫЙ массив. Мутировать вход нельзя: сюда приходит массив из
 * кэша React Query, и `.sort()` по месту рассинхронизировал бы кэш с сервером.
 */
export function clusterRowsByGroup<T extends { groupId?: string | null; portalGroupId?: string | null }>(
  rows: readonly T[],
  isAnchor?: (row: T) => boolean,
): T[] {
  // Запись — одиночная строка или кластер; place — позиция в исходном списке.
  type Entry = { place: number; rows: T[]; anchored: boolean };
  const clusters = new Map<string, Entry>();
  const entries: Entry[] = [];

  rows.forEach((row, index) => {
    const groupId = documentGroupKey(row);
    if (!groupId) {
      entries.push({ place: index, rows: [row], anchored: true });
      return;
    }
    const anchor = isAnchor ? isAnchor(row) : true;
    const existing = clusters.get(groupId);
    if (existing) {
      existing.rows.push(row);
      if (anchor && !existing.anchored) {
        existing.place = index;
        existing.anchored = true;
      }
      return;
    }
    const entry: Entry = { place: index, rows: [row], anchored: anchor };
    clusters.set(groupId, entry);
    entries.push(entry);
  });

  // Места различны (у каждой записи — индекс своей строки): порядок однозначен.
  return entries.sort((a, b) => a.place - b.place).flatMap((entry) => entry.rows);
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
