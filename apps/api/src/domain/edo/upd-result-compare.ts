// Выбор лучшего из двух разборов одного документа.
//
// Нужен второму проходу: текстовый разбор дал слабый результат, картинку
// прогнали повторно — и надо решить, чем заменять сохранённое. Наивное правило
// «у кого больше позиций» здесь опасно: vision охотно выдумывает строки, и
// многочисленные галлюцинации вытеснили бы корректный текстовый разбор.
//
// Поэтому критерии упорядочены по надёжности, и решает ПЕРВЫЙ различающий:
//   1. непустой список позиций против пустого — документ без строк бесполезен
//      приёмщику, какой бы полной ни была шапка;
//   2. совпадение числа позиций с «Всего наименований» — прямая проверка
//      полноты списка самим документом;
//   3. полнота обязательной шапки — без номера, даты и итога документ вообще
//      не может стать 'parsed' (CHECK source_upd_required);
//   4. расхождения сумм — набор позиций, который сходится с итогом, ценнее
//      набора, который не сходится;
//   5. количество позиций — только когда предыдущие критерии равны;
//   6. confidence модели — последний аргумент, он самый субъективный.
//
// Порядок в этом списке был неверен: он обещал начинать с полноты шапки, тогда
// как код с самого начала проверяет пустоту списка и «Всего наименований».
// Комментарий, описывающий не тот алгоритм, опаснее отсутствующего.
//
// ДВА ПРАВИЛА СРАВНЕНИЯ. Пункт 4 существует в двух редакциях, выбор — за
// переменной UPD_RESULT_COMPARE_V2 (off | shadow | on):
//   v1 сравнивает расхождение как ДА/НЕТ. На боевом УПД № 42 повтор снял
//      тринадцать провалов построчной арифметики (стало 1 вместо 15), и это
//      правило объявило разборы «равными», оставив худший;
//   v2 сравнивает ВЕЛИЧИНУ — вектор провалов по типам при не меньшем покрытии,
//      победа только при строгом Pareto-улучшении (см. compareSeverity).
//
// Стороны в выборе НЕ участвуют: они сливаются отдельно (mergeParties), потому
// что активный промпт v8 грузополучателя не возвращает вовсе, и победа vision
// стёрла бы сторону, дозаполненную из текста.

import type { UpdPdfParsed } from '@matcheck/contracts';
import { normalizeInn } from '../sourceDocuments/resolve-contractor.js';
import { normalizeSupplierName } from '../sourceDocuments/supplierMatcher.js';
import { validateUpdTotals } from './upd-validation.js';
import { loadEnv } from '../../lib/env.js';

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

/**
 * Сколько проверок каждого типа ПРИМЕНИМО и сколько из них провалено.
 *
 * Ключевое здесь — «применимо». Валидатор считает отсутствующее значение
 * УСПЕШНО ПРОПУЩЕННОЙ проверкой: пустой итог даёт `sum_total` с
 * `ok: true, skipReason: 'no_expected'`, строка без цены — такой же
 * пропущенный `row_qty_price`. Поэтому «у кандидата меньше провалов» само по
 * себе ничего не значит: разбор, обнуливший цены, получит почти чистый
 * результат просто потому, что проверять стало нечего.
 *
 * Отсюда правило: сравнивать провалы можно только при НЕ МЕНЬШЕМ покрытии.
 */
type CheckProfile = Map<string, { applicable: number; failed: number }>;

function checkProfile(p: UpdPdfParsed): CheckProfile {
  const v = validateUpdTotals({
    totalSum: p.totalSum ?? null,
    vatSum: p.vatSum ?? null,
    itemsCount: p.itemsCount ?? null,
    items: p.items.map((i) => ({
      rowNo: i.rowNo ?? null,
      qty: i.qty ?? null,
      unit: i.unit ?? null,
      price: i.price ?? null,
      sum: i.sum ?? null,
      vatRate: i.vatRate ?? null,
      vatSum: i.vatSum ?? null,
    })),
  });
  const profile: CheckProfile = new Map();
  for (const c of v.checks) {
    // Пропущенная проверка не считается ни применимой, ни проваленной: она
    // ничего не утверждает о документе.
    if (c.skipReason != null) continue;
    const cur = profile.get(c.name) ?? { applicable: 0, failed: 0 };
    cur.applicable += 1;
    if (!c.ok) cur.failed += 1;
    profile.set(c.name, cur);
  }
  return profile;
}

/** Итог направленного сравнения профилей. */
type SeverityVerdict =
  | { kind: 'candidate'; detail: string }
  | { kind: 'base'; detail: string }
  | { kind: 'incomparable'; detail: string };

/**
 * Строгое Pareto-улучшение по вектору провалов.
 *
 * Кандидат выигрывает, только если НИ ОДИН тип проверки не стал хуже и хотя бы
 * один стал лучше. Обмен одной ошибки на другую (ушёл `sum_total`, пришли
 * тринадцать `row_qty_price`) улучшением не считается — там нужен человек, а не
 * арифметика.
 *
 * Предварительное условие — покрытие кандидата не ниже НИ ПО ОДНОМУ типу.
 * Иначе выигрыш можно получить, просто потеряв данные.
 */
function compareSeverity(base: UpdPdfParsed, candidate: UpdPdfParsed): SeverityVerdict {
  // Сравнивать имеет смысл только одинаковые по составу списки: при разной
  // длине меняется само число построчных проверок, и вектора несопоставимы.
  // Разную длину разбирает отдельный критерий ниже по порядку.
  if (base.items.length !== candidate.items.length) {
    return { kind: 'incomparable', detail: 'разное число позиций' };
  }
  if (base.items.length === 0) {
    return { kind: 'incomparable', detail: 'оба списка пусты' };
  }

  const pb = checkProfile(base);
  const pc = checkProfile(candidate);
  const names = new Set([...pb.keys(), ...pc.keys()]);

  let better = false;
  const details: string[] = [];
  for (const name of names) {
    const b = pb.get(name) ?? { applicable: 0, failed: 0 };
    const c = pc.get(name) ?? { applicable: 0, failed: 0 };
    // Покрытие упало — кандидат просто перестал давать материал для проверки.
    if (c.applicable < b.applicable) {
      return {
        kind: 'base',
        detail: `покрытие ${name} ${b.applicable}→${c.applicable}`,
      };
    }
    if (c.failed > b.failed) {
      return { kind: 'base', detail: `${name} ${b.failed}→${c.failed}` };
    }
    if (c.failed < b.failed) {
      better = true;
      details.push(`${name} ${b.failed}→${c.failed}`);
    }
  }

  if (!better) return { kind: 'incomparable', detail: 'провалы не изменились' };
  return { kind: 'candidate', detail: details.join(', ') };
}

/**
 * Прежнее правило. Экспортируется ради проверки на исторических парах: скрипт
 * бэктеста прогоняет оба правила по одним и тем же разборам из журнала вызовов
 * и показывает, где они расходятся. В рантайме напрямую не вызывается — выбор
 * делает chooseBetterUpdResult по режиму.
 */
export function chooseV1(base: UpdPdfParsed, candidate: UpdPdfParsed): CompareResult {
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

/**
 * Правило v2: та же лестница критериев, но расхождения сравниваются ПО ВЕЛИЧИНЕ.
 *
 * Отличий от v1 ровно два, остальные шаги дословно те же:
 *
 *   1. вместо булева «есть расхождение / нет» — строгое Pareto-улучшение по
 *      вектору провалов при не меньшем покрытии (см. compareSeverity). Это и
 *      есть починка: на боевом УПД № 42 повтор снял тринадцать провалов
 *      построчной арифметики, а v1 объявила результат «равным»;
 *   2. при ДВУХ ПУСТЫХ списках позиций confidence больше не решает. Раньше
 *      сохранённый разбор вытеснялся кандидатом с `confidence 0.2` против `0`,
 *      хотя показать оба не могли ничего — так был заменён разбор сертификата
 *      соответствия, где товарной таблицы нет вовсе.
 */
export function chooseV2(base: UpdPdfParsed, candidate: UpdPdfParsed): CompareResult {
  const reasons: string[] = [];

  if ((base.items.length === 0) !== (candidate.items.length === 0)) {
    reasons.push(`items ${base.items.length} vs ${candidate.items.length}`);
    return { winner: candidate.items.length > 0 ? 'candidate' : 'base', reasons };
  }

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

  // Здесь и проходит вся разница с v1.
  const severity = compareSeverity(base, candidate);
  if (severity.kind === 'candidate') {
    reasons.push(`severity: ${severity.detail}`);
    return { winner: 'candidate', reasons };
  }
  if (severity.kind === 'base') {
    reasons.push(`severity: ${severity.detail}`);
    return { winner: 'base', reasons };
  }

  if (base.items.length !== candidate.items.length) {
    reasons.push(`items ${base.items.length} vs ${candidate.items.length}`);
    return { winner: candidate.items.length > base.items.length ? 'candidate' : 'base', reasons };
  }

  // Оба списка пусты — confidence замену НЕ инициирует.
  //
  // Показать нечего ни тому, ни другому, а замена сохранённого разбора стирает
  // ручные правки, если они были. Субъективная оценка модели такой цены не
  // стоит.
  if (base.items.length === 0) {
    reasons.push('оба разбора без позиций — сохраняем базу');
    return { winner: 'base', reasons };
  }

  if (base.confidence !== candidate.confidence) {
    reasons.push(`confidence ${base.confidence} vs ${candidate.confidence}`);
    return { winner: candidate.confidence > base.confidence ? 'candidate' : 'base', reasons };
  }

  reasons.push('equal');
  return { winner: 'base', reasons };
}

/**
 * Какое правило применять — решает окружение.
 *
 *   off    — прежнее поведение буква в букву;
 *   shadow — применяется прежнее, но в reasons добавляется решение нового.
 *            Через reasons оно попадает в `second_pass` без единой правки в
 *            worker: сохранение уже кладёт их туда целиком;
 *   on     — применяется новое.
 *
 * Промежуточный режим здесь не перестраховка. Доказать пользу правки по
 * агрегату нельзя: новый алгоритм по определению чаще заменяет базу, и падение
 * доли `kept_baseline` само по себе ничего не значит. Нужен список случаев, где
 * решения разошлись, — и человек, который их разберёт.
 */
export function chooseBetterUpdResult(base: UpdPdfParsed, candidate: UpdPdfParsed): CompareResult {
  const mode = loadEnv().UPD_RESULT_COMPARE_V2;
  if (mode === 'off') return chooseV1(base, candidate);

  const v1 = chooseV1(base, candidate);
  const v2 = chooseV2(base, candidate);
  if (mode === 'on') {
    if (v1.winner === v2.winner) return v2;
    return {
      winner: v2.winner,
      reasons: [...v2.reasons, `v1 решила иначе: ${v1.winner} (${v1.reasons.join('; ')})`],
    };
  }

  // shadow: применяем старое, но оставляем след нового.
  if (v1.winner === v2.winner) return v1;
  return {
    winner: v1.winner,
    reasons: [...v1.reasons, `v2 решила иначе: ${v2.winner} (${v2.reasons.join('; ')})`],
  };
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
  // Сырая графа 4 переносится по тому же правилу, что и сами стороны: у
  // победителя её может не быть (старый промпт, текстовый путь), а
  // свидетельство терять нельзя — по нему проверяется, не скопирован ли
  // грузополучатель у покупателя.
  if (next.consigneeRaw == null && loser.consigneeRaw != null) {
    next.consigneeRaw = loser.consigneeRaw;
    changed = true;
  }
  return changed ? next : winner;
}
