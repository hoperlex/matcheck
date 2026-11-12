/**
 * Происхождение позиций приёмки при деструктивном upsert.
 *
 * Upsert позиций устроен как DELETE + INSERT: клиент присылает полный список,
 * сервер переписывает его целиком. Для происхождения (`source_document_id`)
 * это опасно вдвойне:
 *
 *  1. строки вставляются заново, поэтому сохранённое значение нужно перенести
 *     явно — иначе первый же upsert со старого планшета обнулит атрибуцию всей
 *     приёмки;
 *  2. брать значение из запроса нельзя: клиент не должен уметь переписать
 *     происхождение существующей строки, иначе достаточно одного устаревшего
 *     устройства, чтобы приписать позиции чужому документу.
 *
 * Отсюда правило: если у строки, которая уже есть в приёмке, происхождение
 * записано — оно берётся из БД и клиентом не переписывается. Если строка есть,
 * но привязки у неё НЕТ, запрет защищать нечего: принимается присланное — как и
 * для новой строки, и с тем же ограничением, что документ действительно привязан
 * к этой приёмке.
 *
 * Сопоставление идёт тремя шагами, от самого надёжного ключа к самому слабому:
 *
 *   1.   по `id` строки приёмки;
 *   1.5. по `sourceDocumentItemId` — ссылке на позицию документа;
 *   2.   по (название, единица, номер строки).
 *
 * Шаг 1.5 нужен из-за правки названия. `id` позиции пересоздаётся каждым
 * upsert (в БД пишет Postgres), поэтому карточка, открытая до сохранения с
 * планшета, присылает устаревший id — шаг 1 промахивается. Дальше строку ловил
 * только ключ с названием, а при переименовании промахивается и он: строка
 * теряла привязку к УПД ровно в тот момент, когда человек исправлял опечатку
 * распознавания. Ссылка на позицию документа переименование переживает.
 *
 * Запасные сопоставления (1.5 и 2) применяются ТОЛЬКО при однозначном
 * совпадении: у клиента могли смениться id (офлайн-черновик пережил
 * переразбор), но угадывать нельзя — номера строк и материалы в разных УПД
 * совпадают сплошь и рядом. Неоднозначность → null.
 *
 * Ни один шаг не берёт значение происхождения из запроса: и на 1.5 результат
 * читается из строки БД. Максимум, чего добьётся клиент подставленной ссылкой,
 * — наследование происхождения ДРУГОЙ строки той же приёмки, что достижимо и
 * ключом с названием.
 */

export type ItemOrigin = {
  sourceDocumentId: string | null;
  sourceDocumentItemId: string | null;
};

export type ExistingItemRow = {
  id: string;
  nameRaw: string;
  unit: string;
  lineNo: number;
  sourceDocumentId: string | null;
  sourceDocumentItemId: string | null;
};

export type IncomingItem = {
  id?: string | null;
  nameRaw: string;
  unit: string;
  lineNo: number;
  sourceDocumentId?: string | null;
  sourceDocumentItemId?: string | null;
};

const EMPTY: ItemOrigin = { sourceDocumentId: null, sourceDocumentItemId: null };

/**
 * Название в виде, пригодном для сравнения строк.
 *
 * Экспортируется, чтобы разбор накопленных потерь (scripts/report-unlinked-
 * delivery-items.ts) сопоставлял строки ровно так же, как это делает upsert.
 * Разные нормализации дали бы отчёт, который не совпадает с поведением сервера.
 */
export function normalizeItemNameForMatch(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Ключ запасного сопоставления: то, что человек видит в строке, + её номер. */
function fallbackKey(item: { nameRaw: string; unit: string; lineNo: number }): string {
  const unit = item.unit.trim().toLowerCase();
  return `${normalizeItemNameForMatch(item.nameRaw)}|${unit}|${item.lineNo}`;
}

/** Единственное значение ключа с обеих сторон — иначе сопоставлять нельзя. */
function pickUnique<T>(candidates: T[] | undefined, incomingCount: number | undefined): T | null {
  if (!candidates || candidates.length !== 1) return null;
  if (incomingCount !== 1) return null;
  return candidates[0]!;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = map.get(key(row));
    if (bucket) bucket.push(row);
    else map.set(key(row), [row]);
  }
  return map;
}

function countBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const k = key(row);
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
}

/** Сколько строк сопоставлено только по названию и сколько отвергнуто как неоднозначные. */
export type NameMatchStats = { matched: number; ambiguous: number };

/**
 * Возвращает происхождение для каждой входящей позиции — в том же порядке.
 *
 * @param linkedDocumentIds документы, привязанные к приёмке. Присланное
 *   происхождение вне этого набора отбрасывается: позиция не может приехать из
 *   документа, которого в приёмке нет.
 */
export function resolveItemOrigins(args: {
  existing: readonly ExistingItemRow[];
  incoming: readonly IncomingItem[];
  linkedDocumentIds: readonly string[];
  nameOnlyFallback?: boolean;
}): ItemOrigin[] {
  return resolveItemOriginsWithStats(args).origins;
}

/**
 * То же, что [resolveItemOrigins], плюс счётчики шага 2б — для лога маршрута.
 *
 * @param nameOnlyFallback включает шаг 2б (сопоставление по одному названию).
 *   Только для запросов планшета: он присылает строки, которые не узнаются по
 *   id, без происхождения и с «шт» вместо единицы документа — и ключ шага 2
 *   («название|единица|номер») на них промахивается. Портал шлёт серверные id и
 *   происхождение, ему шаг не нужен.
 */
export function resolveItemOriginsWithStats(args: {
  existing: readonly ExistingItemRow[];
  incoming: readonly IncomingItem[];
  linkedDocumentIds: readonly string[];
  nameOnlyFallback?: boolean;
}): { origins: ItemOrigin[]; nameMatch: NameMatchStats } {
  const { existing, incoming, linkedDocumentIds } = args;
  const nameMatch: NameMatchStats = { matched: 0, ambiguous: 0 };
  const allowed = new Set(linkedDocumentIds);

  const existingById = new Map(existing.map((r) => [r.id, r]));
  const result: (ItemOrigin | null)[] = incoming.map(() => null);
  const claimedExistingIds = new Set<string>();

  const inherit = (row: ExistingItemRow): ItemOrigin => ({
    sourceDocumentId: row.sourceDocumentId,
    sourceDocumentItemId: row.sourceDocumentItemId,
  });

  // Шаг 1: строки, которые клиент опознал по id. Значение — только из БД.
  incoming.forEach((item, index) => {
    if (!item.id) return;
    const row = existingById.get(item.id);
    if (!row) return;
    claimedExistingIds.add(row.id);
    result[index] = inherit(row);
  });

  // Шаг 1.5: id устарел, но клиент вернул ссылку на позицию документа. Ключ
  // переживает переименование — в отличие от шага 2, который строится на
  // названии. Значение по-прежнему читается из строки БД.
  const restBySourceItem = existing.filter(
    (r) => !claimedExistingIds.has(r.id) && r.sourceDocumentItemId !== null,
  );
  const incomingBySourceItem = incoming
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => result[index] === null && !!item.sourceDocumentItemId);

  const existingBySourceItemId = groupBy(restBySourceItem, (r) => r.sourceDocumentItemId!);
  const incomingCountBySourceItemId = countBy(
    incomingBySourceItem,
    ({ item }) => item.sourceDocumentItemId!,
  );

  for (const { item, index } of incomingBySourceItem) {
    const key = item.sourceDocumentItemId!;
    const row = pickUnique(existingBySourceItemId.get(key), incomingCountBySourceItemId.get(key));
    if (!row) continue;
    claimedExistingIds.add(row.id);
    result[index] = inherit(row);
  }

  // Шаг 2: запасное сопоставление среди того, что осталось с обеих сторон.
  // Учитываем только строки С происхождением: наследовать null незачем, а
  // лишние кандидаты в мультимножестве сделали бы ключ неоднозначным.
  const restExisting = existing.filter(
    (r) => !claimedExistingIds.has(r.id) && r.sourceDocumentId !== null,
  );
  const restIncoming = incoming
    .map((item, index) => ({ item, index }))
    .filter(({ index }) => result[index] === null);

  const existingByKey = groupBy(restExisting, fallbackKey);
  const incomingCountByKey = countBy(restIncoming, ({ item }) => fallbackKey(item));

  for (const { item, index } of restIncoming) {
    const key = fallbackKey(item);
    const row = pickUnique(existingByKey.get(key), incomingCountByKey.get(key));
    if (!row) continue;
    // Занятость нужна шагу 2б. Самому шагу 2 она ничего не меняет: его
    // множества построены до цикла, а pickUnique и так даёт соответствие один к
    // одному.
    claimedExistingIds.add(row.id);
    result[index] = inherit(row);
  }

  // Шаг 2б: только название — для строк планшета, на которых промахнулись все
  // ключи выше. См. nameOnlyFallback и nameOnlyInherit.
  if (args.nameOnlyFallback) {
    const stats = nameOnlyInherit({ existing, incoming, result, claimedExistingIds });
    nameMatch.matched = stats.matched;
    nameMatch.ambiguous = stats.ambiguous;
  }

  // Шаг 3: строки, которым сопоставление ничего не дало, и строки, у которых в
  // БД происхождения НЕ БЫЛО. Здесь присланное происхождение допустимо, но
  // только в пределах привязанных документов.
  //
  // Пустое наследство намеренно не считается ответом. Раньше шаг 1 возвращал
  // объект из двух null (строка нашлась по id, привязки у неё нет), проверка
  // `if (resolved)` признавала его результатом, и присланный клиентом документ
  // до этой ветки не доходил. Строка, однажды сохранённая без привязки, уже
  // никогда не могла её получить: на бою так застряли 357 позиций в 109
  // приёмках, причём в 64 из них — все строки разом.
  const origins = incoming.map((item, index) => {
    const resolved = result[index];
    // Непустое наследство неприкосновенно: клиент не должен уметь переписать
    // происхождение существующей строки — в этом весь смысл шагов 1–2.
    if (resolved && resolved.sourceDocumentId !== null) return resolved;

    const claimed = item.sourceDocumentId ?? null;
    if (claimed === null || !allowed.has(claimed)) return EMPTY;
    return {
      sourceDocumentId: claimed,
      sourceDocumentItemId: item.sourceDocumentItemId ?? null,
    };
  });
  return { origins, nameMatch };
}

/**
 * Позиции документа, которые уже кому-то отданы или кем-то заявлены.
 *
 * Сюда идут и ссылки, присланные клиентом, даже непроверенные: слабому шагу
 * лучше промолчать, чем выдать позицию, на которую уже претендует другая строка.
 */
function usedSourceItemIds(
  resolved: readonly (ItemOrigin | null)[],
  incoming: readonly { sourceDocumentItemId?: string | null }[],
): Set<string> {
  const used = new Set<string>();
  for (const origin of resolved) {
    if (origin?.sourceDocumentItemId) used.add(origin.sourceDocumentItemId);
  }
  for (const item of incoming) {
    if (item.sourceDocumentItemId) used.add(item.sourceDocumentItemId);
  }
  return used;
}

/**
 * Шаг 2б: наследование по одному названию.
 *
 * Зачем. Планшет на 2 Этапе присылает строки, которые не узнаются по id, без
 * происхождения (черновик 2 Этапа его не хранит) и с «шт» вместо единицы
 * документа. Ключ шага 2 содержит единицу и номер строки, поэтому на таких
 * строках промахивается: теряют привязку все строки с не-«шт» единицей и все,
 * у которых номер сдвинулся после удалённой строки (боевые 24687, 19525).
 *
 * Название — эвристика, поэтому правило отказывается при малейшей
 * неоднозначности. Строке лучше остаться без привязки, чем получить чужую:
 *  - кандидаты — только строки, которые ни один шаг не опознал И для которых
 *    клиент не прислал документ. Строку, опознанную по id без происхождения,
 *    не трогаем: «починка истории» побочным эффектом сохранения не нужна;
 *  - название уникально среди ВСЕХ входящих строк, а не только кандидатов, —
 *    иначе ручная строка рядом с одноимённой строкой документа заберёт её
 *    позицию;
 *  - название уникально среди ВСЕХ строк БД с происхождением, включая уже
 *    занятые;
 *  - строка БД не занята, её позиция документа никому не отдана и никем не
 *    заявлена;
 *  - решения принимаются по замороженным множествам и применяются потом,
 *    поэтому результат не зависит от порядка строк. Если одну позицию документа
 *    получили бы две строки (в БД две строки с общей позицией), не получает
 *    никто.
 *
 * Значение, как и на шагах 1–2, берётся из БД: клиент максимум наследует
 * происхождение другой строки той же приёмки.
 */
function nameOnlyInherit(args: {
  existing: readonly ExistingItemRow[];
  incoming: readonly IncomingItem[];
  result: (ItemOrigin | null)[];
  claimedExistingIds: Set<string>;
}): NameMatchStats {
  const { existing, incoming, result, claimedExistingIds } = args;
  const key = (r: { nameRaw: string }) => normalizeItemNameForMatch(r.nameRaw);

  const incomingCount = countBy(incoming, key);
  const withOrigin = existing.filter((r) => r.sourceDocumentId !== null);
  const existingByName = groupBy(withOrigin, key);
  const used = usedSourceItemIds(result, incoming);

  let ambiguous = 0;
  const proposed: { index: number; row: ExistingItemRow }[] = [];
  incoming.forEach((item, index) => {
    if (result[index] !== null) return;
    if (item.sourceDocumentId) return;
    const k = key(item);
    const rows = existingByName.get(k);
    if (!rows) return;
    if (rows.length !== 1 || incomingCount.get(k) !== 1) {
      ambiguous += 1;
      return;
    }
    const row = rows[0]!;
    if (claimedExistingIds.has(row.id)) return;
    if (row.sourceDocumentItemId !== null && used.has(row.sourceDocumentItemId)) return;
    proposed.push({ index, row });
  });

  // Одна позиция документа — не больше чем одной строке.
  const proposedPerSourceItem = countBy(
    proposed.filter((p) => p.row.sourceDocumentItemId !== null),
    (p) => p.row.sourceDocumentItemId!,
  );
  let matched = 0;
  for (const { index, row } of proposed) {
    if (
      row.sourceDocumentItemId !== null &&
      proposedPerSourceItem.get(row.sourceDocumentItemId)! > 1
    ) {
      ambiguous += 1;
      continue;
    }
    result[index] = {
      sourceDocumentId: row.sourceDocumentId,
      sourceDocumentItemId: row.sourceDocumentItemId,
    };
    claimedExistingIds.add(row.id);
    matched += 1;
  }
  return { matched, ambiguous };
}

/** Позиция документа, как её видит сопоставление при создании операции. */
export type DocumentItemForMatch = {
  id: string;
  sourceDocumentId: string;
  nameRaw: string;
};

/**
 * Есть ли среди строк те, кому сопоставление по названию вообще может помочь.
 * Маршрут спрашивает это до загрузки позиций документов, чтобы не ходить в БД
 * впустую.
 */
export function hasNameMatchCandidates(args: {
  incoming: readonly { sourceDocumentId?: string | null }[];
  origins: readonly ItemOrigin[];
}): boolean {
  return args.incoming.some(
    (item, index) => !item.sourceDocumentId && args.origins[index]?.sourceDocumentId == null,
  );
}

/**
 * Создание операции: строкам без происхождения — позиция привязанного документа
 * по названию.
 *
 * При создании наследовать не от чего: строк в БД ещё нет, а происхождение
 * берётся только из запроса. Планшет, у которого оба этапа ушли одним запросом
 * из черновика 2 Этапа, присылает строки документа без ссылки на него. Правило
 * то же, что у шага 2б, и так же консервативно:
 *  - кандидаты — строки, которым проверка не оставила документа И для которых
 *    клиент документ не присылал (ссылку на непривязанный документ не
 *    «исправляем» — это подозрительный запрос, а не потерянная ссылка);
 *  - название уникально среди ВСЕХ строк запроса и среди ВСЕХ позиций ВСЕХ
 *    привязанных документов: одинаковые позиции двух УПД — неоднозначность;
 *  - позиция не отдана и не заявлена другой строкой запроса.
 */
export function matchItemsToDocumentsByName(args: {
  incoming: readonly {
    nameRaw: string;
    sourceDocumentId?: string | null;
    sourceDocumentItemId?: string | null;
  }[];
  origins: readonly ItemOrigin[];
  documentItems: readonly DocumentItemForMatch[];
}): { origins: ItemOrigin[]; matched: number; ambiguous: number } {
  const { incoming, documentItems } = args;
  const key = (r: { nameRaw: string }) => normalizeItemNameForMatch(r.nameRaw);

  const incomingCount = countBy(incoming, key);
  const docByName = groupBy(documentItems, key);
  const used = usedSourceItemIds(args.origins, incoming);

  const origins = [...args.origins];
  let matched = 0;
  let ambiguous = 0;
  incoming.forEach((item, index) => {
    if (item.sourceDocumentId) return;
    if (origins[index]?.sourceDocumentId != null) return;
    const k = key(item);
    const docs = docByName.get(k);
    if (!docs) return;
    if (docs.length !== 1 || incomingCount.get(k) !== 1) {
      ambiguous += 1;
      return;
    }
    const doc = docs[0]!;
    if (used.has(doc.id)) {
      ambiguous += 1;
      return;
    }
    // Каждое название уникально с обеих сторон, поэтому одна позиция не может
    // достаться двум строкам — проверка «после» здесь не нужна.
    origins[index] = { sourceDocumentId: doc.sourceDocumentId, sourceDocumentItemId: doc.id };
    matched += 1;
  });
  return { origins, matched, ambiguous };
}

/**
 * Позиции документа, привязка к которым не досталась ни одной строке.
 *
 * Нужна для наблюдения за потерями атрибуции: валовое число строк без
 * `source_document_item_id` их не доказывает — туда попадают и позиции,
 * заведённые руками, и последствия переразбора УПД, где FK обнуляется
 * штатно (`ON DELETE SET NULL`). А вот строка, у которой привязка БЫЛА и после
 * upsert исчезла, — это всегда промах сопоставления.
 */
export function findDroppedOrigins(args: {
  existing: readonly ExistingItemRow[];
  origins: readonly ItemOrigin[];
}): { sourceDocumentItemId: string; lineNo: number; nameRaw: string }[] {
  const kept = new Set(
    args.origins
      .map((o) => o.sourceDocumentItemId)
      .filter((id): id is string => id !== null && id !== undefined),
  );
  return args.existing
    .filter((r) => r.sourceDocumentItemId !== null && !kept.has(r.sourceDocumentItemId))
    .map((r) => ({
      sourceDocumentItemId: r.sourceDocumentItemId!,
      lineNo: r.lineNo,
      nameRaw: r.nameRaw,
    }));
}
