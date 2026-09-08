/**
 * Правило «эти две строки приёмки — одна и та же позиция, задвоенная разрезом
 * документа».
 *
 * Живёт отдельным модулем, а не внутри скрипта, ровно по одной причине: по
 * этому правилу потом будут УДАЛЯТЬ строки из подтверждённых МОЛ приёмок.
 * Правило, спрятанное в CLI, нельзя ни прочитать, ни закрыть тестами.
 *
 * Откуда берётся дефект — см. upd-assembly-relaxed.ts: документ разрезан
 * надвое, у второго фрагмента прочитана чужая дата, оба опубликованы и оба
 * привязаны к приёмке. На бою: 7 приёмок, 38 пар, ≈10,6 млн ₽.
 */
import { normalizeDocNumber } from './upd-doc-number.js';

/** Поля строки, сравниваемые на «это одна и та же позиция». */
export const COMPARED_ITEM_FIELDS = [
  'material_id',
  'item_kind',
  'asset_id',
  'inventory_number',
  'serial_number',
  'name_raw',
  'qty_planned',
  'qty_actual',
  'unit',
  'comment',
  'volume_m3',
  'mass_kg',
  'price',
  'vat_rate',
  'vat_sum',
  'volume_confidence',
  'group_name',
] as const;

/**
 * Поля, которые у двух копий ОБЯЗАНЫ различаться, и потому из сравнения
 * исключены:
 *
 *   id, source_document_id, source_document_item_id — на то они и разные копии;
 *   delivery_id — по построению одинаков;
 *   line_no — порядковый номер В ПРИЁМКЕ, его назначает upsert при сохранении,
 *     а не человек. У второй копии он другой просто потому, что она вторая;
 *     включи мы его в сравнение — кандидатов не осталось бы вовсе.
 */
export const EXCLUDED_ITEM_FIELDS = [
  'id',
  'delivery_id',
  'source_document_id',
  'source_document_item_id',
  'line_no',
] as const;

export type DuplicateCandidateRow = {
  id: string;
  line_no: number;
  name_raw: string;
  source_document_id: string;
  bundle_id: string;
  doc_number: string | null;
  supplier_directory_id: string | null;
  supplier_name?: string | null;
  supplier_inn?: string | null;
  doc_is_technical: boolean;
  doc_created_at: Date;
  doc_items: string | number;
} & Record<string, unknown>;

/**
 * Ключ «один и тот же документ, разрезанный надвое»: пакет и номер.
 *
 * Поставщика в ключе НЕТ намеренно, хотя разрез его менять не должен. На бою он
 * всё-таки расходится: в приёмке 13731 у двух фрагментов значатся
 * «ООО МИКРОКЛИМАТ» с ИНН 9702018196 и «ООО МИКРОКЛИМАТ» с «ИНН» 770201001 —
 * это КПП, прочитанный как ИНН; в приёмке 14072 второй фрагмент приписан
 * «АО АЛЬФА-БАНК» — банку из платёжных реквизитов в подвале УПД. Требуй ключ
 * совпадения поставщика, обе приёмки выпали бы из отчёта вовсе.
 *
 * Расхождение при этом не игнорируется — см. `pairVerdict`.
 */
export function documentGroupKey(row: DuplicateCandidateRow): string | null {
  const number = normalizeDocNumber(row.doc_number);
  if (number == null) return null;
  return JSON.stringify([row.bundle_id, number]);
}

export function fieldValue(row: DuplicateCandidateRow, field: string): string {
  const v = row[field];
  if (v == null) return '∅';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Какие из сравниваемых полей различаются. */
export function differingFields(a: DuplicateCandidateRow, b: DuplicateCandidateRow): string[] {
  return COMPARED_ITEM_FIELDS.filter((f) => fieldValue(a, f) !== fieldValue(b, f));
}

/**
 * Какая из двух строк остаётся.
 *
 * Остаётся строка ПОЛНОГО документа — у которого позиций больше: он прочитан
 * целиком, а второй фрагмент — обрезок. При равенстве остаётся строка
 * неархивированного документа, затем — более раннего.
 */
export function pickSurvivor(
  a: DuplicateCandidateRow,
  b: DuplicateCandidateRow,
): { keep: DuplicateCandidateRow; drop: DuplicateCandidateRow } {
  const byItems = Number(b.doc_items) - Number(a.doc_items);
  if (byItems !== 0) return byItems < 0 ? { keep: a, drop: b } : { keep: b, drop: a };
  if (a.doc_is_technical !== b.doc_is_technical) {
    return a.doc_is_technical ? { keep: b, drop: a } : { keep: a, drop: b };
  }
  return a.doc_created_at <= b.doc_created_at ? { keep: a, drop: b } : { keep: b, drop: a };
}

export type PairVerdict = {
  keep: DuplicateCandidateRow;
  drop: DuplicateCandidateRow;
  /** Пустой — строки идентичны по всем пользовательским полям. */
  reasons: string[];
  /** true — строку можно удалять без ручной оценки. */
  deletable: boolean;
};

/**
 * Вердикт по паре.
 *
 * Удалять можно ТОЛЬКО при полном совпадении пользовательских полей и одном и
 * том же поставщике. Любое различие означает, что строку правил человек, —
 * такая пара уходит на ручной разбор. Расхождение поставщика тоже: одинаковый
 * номер у РАЗНЫХ поставщиков в одном пакете возможен, и отличить это от
 * неверно прочитанного ИНН может только глаз.
 */
export function pairVerdict(a: DuplicateCandidateRow, b: DuplicateCandidateRow): PairVerdict {
  const { keep, drop } = pickSurvivor(a, b);
  const reasons = differingFields(a, b);
  if (keep.supplier_directory_id !== drop.supplier_directory_id) {
    reasons.push('поставщик документа');
  }
  return { keep, drop, reasons, deletable: reasons.length === 0 };
}

/** ИНН из 9 цифр — почти наверняка КПП, попавший в поле ИНН. */
export function looksLikeKpp(inn: string | null | undefined): boolean {
  return inn != null && /^\d{9}$/.test(inn);
}

/**
 * Пары задвоенных строк внутри одной приёмки.
 *
 * Кандидатами считаются строки из РАЗНЫХ документов одной группы «пакет +
 * номер» с одинаковыми наименованием и фактическим количеством: именно так
 * выглядит одна позиция, попавшая в приёмку дважды. Каждая строка участвует
 * не более чем в одной паре.
 */
export function findDuplicatePairs(rows: DuplicateCandidateRow[]): PairVerdict[] {
  const pairs: PairVerdict[] = [];
  const used = new Set<string>();
  for (let i = 0; i < rows.length; i += 1) {
    const a = rows[i]!;
    const key = documentGroupKey(a);
    if (key == null || used.has(a.id)) continue;
    for (let j = i + 1; j < rows.length; j += 1) {
      const b = rows[j]!;
      if (used.has(b.id)) continue;
      if (b.source_document_id === a.source_document_id) continue;
      if (documentGroupKey(b) !== key) continue;
      if (fieldValue(a, 'name_raw') !== fieldValue(b, 'name_raw')) continue;
      if (fieldValue(a, 'qty_actual') !== fieldValue(b, 'qty_actual')) continue;
      pairs.push(pairVerdict(a, b));
      used.add(a.id);
      used.add(b.id);
      break;
    }
  }
  return pairs;
}
