/**
 * Разбор накопленных потерь привязки: какой строке приёмки какая позиция
 * документа принадлежит.
 *
 * Откуда взялись потери. При upsert происхождение восстанавливал
 * `resolveItemOrigins`, и шаг 1 (совпадение по id строки) считал ответом даже
 * пустое наследство — строка, однажды записанная без привязки, не могла
 * получить её уже никогда, сколько бы раз клиент ни присылал корректный
 * `sourceDocumentId`. Дыра закрыта, но историю правка не чинит: на момент
 * разбора в бою 357 таких позиций в 109 приёмках.
 *
 * Правило намеренно у́же, чем у upsert: здесь нет ни id строк, ни присланного
 * клиентом происхождения — только тексты. Поэтому:
 *
 *  - берём приёмки ровно с ОДНОЙ связью: при нескольких документах одинаковая
 *    позиция в разных УПД встречается сплошь и рядом, и угадывать нельзя;
 *  - сопоставляем по названию, нормализованному так же, как в upsert
 *    (`normalizeItemNameForMatch`), — иначе отчёт разойдётся с поведением
 *    сервера;
 *  - требуем взаимной однозначности: одному названию ровно одна строка с каждой
 *    стороны. Иначе — в ручной разбор.
 *
 * Единица и количество в ключ НЕ входят: их правит инспектор при приёмке (в
 * боевом случае 14289 «м³» документа стало «шт»), и расхождение здесь — норма,
 * а не повод отказаться от привязки. Они попадают в отчёт как справочные поля,
 * чтобы человек видел, что именно расходится.
 */

import { normalizeItemNameForMatch } from './item-origin.js';

export type UnlinkedItemRow = {
  itemId: string;
  nameRaw: string;
  unit: string;
  qty: string | null;
};

export type DocumentItemRow = {
  itemId: string;
  nameRaw: string;
  unit: string;
  qty: string | null;
};

export type RestorePlan = {
  /** Строки, которым привязка восстанавливается однозначно. */
  restore: {
    itemId: string;
    sourceDocumentItemId: string;
    nameRaw: string;
    unitDiffers: boolean;
    qtyDiffers: boolean;
  }[];
  /** Всё остальное — с причиной, по которой автоматика отказалась. */
  manual: { itemId: string; nameRaw: string; reason: 'no_match' | 'ambiguous' }[];
};

function countBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const k = key(row);
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
}

/**
 * План восстановления для ОДНОЙ приёмки с единственным привязанным документом.
 *
 * @param unlinked строки приёмки без происхождения
 * @param documentItems позиции этого документа
 */
export function planUnlinkedRestores(args: {
  unlinked: readonly UnlinkedItemRow[];
  documentItems: readonly DocumentItemRow[];
}): RestorePlan {
  const { unlinked, documentItems } = args;
  const key = (r: { nameRaw: string }) => normalizeItemNameForMatch(r.nameRaw);

  const docByKey = new Map<string, DocumentItemRow[]>();
  for (const row of documentItems) {
    const bucket = docByKey.get(key(row));
    if (bucket) bucket.push(row);
    else docByKey.set(key(row), [row]);
  }
  const unlinkedCount = countBy(unlinked, key);

  const plan: RestorePlan = { restore: [], manual: [] };
  for (const row of unlinked) {
    const k = key(row);
    const candidates = docByKey.get(k);
    if (!candidates || candidates.length === 0) {
      plan.manual.push({ itemId: row.itemId, nameRaw: row.nameRaw, reason: 'no_match' });
      continue;
    }
    if (candidates.length > 1 || unlinkedCount.get(k) !== 1) {
      plan.manual.push({ itemId: row.itemId, nameRaw: row.nameRaw, reason: 'ambiguous' });
      continue;
    }
    const match = candidates[0]!;
    plan.restore.push({
      itemId: row.itemId,
      sourceDocumentItemId: match.itemId,
      nameRaw: row.nameRaw,
      unitDiffers: row.unit.trim().toLowerCase() !== match.unit.trim().toLowerCase(),
      qtyDiffers: decimalDiffers(row.qty, match.qty),
    });
  }
  return plan;
}

/** Сравнение количеств по значению, а не по тексту: «22» и «22.0000» равны. */
function decimalDiffers(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a !== b;
  const na = Number(a.replace(',', '.'));
  const nb = Number(b.replace(',', '.'));
  if (Number.isNaN(na) || Number.isNaN(nb)) return a.trim() !== b.trim();
  return na !== nb;
}
