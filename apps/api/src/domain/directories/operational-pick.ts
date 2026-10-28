// Какую операционную строку `counterparties` вернуть, когда человек выбрал
// подрядчика из «Контрагентов» (POST /counterparties/from-directory).
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

import { companyKey } from './names.js';

export type OperationalRow = {
  id: string;
  name: string;
  kpp: string | null;
  createdAt: Date;
};

export function pickOperationalCounterparty<T extends OperationalRow>(
  rows: readonly T[],
  directory: { name: string; aliases?: readonly string[] | null },
  usage: ReadonlyMap<string, number>,
): T | undefined {
  if (rows.length <= 1) return rows[0];
  const keys = new Set(
    [directory.name, ...(directory.aliases ?? [])].map(companyKey).filter((k) => k !== ''),
  );
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
