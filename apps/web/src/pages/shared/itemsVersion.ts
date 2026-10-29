/**
 * Версия операции, которой соответствуют строки формы карточки.
 *
 * Сохранение и отвязка с удалением отправляют на сервер именно её, а не версию
 * последнего поллинга: поллинг раз в 5 с обновляет `loadedDelivery.version`, но
 * строки формы перечитывает только при первой загрузке (приёмка ещё — в
 * `confirmed_mol` без несохранённых правок). С версией поллинга устаревшая
 * форма проходила проверку на сервере и возвращала строки, удалённые в другой
 * вкладке.
 *
 * Привязка и отвязка меняют строки формы частично — домерживают или убирают
 * строки одного документа. Такая форма совпадает с сервером, только если между
 * её снимком и действием никто ничего не менял. Каждое действие поднимает
 * версию ровно на 1, поэтому признак — ответ сервера на `текущая + 1`. При любом
 * другом ответе версия остаётся прежней: форма устарела, и следующее сохранение
 * или удаление честно получит 409.
 */
export function advanceItemsVersion(current: number | null, serverVersion: number): number | null {
  return current !== null && serverVersion === current + 1 ? serverVersion : current;
}

/** Сколько строк формы в блоке каждого документа — по тому, что видит человек. */
export function countItemsByDocument(
  items: readonly { sourceDocumentId: string | null }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const it of items) {
    if (it.sourceDocumentId)
      counts.set(it.sourceDocumentId, (counts.get(it.sourceDocumentId) ?? 0) + 1);
  }
  return counts;
}
