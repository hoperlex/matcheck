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
 * Отсюда правило: для строки, которая уже есть в приёмке, происхождение берётся
 * из БД; для новой — из запроса, но только если документ действительно
 * привязан к этой приёмке.
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

/** Ключ запасного сопоставления: то, что человек видит в строке, + её номер. */
function fallbackKey(item: { nameRaw: string; unit: string; lineNo: number }): string {
  const name = item.nameRaw.trim().replace(/\s+/g, ' ').toLowerCase();
  const unit = item.unit.trim().toLowerCase();
  return `${name}|${unit}|${item.lineNo}`;
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
}): ItemOrigin[] {
  const { existing, incoming, linkedDocumentIds } = args;
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
    result[index] = inherit(row);
  }

  // Шаг 3: то, чего в приёмке не было, — новые строки. Здесь присланное
  // происхождение допустимо, но только в пределах привязанных документов.
  return incoming.map((item, index) => {
    const resolved = result[index];
    if (resolved) return resolved;

    const claimed = item.sourceDocumentId ?? null;
    if (claimed === null || !allowed.has(claimed)) return EMPTY;
    return {
      sourceDocumentId: claimed,
      sourceDocumentItemId: item.sourceDocumentItemId ?? null,
    };
  });
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
