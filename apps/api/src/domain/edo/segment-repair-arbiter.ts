// Арбитраж автоповтора сегмента: принимать ли пересобранный разбор.
//
// Повтор запускается только там, где валидация первого захода уже нашла
// расхождение — то есть кандидат сравнивается с заведомо небезупречным
// baseline. Отсюда три требования, и все три обязательны:
//
//   1. ПОКРЫТИЕ НЕ ПАДАЕТ. Валидатор считает отсутствующее значение успешно
//      пропущенной проверкой (`ok: true` + skipReason), поэтому «у кандидата
//      меньше провалов» само по себе не значит ничего: разбор, потерявший итог
//      и цены, получит почти чистый результат просто потому, что проверять
//      стало нечего.
//   2. PARETO ПО ПРОВАЛАМ, А НЕ «НОЛЬ ПРОВАЛОВ». Требовать чистую валидацию
//      нельзя: допуск sum_total абсолютный и равен двум копейкам, а модель
//      способна верно прочитать все строки и ошибиться в итоге на 20 ₽ (ровно
//      это случилось с УПД № 53). Такой кандидат обязан побеждать: расхождение
//      на 20 ₽ вместо потерянной строки на 1 043 565 ₽ — то самое улучшение,
//      ради которого повтор и делается.
//   3. УЛУЧШЕНИЕ ИМЕННО СТРОК. Без этого условия кандидат «чинит» расхождение
//      подгонкой шапки: оставляет те же две позиции, пишет totalSum равным их
//      сумме и получает чистую валидацию — а материалов по-прежнему 2 из 3.
//
// Почему не chooseBetterUpdResult. Во-первых, на бою действует chooseV1
// (UPD_RESULT_COMPARE_V2='off'), где после сравнения «есть расхождение / нет»
// идёт шаг «у кого больше позиций, тот и выиграл» — при двух расходящихся
// разборах задвоенный кандидат с шестью строками обыграл бы верный с тремя.
// Во-вторых, compareSeverity объявляет разборы несравнимыми при разном числе
// позиций, а для повтора это ОСНОВНОЙ случай: строку как раз и потеряли.
//
// Идентичность документа (номер, дата, стороны) в выборе не участвует и не
// перезаписывается — см. preserveDocumentIdentity.

import type { UpdPdfParsed } from '@matcheck/contracts';
import { checkProfile } from './upd-result-compare.js';

export type SegmentRepairVerdict = {
  accept: boolean;
  /** Человекочитаемые причины — в лог и в second_pass. */
  reasons: string[];
};

/** Проверки уровня документа: их применимость не зависит от числа строк. */
const DOCUMENT_CHECKS = new Set(['sum_total', 'vat_total', 'items_count', 'items_sequence']);

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Σ строк по графе 9 — то, что валидатор сверяет с итогом документа. */
function itemsTotal(p: UpdPdfParsed): number {
  return round2(p.items.reduce((acc, i) => acc + (i.sum ?? 0), 0));
}

/**
 * Наименование для сравнения составов: регистр, ё/е и пробелы значения не
 * имеют — модель переписывает их от запуска к запуску, а строка та же.
 */
function normalizeName(raw: string | null | undefined): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, '');
}

/** Мультимножество строк «наименование + сумма» для сравнения составов. */
function lineFingerprint(p: UpdPdfParsed): string[] {
  return p.items
    .map((i) => `${normalizeName(i.nameRaw)}|${i.sum != null ? round2(i.sum) : 'null'}`)
    .sort();
}

function sameLines(base: UpdPdfParsed, candidate: UpdPdfParsed): boolean {
  const a = lineFingerprint(base);
  const b = lineFingerprint(candidate);
  return a.length === b.length && a.every((v, idx) => v === b[idx]);
}

function multiset(list: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of list) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

/**
 * Кандидат размножил уже имевшиеся строки, не добавив ни одной новой.
 *
 * Отдельная проверка, потому что якорь её не ловит: задвоение ТОЖЕ приближает
 * Σ строк к итогу документа. На № 53 разбор из четырёх строк (две исходные,
 * каждая дважды) даёт 3 027 406 ₽ против якоря 2 557 288 ₽ — ближе, чем
 * исходные 1 513 703 ₽, и правило «Σ приблизилась» засчитало бы это как
 * починку. Спасал только провал items_sequence по дублям номеров, но стоит
 * модели пронумеровать строки подряд — и защиты не остаётся.
 *
 * Задвоение — самый частый класс расхождений на бою (51 документ из 93 с
 * провалом sum_total за неделю), поэтому проверка не теоретическая.
 */
function duplicatesGrew(base: UpdPdfParsed, candidate: UpdPdfParsed): boolean {
  const mb = multiset(lineFingerprint(base));
  const mc = multiset(lineFingerprint(candidate));
  let grew = false;
  for (const [key, count] of mc) {
    const was = mb.get(key) ?? 0;
    // Строка, которой у baseline не было вовсе, — это новый материал, а не
    // копия: именно его повтор и должен приносить.
    if (was === 0) return false;
    if (count > was) grew = true;
  }
  return grew;
}

/**
 * Покрытие и провалы по типам проверок, сопоставимые при РАЗНОМ числе строк.
 *
 * Документные проверки сравниваются как есть. Построчные — долями: у трёх
 * строк применимых проверок больше просто потому, что строк больше, и прямое
 * сравнение счётчиков объявило бы любой более полный разбор «лучше по
 * покрытию», ничего при этом не доказав.
 */
function coverageDrop(base: UpdPdfParsed, candidate: UpdPdfParsed): string | null {
  const pb = checkProfile(base);
  const pc = checkProfile(candidate);
  const baseRows = Math.max(base.items.length, 1);
  const candRows = Math.max(candidate.items.length, 1);

  for (const name of new Set([...pb.keys(), ...pc.keys()])) {
    const b = pb.get(name) ?? { applicable: 0, failed: 0 };
    const c = pc.get(name) ?? { applicable: 0, failed: 0 };
    if (DOCUMENT_CHECKS.has(name)) {
      if (c.applicable < b.applicable) return `покрытие ${name} ${b.applicable}→${c.applicable}`;
      continue;
    }
    const bShare = b.applicable / baseRows;
    const cShare = c.applicable / candRows;
    // Допуск в четверть строки: доли считаются на разных знаменателях, и
    // округление не должно выглядеть потерей данных.
    if (cShare + 0.25 / candRows < bShare) {
      return `покрытие ${name} ${b.applicable}/${baseRows}→${c.applicable}/${candRows}`;
    }
  }
  return null;
}

/**
 * Pareto по вектору провалов: ни по одному типу не хуже, хотя бы по одному
 * лучше. Построчные типы сравниваются долей провалов — по той же причине, что
 * и покрытие.
 */
function severity(
  base: UpdPdfParsed,
  candidate: UpdPdfParsed,
): { better: boolean; worse: string | null; details: string[] } {
  const pb = checkProfile(base);
  const pc = checkProfile(candidate);
  const details: string[] = [];
  let better = false;

  for (const name of new Set([...pb.keys(), ...pc.keys()])) {
    const b = pb.get(name) ?? { applicable: 0, failed: 0 };
    const c = pc.get(name) ?? { applicable: 0, failed: 0 };
    if (DOCUMENT_CHECKS.has(name)) {
      if (c.failed > b.failed)
        return { better: false, worse: `${name} ${b.failed}→${c.failed}`, details };
      if (c.failed < b.failed) {
        better = true;
        details.push(`${name} ${b.failed}→${c.failed}`);
      }
      continue;
    }
    const bShare = b.applicable > 0 ? b.failed / b.applicable : 0;
    const cShare = c.applicable > 0 ? c.failed / c.applicable : 0;
    if (cShare > bShare + 1e-9) {
      return {
        better: false,
        worse: `${name} ${b.failed}/${b.applicable}→${c.failed}/${c.applicable}`,
        details,
      };
    }
    if (cShare + 1e-9 < bShare) {
      better = true;
      details.push(`${name} ${b.failed}/${b.applicable}→${c.failed}/${c.applicable}`);
    }
  }
  return { better, worse: null, details };
}

/**
 * Доказательство, что улучшились СТРОКИ, а не переписалась шапка.
 *
 * Якорь — итог документа из baseline. Он прочитан по той же бумаге и в разы
 * надёжнее суммы неполного списка: на УПД № 53 якорь 2 557 288 ₽ при Σ строк
 * 1 513 703 ₽, и приближение к нему (2 557 268 ₽) — прямое свидетельство, что
 * потерянная строка вернулась. Сам якорь при этом может быть слегка неточен —
 * на № 53 модель ошиблась в нём на 20 ₽, — поэтому он используется только как
 * ориентир направления, а не как эталон равенства.
 */
function lineImprovement(base: UpdPdfParsed, candidate: UpdPdfParsed): string | null {
  const identical = sameLines(base, candidate);
  if (identical) {
    // Состав строк не тронут. Единственное, что мог сделать кандидат, —
    // переписать итог под свой неполный список. Это не починка.
    return base.totalSum !== candidate.totalSum
      ? 'состав строк не изменился, переписан только итог'
      : 'ни строки, ни итог не изменились';
  }

  if (duplicatesGrew(base, candidate)) {
    return 'строки задвоились: копии прежних позиций без новых';
  }

  const anchor = base.totalSum;
  if (anchor != null) {
    const wasGap = Math.abs(itemsTotal(base) - anchor);
    const nowGap = Math.abs(itemsTotal(candidate) - anchor);
    if (nowGap < wasGap) return null;
    return `Σ строк не приблизилась к итогу (${round2(wasGap)} → ${round2(nowGap)})`;
  }

  // Якоря нет: у baseline не было итога. Тогда единственное безопасное
  // свидетельство — строк стало больше, а сумма не уменьшилась.
  if (candidate.items.length > base.items.length && itemsTotal(candidate) >= itemsTotal(base)) {
    return null;
  }
  return 'без итога документа улучшение строк не доказано';
}

/** Принимать ли результат повтора вместо сохранённого разбора. */
export function decideSegmentRepair(
  base: UpdPdfParsed,
  candidate: UpdPdfParsed,
): SegmentRepairVerdict {
  if (candidate.items.length === 0) {
    return { accept: false, reasons: ['кандидат без позиций'] };
  }

  const dropped = coverageDrop(base, candidate);
  if (dropped) return { accept: false, reasons: [dropped] };

  const notImproved = lineImprovement(base, candidate);
  if (notImproved) return { accept: false, reasons: [notImproved] };

  const sev = severity(base, candidate);
  if (sev.worse) return { accept: false, reasons: [sev.worse] };
  if (!sev.better) return { accept: false, reasons: ['провалы проверок не уменьшились'] };

  return { accept: true, reasons: sev.details };
}

/**
 * Идентичность документа автоповтор менять не вправе.
 *
 * headerCompleteness в upd-result-compare считает только НАЛИЧИЕ полей, не их
 * значения, поэтому кандидат может подставить другой непустой номер, дату или
 * поставщика — и общий путь сохранения это запишет. Повтор затевался ради
 * строк: их, итог и НДС он менять может, а реквизиты — только дозаполнять.
 */
export function preserveDocumentIdentity(
  base: UpdPdfParsed,
  candidate: UpdPdfParsed,
): UpdPdfParsed {
  return {
    ...candidate,
    docNumber: base.docNumber ?? candidate.docNumber,
    docDate: base.docDate ?? candidate.docDate,
    supplier: base.supplier ?? candidate.supplier,
    recipient: base.recipient ?? candidate.recipient,
    consignee: base.consignee ?? candidate.consignee,
  };
}

/**
 * Текст, который повтор дописывает к активному промпту.
 *
 * Именно дописывает: promptOverride в resolvePrompt ЗАМЕНЯЕТ активную версию
 * целиком, и через него повтор потерял бы всю действующую инструкцию.
 */
export function buildRepairHint(base: UpdPdfParsed): string {
  const itemsSum = base.items.reduce((acc, i) => acc + (i.sum ?? 0), 0);
  const money = (n: number): string => n.toFixed(2).replace('.', ',');
  const lines = [
    '# Повторное чтение: прошлый ответ не сошёлся с документом',
    '',
    `В прошлый раз извлечено позиций: ${base.items.length}, их суммарная стоимость с НДС — ${money(itemsSum)} ₽.`,
  ];
  if (base.totalSum != null) {
    lines.push(`Итог документа («Всего к оплате») при этом — ${money(base.totalSum)} ₽.`);
  }
  lines.push(
    '',
    'Прочитай табличную часть заново и выпиши ВСЕ строки, включая продолжение',
    'таблицы на следующих листах. Строки с похожими наименованиями — разные',
    'позиции: одинаковое начало названия не повод объединять их в одну.',
    'Номера позиций бери из графы 1 бланка, не нумеруй заново.',
  );
  return lines.join('\n');
}
