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
 * Запасное сопоставление по (название, единица, номер строки) применяется
 * ТОЛЬКО при однозначном совпадении: у клиента могли смениться id (офлайн-
 * черновик пережил переразбор), но угадывать нельзя — номера строк и материалы
 * в разных УПД совпадают сплошь и рядом. Неоднозначность → null.
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

  // Шаг 1: строки, которые клиент опознал по id. Значение — только из БД.
  incoming.forEach((item, index) => {
    if (!item.id) return;
    const row = existingById.get(item.id);
    if (!row) return;
    claimedExistingIds.add(row.id);
    result[index] = {
      sourceDocumentId: row.sourceDocumentId,
      sourceDocumentItemId: row.sourceDocumentItemId,
    };
  });

  // Шаг 2: запасное сопоставление среди того, что осталось с обеих сторон.
  // Учитываем только строки С происхождением: наследовать null незачем, а
  // лишние кандидаты в мультимножестве сделали бы ключ неоднозначным.
  const restExisting = existing.filter(
    (r) => !claimedExistingIds.has(r.id) && r.sourceDocumentId !== null,
  );
  const restIncoming = incoming
    .map((item, index) => ({ item, index }))
    .filter(({ index }) => result[index] === null);

  const existingByKey = new Map<string, ExistingItemRow[]>();
  for (const row of restExisting) {
    const key = fallbackKey(row);
    const bucket = existingByKey.get(key);
    if (bucket) bucket.push(row);
    else existingByKey.set(key, [row]);
  }

  const incomingCountByKey = new Map<string, number>();
  for (const { item } of restIncoming) {
    const key = fallbackKey(item);
    incomingCountByKey.set(key, (incomingCountByKey.get(key) ?? 0) + 1);
  }

  for (const { item, index } of restIncoming) {
    const key = fallbackKey(item);
    const candidates = existingByKey.get(key);
    // Однозначно — значит ровно одна строка с этим ключом с каждой стороны.
    if (candidates?.length === 1 && incomingCountByKey.get(key) === 1) {
      const row = candidates[0]!;
      result[index] = {
        sourceDocumentId: row.sourceDocumentId,
        sourceDocumentItemId: row.sourceDocumentItemId,
      };
    }
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
