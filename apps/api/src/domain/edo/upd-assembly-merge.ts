/**
 * Чистый план склейки сегментов, которые после распознавания оказались одной
 * УПД. БД и порядок публикации остаются в worker; здесь только строгая
 * группировка и дедупликация строк, чтобы правило можно было исчерпывающе
 * проверить без PostgreSQL.
 */

export type AssemblyMergeItem = {
  id: string;
  nameRaw: string;
  qty: string | number;
  sum: string | number | null;
};

export type AssemblyMergeDocument = {
  id: string;
  supplierDirectoryId: string | null;
  docNumber: string | null;
  docDate: Date | string | null;
  items: AssemblyMergeItem[];
};

export type AssemblyMergeAction = {
  keeperId: string;
  documentIds: string[];
  droppedDocumentIds: string[];
  itemIds: string[];
  /** true — все сегменты содержат один и тот же набор строк (копии страниц). */
  identicalItems: boolean;
};

function dateKey(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function identityKey(doc: AssemblyMergeDocument): string | null {
  if (!doc.supplierDirectoryId || !doc.docNumber || !doc.docDate) return null;
  // JSON.stringify исключает коллизии от разделителей внутри номера.
  return JSON.stringify([doc.supplierDirectoryId, doc.docNumber, dateKey(doc.docDate)]);
}

function decimalKey(value: string | number | null): string {
  if (value == null) return '∅';
  const raw = String(value).trim().replace(',', '.');
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return raw;
  const sign = match[1] === '-' ? '-' : '';
  const whole = match[2]!.replace(/^0+(?=\d)/, '');
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

function itemKey(item: AssemblyMergeItem): string {
  const name = item.nameRaw.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
  return JSON.stringify([name, decimalKey(item.qty), decimalKey(item.sum)]);
}

function signature(items: AssemblyMergeItem[]): string {
  return [...new Set(items.map(itemKey))].sort().join('\n');
}

/**
 * Группирует только документы с полной и строго совпавшей тройкой
 * (supplier_directory_id, doc_number, doc_date). Входной порядок каноничен:
 * первым должен идти самый ранний segment_index — он и становится keeper.
 */
export function planAssemblyDocumentMerges(
  documents: AssemblyMergeDocument[],
): AssemblyMergeAction[] {
  const groups = new Map<string, AssemblyMergeDocument[]>();
  for (const doc of documents) {
    const key = identityKey(doc);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(doc);
    else groups.set(key, [doc]);
  }

  const actions: AssemblyMergeAction[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const seen = new Set<string>();
    const itemIds: string[] = [];
    for (const doc of group) {
      for (const item of doc.items) {
        const key = itemKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        itemIds.push(item.id);
      }
    }
    const signatures = new Set(group.map((doc) => signature(doc.items)));
    actions.push({
      keeperId: group[0]!.id,
      documentIds: group.map((doc) => doc.id),
      droppedDocumentIds: group.slice(1).map((doc) => doc.id),
      itemIds,
      identicalItems: signatures.size === 1,
    });
  }
  return actions;
}
