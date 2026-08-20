/**
 * Чистый план склейки сегментов, которые после распознавания оказались одной
 * УПД. БД и порядок публикации остаются в worker; здесь только группировка,
 * сопоставление строк и решение о том, чем считать группу — копиями одного
 * документа или его частями.
 *
 * Почему это не сводится к дедупликации по тексту. Поставщик привозит машину и
 * сканирует ОБА экземпляра УПД — продавца и покупателя. Сегментация делает из
 * них два документа с одним номером, и склейка обязана оставить один комплект
 * строк. Прежний ключ дедупа включал наименование как есть, а OCR читает два
 * скана одной страницы чуть по-разному: «МК-103» и «МК --103», «3х1,5ок(N,PE)»
 * и «3х1,50 -- к(N,PE)». Ключи расходились, строки считались уникальными — и
 * документ получал 4 позиции вместо 2 и удвоенный итог. На боевых данных так
 * раздулись 11 документов из 28 склеек.
 *
 * Поэтому строки сопоставляются один-к-одному: сначала по напечатанному в
 * бланке номеру позиции, затем по (количество, сумма, цена, единица) с
 * нормализованным наименованием, а на расхождениях OCR — по сходству имени при
 * совпавших до копейки числах. Там, где сопоставление неоднозначно, строки НЕ
 * схлопываются: лишняя строка видна менеджеру, потерянная — нет.
 */
import { levenshteinDistance } from '../sourceDocuments/supplierMatcher.js';

export type AssemblyMergeItem = {
  id: string;
  nameRaw: string;
  qty: string | number;
  sum: string | number | null;
  /** Единица и цена уточняют сопоставление; отсутствуют у старых вызовов. */
  unit?: string | null;
  price?: string | number | null;
  /** Номер позиции, напечатанный в бланке (графа 1). NULL до миграции 0115. */
  rowNo?: number | null;
};

export type AssemblyMergeDocument = {
  id: string;
  supplierDirectoryId: string | null;
  docNumber: string | null;
  docDate: Date | string | null;
  items: AssemblyMergeItem[];
  /**
   * Итог «Всего к оплате», прочитанный из шапки этого сегмента.
   *
   * Дополнительный сигнал, а не решающий: у двух ЧАСТЕЙ одного документа итог
   * тоже может распознаться одинаково (шапка печатается на каждом листе), и
   * правило «итоги равны ⇒ копии» потеряло бы позиции второй части.
   */
  declaredTotal?: string | number | null;
};

/** Чем оказалась группа: копиями одного документа или его частями. */
export type AssemblyMergeRelation = 'copies' | 'parts' | 'unknown';

export type AssemblyMergeAction = {
  keeperId: string;
  documentIds: string[];
  droppedDocumentIds: string[];
  /** Строки, которые остаются у keeper (остальные — дубли сопоставленных). */
  itemIds: string[];
  /** true — все сегменты содержат один и тот же набор строк (копии страниц). */
  identicalItems: boolean;
  relation: AssemblyMergeRelation;
  /** Человекочитаемые причины решения — уходят в лог worker'а. */
  reasons: string[];
};

/**
 * Насколько похожими должны быть наименования, чтобы считать строки одной и той
 * же позицией. Проверяется ТОЛЬКО когда количество и сумма совпали до копейки.
 *
 * 0.85 — с запасом: расхождения OCR на одной странице это один-два символа на
 * полсотни («3х1,5ок» против «3х1,50 -- к»), то есть сходство 0.95+. Более
 * низкий порог начал бы склеивать разные типоразмеры одного кабеля.
 */
const NAME_SIMILARITY_THRESHOLD = 0.85;

function dateKey(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function identityKey(doc: AssemblyMergeDocument): string | null {
  if (!doc.supplierDirectoryId || !doc.docNumber || !doc.docDate) return null;
  // JSON.stringify исключает коллизии от разделителей внутри номера.
  return JSON.stringify([doc.supplierDirectoryId, doc.docNumber, dateKey(doc.docDate)]);
}

function decimalKey(value: string | number | null | undefined): string {
  if (value == null) return '∅';
  const raw = String(value).trim().replace(',', '.');
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return raw;
  const sign = match[1] === '-' ? '-' : '';
  const whole = match[2]!.replace(/^0+(?=\d)/, '');
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Наименование для сравнения: только буквы и цифры, нижний регистр, ё→е.
 *
 * Пунктуация и пробелы выброшены намеренно — именно в них расходятся два
 * скана одной строки. «Контактор модульный 2НО 20А 230В МК-103» и то же с
 * «МК --103» после нормализации совпадают посимвольно.
 */
export function normalizeItemName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^0-9a-zа-я]/gi, '');
}

function nameCloseEnough(a: string, b: string): boolean {
  const na = normalizeItemName(a);
  const nb = normalizeItemName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const dist = levenshteinDistance(na, nb);
  return 1 - dist / Math.max(na.length, nb.length) >= NAME_SIMILARITY_THRESHOLD;
}

/** Числовой отпечаток строки: по нему ищутся кандидаты на сопоставление. */
function numericKey(item: AssemblyMergeItem): string {
  return JSON.stringify([
    decimalKey(item.qty),
    decimalKey(item.sum),
    decimalKey(item.price ?? null),
    (item.unit ?? '').trim().toLowerCase(),
  ]);
}

function itemKey(item: AssemblyMergeItem): string {
  return JSON.stringify([
    normalizeItemName(item.nameRaw),
    decimalKey(item.qty),
    decimalKey(item.sum),
  ]);
}

function signature(items: AssemblyMergeItem[]): string {
  return [...new Set(items.map(itemKey))].sort().join('\n');
}

type PairResult = {
  /** id строки-дубля → id строки, которой она соответствует у keeper. */
  matched: Map<string, string>;
  /** Нашлась строка, для которой кандидатов больше одного. */
  ambiguous: boolean;
};

/**
 * Сопоставляет строки двух документов один-к-одному.
 *
 * Кандидатами считаются только строки с одинаковыми количеством, суммой, ценой
 * и единицей; из них берётся та, чьё наименование совпадает после нормализации
 * либо достаточно похоже. Если у строки таких кандидатов несколько — это
 * `ambiguous`: две одинаковые по числам позиции с разными названиями склеивать
 * наугад нельзя, и обе остаются.
 */
export function pairAssemblyItems(
  keeperItems: AssemblyMergeItem[],
  otherItems: AssemblyMergeItem[],
): PairResult {
  const byNumeric = new Map<string, AssemblyMergeItem[]>();
  for (const item of keeperItems) {
    const key = numericKey(item);
    const bucket = byNumeric.get(key);
    if (bucket) bucket.push(item);
    else byNumeric.set(key, [item]);
  }

  const matched = new Map<string, string>();
  const taken = new Set<string>();
  let ambiguous = false;

  for (const item of otherItems) {
    const bucket = byNumeric.get(numericKey(item)) ?? [];
    const candidates = bucket.filter(
      (k) => !taken.has(k.id) && nameCloseEnough(k.nameRaw, item.nameRaw),
    );
    if (candidates.length === 0) continue;
    if (candidates.length > 1) {
      ambiguous = true;
      continue;
    }
    const pair = candidates[0]!;
    matched.set(item.id, pair.id);
    taken.add(pair.id);
  }
  return { matched, ambiguous };
}

/**
 * Схлопывает задвоенные строки ВНУТРИ одного набора — тем же признаком
 * похожести, которым склейка сопоставляет строки двух документов.
 *
 * Нужно для починки документов, которые прежняя склейка уже раздула: строки
 * второго экземпляра лежат в одном документе рядом с первыми, и разобрать их
 * обратно можно только по совпавшим числам и близким наименованиям.
 *
 * `copies` — сколько экземпляров свели в этот документ (1 + число архивных
 * двойников). Из группы одинаковых строк остаётся `ceil(size / copies)`, а не
 * одна: в бланке позиция может честно повторяться, и слепое «оставить одну»
 * съело бы настоящую строку. Два экземпляра по две одинаковые позиции дают
 * четыре строки — остаётся две, как в оригинале.
 *
 * Порядок сохраняется: остаются первые строки группы.
 */
export function dedupeAssemblyItems(
  items: AssemblyMergeItem[],
  copies = 2,
): { keep: AssemblyMergeItem[]; drop: AssemblyMergeItem[] } {
  if (copies < 2) return { keep: [...items], drop: [] };
  // Кластеры «одна и та же позиция»: числа совпали, наименование различается
  // разве что начертанием.
  const clusters: AssemblyMergeItem[][] = [];
  for (const item of items) {
    const cluster = clusters.find(
      (c) =>
        numericKey(c[0]!) === numericKey(item) && nameCloseEnough(c[0]!.nameRaw, item.nameRaw),
    );
    if (cluster) cluster.push(item);
    else clusters.push([item]);
  }

  const dropIds = new Set<string>();
  for (const cluster of clusters) {
    const keepCount = Math.ceil(cluster.length / copies);
    for (const item of cluster.slice(keepCount)) dropIds.add(item.id);
  }
  return {
    keep: items.filter((i) => !dropIds.has(i.id)),
    drop: items.filter((i) => dropIds.has(i.id)),
  };
}

/** Есть ли у ВСЕХ строк напечатанный номер позиции. */
function hasAllRowNos(items: AssemblyMergeItem[]): boolean {
  return items.length > 0 && items.every((i) => i.rowNo != null);
}

/**
 * Копии это или части.
 *
 * Порядок признаков — по убыванию надёжности:
 *  1. напечатанные номера позиций: пересекаются (1,2 и 1,2) — копии;
 *     продолжаются (1,2 и 3,4) — части. Прямее этого признака нет;
 *  2. сопоставление строк: меньший документ целиком нашёлся в большем — копии;
 *     не нашлось ни одной пары — части;
 *  3. всё остальное (частичное совпадение, неоднозначность) — unknown:
 *     решение о суммах принимается консервативно, как до правки.
 */
export function classifyAssemblyPair(
  keeper: AssemblyMergeDocument,
  other: AssemblyMergeDocument,
  pairs: PairResult,
): { relation: AssemblyMergeRelation; reason: string } {
  if (hasAllRowNos(keeper.items) && hasAllRowNos(other.items)) {
    const keeperNos = new Set(keeper.items.map((i) => i.rowNo!));
    const shared = other.items.some((i) => keeperNos.has(i.rowNo!));
    return shared
      ? { relation: 'copies', reason: 'номера позиций повторяются' }
      : { relation: 'parts', reason: 'номера позиций продолжаются' };
  }
  if (pairs.ambiguous) {
    return { relation: 'unknown', reason: 'сопоставление строк неоднозначно' };
  }
  if (pairs.matched.size === 0) {
    return { relation: 'parts', reason: 'совпавших строк нет' };
  }
  const minCount = Math.min(keeper.items.length, other.items.length);
  if (pairs.matched.size === minCount) {
    return { relation: 'copies', reason: 'меньший документ целиком повторён' };
  }
  return { relation: 'unknown', reason: 'строки совпали частично' };
}

/**
 * ПРЕЖНЕЕ правило склейки — то, что работает на бою до включения
 * UPD_ASSEMBLY_COPY_DEDUP_V1.
 *
 * Оставлено дословно, включая ключ дедупа по тексту наименования: рубильник
 * обязан возвращать в точности прежнее поведение, а не его пересказ. Удалить
 * можно после того, как новое правило отработает на бою и в откате не будет
 * нужды.
 */
export function planAssemblyDocumentMergesLegacy(
  documents: AssemblyMergeDocument[],
): AssemblyMergeAction[] {
  const legacyItemKey = (item: AssemblyMergeItem): string => {
    const name = item.nameRaw.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
    return JSON.stringify([name, decimalKey(item.qty), decimalKey(item.sum)]);
  };
  const legacySignature = (items: AssemblyMergeItem[]): string =>
    [...new Set(items.map(legacyItemKey))].sort().join('\n');

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
        const key = legacyItemKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        itemIds.push(item.id);
      }
    }
    const signatures = new Set(group.map((doc) => legacySignature(doc.items)));
    actions.push({
      keeperId: group[0]!.id,
      documentIds: group.map((doc) => doc.id),
      droppedDocumentIds: group.slice(1).map((doc) => doc.id),
      itemIds,
      identicalItems: signatures.size === 1,
      relation: 'unknown',
      reasons: ['прежнее правило склейки (рубильник выключен)'],
    });
  }
  return actions;
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
    const keeper = group[0]!;
    const reasons: string[] = [];
    // Строки keeper остаются всегда: это первый сегмент по порядку страниц.
    const itemIds = keeper.items.map((i) => i.id);
    const relations: AssemblyMergeRelation[] = [];

    for (const other of group.slice(1)) {
      const pairs = pairAssemblyItems(keeper.items, other.items);
      const { relation, reason } = classifyAssemblyPair(keeper, other, pairs);
      relations.push(relation);
      reasons.push(`${other.id}: ${relation} — ${reason}`);
      // Дописываем только то, чему не нашлось пары. Так уходит задвоение
      // второго экземпляра и остаётся строка, которую один из сканов потерял.
      for (const item of other.items) {
        if (!pairs.matched.has(item.id)) itemIds.push(item.id);
      }
    }

    // Итог документа перезаписывать суммой строк можно только там, где строки
    // РАЗНЫЕ. У копий заявленный итог из шапки верен, и подмена его суммой
    // (в том числе задвоенной) уничтожает единственную независимую проверку.
    const relation: AssemblyMergeRelation = relations.every((r) => r === 'copies')
      ? 'copies'
      : relations.every((r) => r === 'parts')
        ? 'parts'
        : 'unknown';

    const signatures = new Set(group.map((doc) => signature(doc.items)));
    actions.push({
      keeperId: keeper.id,
      documentIds: group.map((doc) => doc.id),
      droppedDocumentIds: group.slice(1).map((doc) => doc.id),
      itemIds,
      identicalItems: signatures.size === 1,
      relation,
      reasons,
    });
  }
  return actions;
}
