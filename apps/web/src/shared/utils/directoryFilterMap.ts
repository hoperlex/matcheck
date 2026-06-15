import { isPlaceholderInn } from '@matcheck/contracts';

// Безопасный маппинг «id справочника заказчика → set операционных
// counterparties.id с тем же нормализованным ИНН». Зачем нужен:
//
// В разделе «Операции» пользователь выбирает подрядчика/поставщика из
// dropdown'а, опции которого приходят из справочников заказчика
// (`customer_counterparties` / `suppliers`) — чтобы UI был
// консистентен со вкладками «Справочники → Контрагенты / Поставщики».
//
// Но FK операций (deliveries.contractorId, shipments.supplierId и т.п.)
// исторически ссылаются на legacy-таблицу `counterparties`, а не на эти
// справочники. Если просто скормить customer_counterparty.id в
// `filters.contractorIds`, фильтр ничего не найдёт.
//
// Решение: связываем два списка по ИНН — это стабильный бизнес-ключ,
// одинаковый и в справочнике, и в операционной таблице (см. функцию
// findOrCreateCounterparty на бэке — она при импорте УПД ищет/создаёт
// counterparty по ИНН из распознанного документа). Маппинг строится в
// памяти браузера, БД и API не задеты.

type WithInn = { id: string; inn: string | null | undefined };

/**
 * Нормализует ИНН для сравнения: убирает все нецифровые символы и пробелы.
 * Возвращает null, если получилась пустая строка или плейсхолдер «000…».
 *
 * Плейсхолдеры — это контрагенты, созданные «на лету» без указания ИНН
 * ([counterparties.ts:50] PLACEHOLDER_INN_PREFIX). У них всех ИНН вида
 * «00000000-…», и матчить их по ИНН нельзя — иначе все безымянные
 * слились бы в один.
 */
export function normalizeInnForMatch(inn: string | null | undefined): string | null {
  if (!inn) return null;
  const cleaned = inn.replace(/\D/g, '');
  if (!cleaned) return null;
  if (isPlaceholderInn(cleaned)) return null;
  return cleaned;
}

/**
 * Строит Map<directoryId, Set<operationalId>>.
 *
 * directory — справочник заказчика (`customer_counterparties` или `suppliers`).
 * operational — operational counterparties (всё, что есть в `counterparties`).
 *
 * Для каждой записи справочника: по нормализованному ИНН находит все
 * операционные counterparties с тем же ИНН и кладёт их id в set.
 *
 * Если у записи справочника ИНН placeholder/пустой — она получает пустой set
 * (через неё фильтровать нельзя; в UI выбрать такую опцию пользователь всё
 * равно может, фильтр просто не вернёт ничего).
 */
export function buildInnMatchMap(
  directory: ReadonlyArray<WithInn>,
  operational: ReadonlyArray<WithInn>,
): Map<string, Set<string>> {
  // operational индексируем по нормализованному ИНН — O(operational + directory).
  const byInn = new Map<string, Set<string>>();
  for (const op of operational) {
    const key = normalizeInnForMatch(op.inn);
    if (!key) continue;
    let set = byInn.get(key);
    if (!set) {
      set = new Set<string>();
      byInn.set(key, set);
    }
    set.add(op.id);
  }

  const result = new Map<string, Set<string>>();
  for (const dir of directory) {
    const key = normalizeInnForMatch(dir.inn);
    result.set(dir.id, key ? byInn.get(key) ?? new Set<string>() : new Set<string>());
  }
  return result;
}

/**
 * Расширяет выбранные id справочника в множество операционных counterparty.id,
 * по которым реально нужно фильтровать строки операций. Пустое множество на
 * выходе означает: «ни одна операция не соответствует выбранным
 * подрядчикам/поставщикам» (включая случай, когда у выбранных записей
 * справочника нет ИНН или ИНН — placeholder).
 */
export function expandDirectoryIdsToOperational(
  selectedDirectoryIds: ReadonlyArray<string>,
  matchMap: Map<string, Set<string>>,
): Set<string> {
  const result = new Set<string>();
  for (const id of selectedDirectoryIds) {
    const set = matchMap.get(id);
    if (!set) continue;
    for (const opId of set) result.add(opId);
  }
  return result;
}
