// Выбор лучшего из двух разборов одного документа.
//
// Нужен второму проходу: текстовый разбор дал слабый результат, картинку
// прогнали повторно — и надо решить, чем заменять сохранённое. Наивное правило
// «у кого больше позиций» здесь опасно: vision охотно выдумывает строки, и
// многочисленные галлюцинации вытеснили бы корректный текстовый разбор.
//
// Поэтому критерии упорядочены по надёжности, и решает ПЕРВЫЙ различающий:
//   1. полнота обязательной шапки — без номера, даты и итога документ вообще
//      не может стать 'parsed' (CHECK source_upd_required);
//   2. расхождения сумм — набор позиций, который сходится с итогом, ценнее
//      набора, который не сходится;
//   3. совпадение числа позиций с «Всего наименований» из документа — это
//      прямая проверка полноты списка самим документом;
//   4. количество позиций — только когда предыдущие критерии равны;
//   5. confidence модели — последний аргумент, он самый субъективный.
//
// Стороны в выборе НЕ участвуют: они сливаются отдельно (mergeParties), потому
// что активный промпт v8 грузополучателя не возвращает вовсе, и победа vision
// стёрла бы сторону, дозаполненную из текста.

import type { UpdPdfParsed } from '@matcheck/contracts';
import { validateUpdTotals } from './upd-validation.js';

export type UpdCandidate = {
  parsed: UpdPdfParsed;
  /** Чем разобран — для журнала и логов, на выбор не влияет. */
  mode: string;
};

export type CompareResult = {
  winner: 'base' | 'candidate';
  /** Человекочитаемые причины — уходят в лог и в second_pass. */
  reasons: string[];
};

function headerCompleteness(p: UpdPdfParsed): number {
  return [p.docNumber != null, p.docDate != null, p.totalSum != null].filter(Boolean).length;
}

function hasMismatch(p: UpdPdfParsed): boolean {
  return validateUpdTotals({
    totalSum: p.totalSum ?? null,
    vatSum: p.vatSum ?? null,
    itemsCount: p.itemsCount ?? null,
    items: p.items.map((i) => ({
      qty: i.qty ?? null,
      price: i.price ?? null,
      sum: i.sum ?? null,
      vatRate: i.vatRate ?? null,
      vatSum: i.vatSum ?? null,
    })),
  }).hasMismatch;
}

/** Совпадает ли число позиций с «Всего наименований» из самого документа. */
function itemsCountMatches(p: UpdPdfParsed): boolean {
  return p.itemsCount != null && p.itemsCount === p.items.length;
}

export function chooseBetterUpdResult(base: UpdPdfParsed, candidate: UpdPdfParsed): CompareResult {
  const reasons: string[] = [];

  const headerBase = headerCompleteness(base);
  const headerCand = headerCompleteness(candidate);
  if (headerBase !== headerCand) {
    reasons.push(`header ${headerBase} vs ${headerCand}`);
    return { winner: headerCand > headerBase ? 'candidate' : 'base', reasons };
  }

  // Пустой набор позиций проигрывает непустому независимо от прочего: документ
  // без строк бесполезен приёмщику.
  if ((base.items.length === 0) !== (candidate.items.length === 0)) {
    reasons.push(`items ${base.items.length} vs ${candidate.items.length}`);
    return { winner: candidate.items.length > 0 ? 'candidate' : 'base', reasons };
  }

  const mismatchBase = hasMismatch(base);
  const mismatchCand = hasMismatch(candidate);
  if (mismatchBase !== mismatchCand) {
    reasons.push(`mismatch ${mismatchBase} vs ${mismatchCand}`);
    return { winner: mismatchCand ? 'base' : 'candidate', reasons };
  }

  const countBase = itemsCountMatches(base);
  const countCand = itemsCountMatches(candidate);
  if (countBase !== countCand) {
    reasons.push(`itemsCount match ${countBase} vs ${countCand}`);
    return { winner: countCand ? 'candidate' : 'base', reasons };
  }

  if (base.items.length !== candidate.items.length) {
    reasons.push(`items ${base.items.length} vs ${candidate.items.length}`);
    return { winner: candidate.items.length > base.items.length ? 'candidate' : 'base', reasons };
  }

  if (base.confidence !== candidate.confidence) {
    reasons.push(`confidence ${base.confidence} vs ${candidate.confidence}`);
    return { winner: candidate.confidence > base.confidence ? 'candidate' : 'base', reasons };
  }

  // Всё равно — оставляем сохранённое: замена без выигрыша бессмысленна и
  // только сотрёт ручные правки, если они были.
  reasons.push('equal');
  return { winner: 'base', reasons };
}

function isEmptyParty(p: UpdPdfParsed['supplier']): boolean {
  if (p == null) return true;
  return !p.inn?.trim() && !p.name?.trim();
}

/**
 * Переносит в победителя стороны, которые есть у проигравшего, но пусты у него.
 *
 * Обязательный шаг: промпт v8 (активный) вообще не просит грузополучателя, и
 * без слияния успешный vision-проход обнулил бы сторону, дозаполненную из
 * текста на первом проходе.
 */
export function mergeParties(winner: UpdPdfParsed, loser: UpdPdfParsed): UpdPdfParsed {
  const next = { ...winner };
  let changed = false;
  for (const key of ['supplier', 'recipient', 'consignee'] as const) {
    if (isEmptyParty(next[key]) && !isEmptyParty(loser[key])) {
      next[key] = loser[key];
      changed = true;
    }
  }
  return changed ? next : winner;
}
