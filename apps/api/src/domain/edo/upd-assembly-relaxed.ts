/**
 * Relaxed-проход склейки: фрагмент, у которого модель прочла ЧУЖУЮ ДАТУ,
 * присоединяется к своей УПД вместо того, чтобы публиковаться вторым
 * документом.
 *
 * Боевой случай — приёмка 13776. В пакете три документа с номером
 * 201/21126719-1 одного поставщика: два с датой 2026-09-04 строгий проход свёл
 * (у одного строка 1, у другого строки 1–2), а третий — та же строка 2, тот же
 * итог 23 404,53 ₽, но дата 2025-11-25 — остался отдельным документом и
 * привязался к приёмке. Позиция «Соединитель пруток — полоса, 80х80» попала в
 * учёт дважды: 47 шт вместо 47 стали 94, лишние 12 482 ₽. За месяц так
 * задвоено 38 строк в 7 приёмках на 10,6 млн ₽.
 *
 * Что ослаблено, и только это: ДАТА. Поставщик и номер остаются обязательными —
 * один номер у разных поставщиков законен (см. аудит нумерации в worker), и без
 * поставщика проход склеил бы чужие документы.
 *
 * Почему проход отдельный, а не правка строгого. Строгий арбитр
 * (classifyAssemblyPair) при совпавших номерах строк объявляет `copies`, НЕ
 * сверяя сами строки, а «совпавших строк нет» считает частями и склеивает. Для
 * ослабленного ключа этого мало: здесь требуется полное и однозначное вложение
 * строк по расширенному ключу, а любая неоднозначность — отказ.
 */
import {
  decimalKey,
  nameCloseEnough,
  type AssemblyMergeAction,
  type AssemblyMergeDocument,
  type AssemblyMergeItem,
} from './upd-assembly-merge.js';
import { normalizeDocNumber } from './upd-doc-number.js';

export type AssemblyRelaxedMode = 'off' | 'shadow' | 'on';

/** Присоединение одиночки к строгой группе. */
export type RelaxedJoin = {
  singleId: string;
  keeperId: string;
  /** Сколько строк одиночки нашли пару в прогнозируемом наборе группы. */
  matchedItems: number;
  reason: string;
};

export type RelaxedRejection = { documentId: string; reason: string };

/**
 * Пара одиночек, которая выглядит копиями друг друга.
 *
 * В `on` НЕ склеивается: у двух одиночек нет независимого подтверждения, какая
 * из двух дат верна, — а значит, нет и оснований выбирать keeper. Копится в
 * улику, чтобы решение принималось по накопленным случаям, а не вслепую.
 */
export type RelaxedSingletonPair = {
  keeperId: string;
  otherId: string;
  reason: string;
};

export type RelaxedReport = {
  mode: AssemblyRelaxedMode;
  joins: RelaxedJoin[];
  rejected: RelaxedRejection[];
  singletonPairs: RelaxedSingletonPair[];
  /** Сколько документов перестало бы публиковаться отдельно. */
  documentsWouldJoin: number;
};

/** Ключ relaxed-кандидата: поставщик и номер, дата намеренно не участвует. */
function relaxedKey(doc: AssemblyMergeDocument): string | null {
  if (!doc.supplierDirectoryId) return null;
  const number = normalizeDocNumber(doc.docNumber);
  if (number == null) return null;
  return JSON.stringify([doc.supplierDirectoryId, number]);
}

/**
 * Итог документа как признак «тот же документ».
 *
 * Ненулевой обязательно: нулём отдаются документы без стоимостной части, и по
 * нему совпал бы кто угодно.
 */
function totalKey(doc: AssemblyMergeDocument): string | null {
  if (doc.declaredTotal == null) return null;
  const key = decimalKey(doc.declaredTotal);
  if (key === '∅' || Number(doc.declaredTotal) === 0) return null;
  return key;
}

/**
 * Расширенный отпечаток строки — строже, чем у строгого прохода.
 *
 * К количеству, сумме, цене и единице добавлены ставка и сумма налога: без них
 * две строки с одинаковой стоимостью, но разными ставками считались бы одной.
 */
function strictNumericKey(item: AssemblyMergeItem): string {
  return JSON.stringify([
    decimalKey(item.qty),
    decimalKey(item.sum),
    decimalKey(item.price ?? null),
    (item.unit ?? '').trim().toLowerCase(),
    decimalKey(item.vatRate ?? null),
    decimalKey(item.vatSum ?? null),
  ]);
}

type SubsetVerdict =
  | { kind: 'subset'; matched: number }
  | { kind: 'ambiguous' }
  | { kind: 'incomplete'; unmatched: number };

/**
 * Полное и однозначное вложение `candidate` в `target`.
 *
 * Каждая строка кандидата обязана иметь ровно одну свободную пару в целевом
 * наборе — по расширенному ключу и близости наименования. Ни одной пары —
 * `incomplete` (это не копия, а другой состав); больше одной — `ambiguous`
 * (две одинаковые по числам позиции с разными названиями наугад не
 * сопоставляются). Отказ и там, и там.
 */
export function relaxedSubsetOf(
  candidate: AssemblyMergeItem[],
  target: AssemblyMergeItem[],
): SubsetVerdict {
  const byKey = new Map<string, AssemblyMergeItem[]>();
  for (const item of target) {
    const key = strictNumericKey(item);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(item);
    else byKey.set(key, [item]);
  }

  const taken = new Set<string>();
  let matched = 0;
  let unmatched = 0;
  for (const item of candidate) {
    const bucket = byKey.get(strictNumericKey(item)) ?? [];
    const candidates = bucket.filter(
      (t) => !taken.has(t.id) && nameCloseEnough(t.nameRaw, item.nameRaw),
    );
    if (candidates.length > 1) return { kind: 'ambiguous' };
    if (candidates.length === 0) {
      unmatched += 1;
      continue;
    }
    taken.add(candidates[0]!.id);
    matched += 1;
  }
  return unmatched > 0 ? { kind: 'incomplete', unmatched } : { kind: 'subset', matched };
}

/**
 * Прогнозируемый итоговый набор строк строгой группы — то, что останется у
 * keeper ПОСЛЕ её собственной склейки.
 *
 * Сравнивать одиночку с одним лишь keeper мало: нужная строка может лежать во
 * втором фрагменте группы, и вложение не подтвердилось бы там, где оно есть.
 */
function plannedItemsOf(
  action: AssemblyMergeAction,
  itemById: Map<string, AssemblyMergeItem>,
): AssemblyMergeItem[] {
  return action.itemIds.flatMap((id) => {
    const item = itemById.get(id);
    return item ? [item] : [];
  });
}

/**
 * Keeper пары одиночек по каноническому правилу: больше строк, при равенстве —
 * раньше по порядку сегментов (входной порядок каноничен). Только для улики:
 * в `on` пары одиночек не склеиваются.
 */
function pickSingletonKeeper(
  a: AssemblyMergeDocument,
  b: AssemblyMergeDocument,
): AssemblyMergeDocument {
  if (a.items.length !== b.items.length) return a.items.length > b.items.length ? a : b;
  return a;
}

/**
 * Считает relaxed-присоединения. Ничего не применяет — решение о применении
 * принимает вызывающий по режиму рубильника.
 */
export function planRelaxedCopyJoins(
  documents: AssemblyMergeDocument[],
  strictActions: AssemblyMergeAction[],
  mode: AssemblyRelaxedMode,
): RelaxedReport {
  const report: RelaxedReport = {
    mode,
    joins: [],
    rejected: [],
    singletonPairs: [],
    documentsWouldJoin: 0,
  };
  if (mode === 'off') return report;

  const itemById = new Map<string, AssemblyMergeItem>();
  for (const doc of documents) for (const item of doc.items) itemById.set(item.id, item);
  const docById = new Map(documents.map((doc) => [doc.id, doc]));

  const inStrictGroup = new Set<string>();
  for (const action of strictActions) for (const id of action.documentIds) inStrictGroup.add(id);

  const singles = documents.filter((doc) => !inStrictGroup.has(doc.id));

  for (const single of singles) {
    const key = relaxedKey(single);
    if (key == null) {
      report.rejected.push({ documentId: single.id, reason: 'нет поставщика или номера' });
      continue;
    }
    const total = totalKey(single);
    if (total == null) {
      report.rejected.push({ documentId: single.id, reason: 'итог не прочитан или нулевой' });
      continue;
    }
    if (single.items.length === 0) {
      report.rejected.push({ documentId: single.id, reason: 'нет позиций' });
      continue;
    }

    const receivers = strictActions.filter((action) => {
      const keeper = docById.get(action.keeperId);
      if (!keeper) return false;
      return relaxedKey(keeper) === key && totalKey(keeper) === total;
    });
    if (receivers.length === 0) {
      // Одиночка без строгой группы: если рядом стоит такая же одиночка —
      // это тот самый неразрешённый случай, копим его в улику.
      const twin = singles.find(
        (other) =>
          other.id !== single.id &&
          relaxedKey(other) === key &&
          totalKey(other) === total &&
          other.items.length > 0,
      );
      if (twin) {
        const keeper = pickSingletonKeeper(single, twin);
        const other = keeper.id === single.id ? twin : single;
        const verdict = relaxedSubsetOf(other.items, keeper.items);
        // Пара встречается дважды — по разу на каждую свою одиночку. Ключ
        // дедупликации — сама пара, а не один её конец.
        const pairSeen = report.singletonPairs.some(
          (p) =>
            (p.keeperId === keeper.id && p.otherId === other.id) ||
            (p.keeperId === other.id && p.otherId === keeper.id),
        );
        if (verdict.kind === 'subset' && !pairSeen) {
          report.singletonPairs.push({
            keeperId: keeper.id,
            otherId: other.id,
            reason: 'две одиночки: номер и итог совпали, какая дата верна — неизвестно',
          });
        }
      }
      report.rejected.push({ documentId: single.id, reason: 'подходящей строгой группы нет' });
      continue;
    }
    if (receivers.length > 1) {
      // Жадный выбор «первой подошедшей» присоединил бы фрагмент к чужому
      // документу. Ровно один получатель — обязательное условие.
      report.rejected.push({ documentId: single.id, reason: 'подходящих групп несколько' });
      continue;
    }

    const receiver = receivers[0]!;
    const verdict = relaxedSubsetOf(single.items, plannedItemsOf(receiver, itemById));
    if (verdict.kind === 'ambiguous') {
      report.rejected.push({ documentId: single.id, reason: 'сопоставление строк неоднозначно' });
      continue;
    }
    if (verdict.kind === 'incomplete') {
      report.rejected.push({
        documentId: single.id,
        reason: `строки вложены не полностью (${verdict.unmatched} без пары)`,
      });
      continue;
    }
    report.joins.push({
      singleId: single.id,
      keeperId: receiver.keeperId,
      matchedItems: verdict.matched,
      reason: 'номер, поставщик и итог совпали, строки вложены полностью; разошлась дата',
    });
  }

  report.documentsWouldJoin = report.joins.length;
  return report;
}

/**
 * Каждый документ входит ровно в одно действие.
 *
 * worker применяет действия последовательно к ОДНОМУ снимку строк: два
 * действия на один документ дали бы повторное копирование строк и неверный
 * mergedInto. Инвариант живёт здесь, а не в вызывающем коде, — иначе его
 * пришлось бы помнить каждому будущему вызову.
 */
export function assertDisjointActions(actions: AssemblyMergeAction[]): void {
  const seen = new Map<string, string>();
  for (const action of actions) {
    for (const id of action.documentIds) {
      const owner = seen.get(id);
      if (owner != null) {
        throw new Error(
          `assembly: документ ${id} попал в два действия склейки (${owner} и ${action.keeperId})`,
        );
      }
      seen.set(id, action.keeperId);
    }
  }
}

/**
 * Присоединяет relaxed-одиночек к уже построенным строгим действиям.
 *
 * Именно ДОПОЛНЯЕТ, а не заводит своё действие: keeper, relation, расчёт итогов
 * и пересчёт статуса остаются теми, что решил строгий проход. Второе действие
 * на ту же группу тихо изменило бы корректную склейку — другой keeper, другой
 * итог, — и разбираться пришлось бы задним числом.
 */
export function applyRelaxedJoins(
  actions: AssemblyMergeAction[],
  report: RelaxedReport,
): AssemblyMergeAction[] {
  if (report.mode !== 'on' || report.joins.length === 0) return actions;
  const joinsByKeeper = new Map<string, RelaxedJoin[]>();
  for (const join of report.joins) {
    const bucket = joinsByKeeper.get(join.keeperId);
    if (bucket) bucket.push(join);
    else joinsByKeeper.set(join.keeperId, [join]);
  }
  const next = actions.map((action) => {
    const joins = joinsByKeeper.get(action.keeperId);
    if (!joins || joins.length === 0) return action;
    const ids = joins.map((j) => j.singleId);
    return {
      ...action,
      documentIds: [...action.documentIds, ...ids],
      droppedDocumentIds: [...action.droppedDocumentIds, ...ids],
      relaxedDocumentIds: [...(action.relaxedDocumentIds ?? []), ...ids],
      reasons: [
        ...action.reasons,
        ...joins.map((j) => `${j.singleId}: relaxed-копия — ${j.reason}`),
      ],
    };
  });
  assertDisjointActions(next);
  return next;
}
