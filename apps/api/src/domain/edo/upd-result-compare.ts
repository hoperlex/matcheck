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
import { normalizeInn } from '../sourceDocuments/resolve-contractor.js';
import { normalizeSupplierName } from '../sourceDocuments/supplierMatcher.js';
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

  // ПОЛНОТА СПИСКА ИДЁТ ПЕРВОЙ, раньше полноты шапки.
  //
  // Раньше первым сравнивался комплект «номер + дата + итог», и результат с
  // полной шапкой, но БЕЗ ЕДИНОЙ ПОЗИЦИИ, побеждал результат с номером и всеми
  // материалами. Для приёмки это разворот наоборот: инспектор работает со
  // списком материалов, а недостающую дату менеджер дописывает в карточке.
  // С правилом «номер + полный список» (см. upd-outcome.ts) прежний порядок
  // прямо противоречил цели — победитель оказывался непригоден к приёмке.

  // Пустой набор позиций проигрывает непустому: документ без строк бесполезен
  // приёмщику, какой бы полной ни была шапка.
  if ((base.items.length === 0) !== (candidate.items.length === 0)) {
    reasons.push(`items ${base.items.length} vs ${candidate.items.length}`);
    return { winner: candidate.items.length > 0 ? 'candidate' : 'base', reasons };
  }

  // Список, сошедшийся с «Всего наименований», важнее лишнего поля шапки: он
  // означает, что материалы распознаны целиком.
  {
    const countBase = itemsCountMatches(base);
    const countCand = itemsCountMatches(candidate);
    if (countBase !== countCand) {
      reasons.push(`itemsCount match ${countBase} vs ${countCand}`);
      return { winner: countCand ? 'candidate' : 'base', reasons };
    }
  }

  const headerBase = headerCompleteness(base);
  const headerCand = headerCompleteness(candidate);
  if (headerBase !== headerCand) {
    reasons.push(`header ${headerBase} vs ${headerCand}`);
    return { winner: headerCand > headerBase ? 'candidate' : 'base', reasons };
  }

  const mismatchBase = hasMismatch(base);
  const mismatchCand = hasMismatch(candidate);
  if (mismatchBase !== mismatchCand) {
    reasons.push(`mismatch ${mismatchBase} vs ${mismatchCand}`);
    return { winner: mismatchCand ? 'base' : 'candidate', reasons };
  }

  // Совпадение с «Всего наименований» уже проверено выше — до полноты шапки.

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

type Party = NonNullable<UpdPdfParsed['supplier']>;

function isEmptyParty(p: UpdPdfParsed['supplier']): boolean {
  if (p == null) return true;
  return !p.inn?.trim() && !p.name?.trim();
}

/**
 * Одна ли это организация в двух разборах.
 *
 * Читаемый ИНН решает сам: он уникален, а его нормализация проверяет
 * контрольные цифры, так что переставленные моделью цифры сюда не пройдут и
 * дадут «разные стороны» — безопасный исход. Если ИНН есть не у обоих (частый
 * случай: у vision имя без реквизитов), сравниваем нормализованные имена той же
 * функцией, что и матчер справочника: она снимает кавычки и разделители, но
 * оставляет ОПФ — «ООО "Строй"» и «АО "Строй"» разными юрлицами и останутся.
 */
function samePartyIdentity(a: Party, b: Party): boolean {
  const innA = normalizeInn(a.inn);
  const innB = normalizeInn(b.inn);
  if (innA && innB) return innA === innB;
  const nameA = a.name?.trim() ? normalizeSupplierName(a.name) : '';
  const nameB = b.name?.trim() ? normalizeSupplierName(b.name) : '';
  return nameA !== '' && nameA === nameB;
}

/**
 * Сливает одну сторону: пустую берёт у проигравшего целиком, непустую
 * дозаполняет по полям — но только если это та же организация.
 *
 * Поэлементно, а не «целиком, если пусто»: сторона с именем, но без ИНН —
 * не пустая, и правило «целиком» её не трогало, из-за чего ИНН, добытый на
 * первом проходе, исчезал при победе vision. Проверка identity здесь
 * обязательна: без неё к организации-победителю приклеился бы ИНН другой
 * организации, а это хуже, чем отсутствующий ИНН.
 */
function mergeParty(winner: Party | null | undefined, loser: Party | null | undefined): {
  party: Party | null | undefined;
  changed: boolean;
} {
  if (isEmptyParty(loser)) return { party: winner, changed: false };
  if (isEmptyParty(winner)) return { party: loser, changed: true };
  const w = winner as Party;
  const l = loser as Party;
  if (!samePartyIdentity(w, l)) return { party: w, changed: false };

  const next = { ...w };
  let changed = false;
  if (!next.inn?.trim() && l.inn?.trim()) {
    next.inn = l.inn;
    changed = true;
  }
  if (!next.kpp?.trim() && l.kpp?.trim()) {
    next.kpp = l.kpp;
    changed = true;
  }
  if (!next.name?.trim() && l.name?.trim()) {
    next.name = l.name;
    changed = true;
  }
  return changed ? { party: next, changed: true } : { party: w, changed: false };
}

/**
 * Переносит в победителя стороны и реквизиты сторон, которых у него нет.
 *
 * Обязательный шаг: промпт v8 (активный) вообще не просит грузополучателя, и
 * без слияния успешный vision-проход обнулил бы сторону, дозаполненную из
 * текста на первом проходе. По той же причине сливаются и отдельные поля —
 * vision регулярно возвращает имя без ИНН.
 */
export function mergeParties(winner: UpdPdfParsed, loser: UpdPdfParsed): UpdPdfParsed {
  const next = { ...winner };
  let changed = false;
  for (const key of ['supplier', 'recipient', 'consignee'] as const) {
    const merged = mergeParty(next[key], loser[key]);
    if (merged.changed) {
      next[key] = merged.party;
      changed = true;
    }
  }
  return changed ? next : winner;
}
