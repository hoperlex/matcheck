// Необязательные подсказки, которые подрядчик может написать в письме.
//
// В отличие от объекта (см. domain/sourceDocuments/siteHint.ts) ничего из
// этого не является обязательным: не распознали — письмо всё равно
// обрабатывается, просто поле остаётся пустым. Поэтому парсер намеренно
// строгий: лучше `null`, чем угаданная неверно дата поставки.

/**
 * Маркер даты поставки. «Дата документа» специально НЕ принимается — она уже
 * распознаётся из самого УПД, и путать её с датой привоза нельзя.
 */
const DELIVERY_DATE_MARKER =
  /(?:дата\s+(?:поставки|доставки|привоза)|поставка|доставка)\s*(?::|-|—|–)?\s*([^\r\n;,]{1,32})/giu;

/**
 * Только четырёхзначный год: «05.08» без года неоднозначен (прошлый год?
 * следующий?), а «05.08.26» неотличим от опечатки. Оба случая → null.
 */
const DAY_FIRST_RE = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/u;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** Календарная валидность: 30.02.2026 разбирается регексом, но не существует. */
function toIsoDate(year: number, month: number, day: number): string | null {
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return probe.toISOString().slice(0, 10);
}

function parseOne(raw: string): string | null {
  const value = raw.trim().replace(/\s+/gu, '');
  const dayFirst = DAY_FIRST_RE.exec(value);
  if (dayFirst) {
    return toIsoDate(Number(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1]));
  }
  const iso = ISO_RE.exec(value);
  if (iso) {
    return toIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }
  return null;
}

/**
 * Достаёт дату поставки из текста письма.
 *
 * Возвращает `YYYY-MM-DD` либо `null`, если даты нет, она невалидна или в
 * письме указано несколько разных дат. Письмо это никогда не блокирует:
 * пустая дата — штатное состояние, документ просто попадёт к инспектору не в
 * список «на сегодня», а в группу «остальные».
 */
export function parseDeliveryDateHint(text: string): string | null {
  const found = new Set<string>();
  for (const m of text.matchAll(DELIVERY_DATE_MARKER)) {
    const value = m[1];
    if (!value) continue;
    const parsed = parseOne(value);
    if (parsed) found.add(parsed);
  }
  // Несколько разных дат — гадать нельзя.
  return found.size === 1 ? [...found][0]! : null;
}
