// Какую операционную строку `counterparties` вернуть, когда человек выбрал
// подрядчика из «Контрагентов» (POST /counterparties/from-directory) или
// поставщика из «Поставщиков» (supplier-counterparty.ts).
//
// По одному ИНН в операционной таблице бывает несколько строк: обособленные
// подразделения с разными КПП и мусор распознавания. Например, у ИНН
// СТРОЙПАРТНЕРа рядом с «ООО "СтройПартнер"» лежит «ООО "СТРОЙСЕРВИС"»:
// модель взяла ИНН одной стороны и имя другой. Раньше маршрут брал строку
// через LIMIT 1 без порядка, и в чипе «Получатель» могло оказаться чужое имя.
//
// Порядок выбора:
//   1. имя (без формы, кавычек и регистра) как у записи «Контрагентов» или её
//      алиаса;
//   2. строка без КПП — основная, а не обособленное подразделение;
//   3. больше всего приёмок ссылается на строку как на получателя;
//   4. самая старая, затем по id — чтобы результат не зависел от плана запроса.
// При одной строке на ИНН результат прежний: выбирать не из чего.

import { companyKey, editDistance, tokenKey } from './names.js';

export type OperationalRow = {
  id: string;
  name: string;
  kpp: string | null;
  createdAt: Date;
};

export type DirectoryName = { name: string; aliases?: readonly string[] | null };

function directoryKeys(directory: DirectoryName): Set<string> {
  return new Set(
    [directory.name, ...(directory.aliases ?? [])].map(companyKey).filter((k) => k !== ''),
  );
}

/** Имя операционной строки совпадает с записью справочника или её алиасом. */
export function operationalNameMatches(name: string, directory: DirectoryName): boolean {
  return directoryKeys(directory).has(companyKey(name));
}

/**
 * Два имени при одном ИНН — одна организация, записанная по-разному: другой
 * порядок слов («СК Горизонт» / «ГОРИЗОНТ СК») или опечатка в 1–2 знака
 * («КЕРАМЕС ГРУПП» / «КЕРАМЕС ГРУП»; «ЮТЕХ ДИСТРИБЬЮШН» / «КОТЕХ ДИСТРИБЬЮШН» —
 * 2 знака, ровно на пороге).
 *
 * Порог зависит от длины: у коротких ключей допуск нулевой, иначе «КТМ» и
 * «КТС» сошлись бы. Сокращения («РС» / «Русский Свет») сюда не попадают:
 * правило по общим словам склеило бы и «ЗМ ГРУПП» с «КРОНОС ГРУПП».
 * Порядок слов и опечатка вместе тоже не ловятся: «ГРУП КЕРАМЕС» /
 * «КЕРАМЕС ГРУПП» — 11 знаков, отказ (на бою 17.11 таких пар нет).
 *
 * Нужна для выбора поставщика (supplier-counterparty.ts): отказывать стоит,
 * только когда под ИНН записана действительно другая организация (на бою
 * ближайшая такая пара — «ТОРГОВЫЙ ДОМ ТУЛА-СТАЛЬ» / «М-ТЕРМИНАЛ», 19 знаков).
 */
export function sameCompanySpelling(a: string, b: string): boolean {
  const ka = companyKey(a);
  const kb = companyKey(b);
  if (ka === '' || kb === '') return false;
  if (ka === kb || tokenKey(a) === tokenKey(b)) return true;
  const allowed = Math.min(2, Math.floor(Math.max(ka.length, kb.length) / 5));
  return editDistance(ka, kb) <= allowed;
}

/** То же против записи справочника и её алиасов. */
export function operationalNameClose(name: string, directory: DirectoryName): boolean {
  return [directory.name, ...(directory.aliases ?? [])].some((d) => sameCompanySpelling(name, d));
}

export function pickOperationalCounterparty<T extends OperationalRow>(
  rows: readonly T[],
  directory: DirectoryName,
  usage: ReadonlyMap<string, number>,
): T | undefined {
  if (rows.length <= 1) return rows[0];
  const keys = directoryKeys(directory);
  const rank = (r: T) => ({
    nameMatch: keys.has(companyKey(r.name)) ? 0 : 1,
    noKpp: r.kpp?.trim() ? 1 : 0,
    usage: -(usage.get(r.id) ?? 0),
  });
  return [...rows].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return (
      ra.nameMatch - rb.nameMatch ||
      ra.noKpp - rb.noKpp ||
      ra.usage - rb.usage ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id)
    );
  })[0];
}
