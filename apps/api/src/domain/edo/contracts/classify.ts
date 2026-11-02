/**
 * Договор, ДС или что-то другое — по типу документа Диадока и имени файла.
 *
 * Договоры и ДС в ящике почти всегда неформализованные: PDF/DOCX без схемы, и
 * единственное, что о них известно без скачивания, — имя файла, которое задал
 * отправитель. Поэтому правила намеренно разделены на три исхода:
 *   - берём автоматически: типизированные «Договор»/«Доп. соглашение» и имена,
 *     в которых это прямо сказано;
 *   - на просмотр человеку: спецификации, приложения, протоколы разногласий,
 *     прочие соглашения — их берут, только если они пришли в пакете с договором
 *     или ДС, иначе решает пользователь по описи;
 *   - исключены: имя говорит о договоре, но документ — акт, КС, счёт и т. п.
 * Всё прочее неформализованное — «не распознано» и тоже видно в описи: правила
 * проверены на именах за последние месяцы, а не за пять лет.
 *
 * Границы слов здесь свои: `\b` в JS-регулярках знает только латиницу.
 */

export type NameCategory =
  | 'contract'
  | 'supplementary'
  | 'spec'
  | 'protocol'
  | 'agreement'
  | 'excluded'
  | 'unrecognized';

export type Selection = 'auto' | 'review' | 'excluded' | 'unrecognized';

/** Категории «на просмотр», которые пользователь может включить целиком. */
export const REVIEW_CATEGORIES = ['spec', 'protocol', 'agreement'] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

export const CONTRACT_TYPE = 'Contract';
export const SUPPLEMENTARY_TYPE = 'SupplementaryAgreement';
export const NONFORMALIZED_TYPE = 'Nonformalized';
/** Типы, по которым документ вообще проходит через отбор. */
export const CLASSIFIED_TYPES: ReadonlySet<string> = new Set([CONTRACT_TYPE, SUPPLEMENTARY_TYPE, NONFORMALIZED_TYPE]);

export type Classification = { category: NameCategory; selection: Selection; reason: string };

const L = '[а-яa-z0-9]';
/** Слово начинается здесь: слева не буква и не цифра. */
const start = (body: string) => `(?<!${L})(?:${body})`;
/** Слово целиком: и слева, и справа не буква и не цифра. */
const whole = (body: string) => `(?<!${L})(?:${body})(?!${L})`;

const EXCLUSIONS: { re: RegExp; label: string }[] = [
  { re: new RegExp(start('кс ?[23]'), 'u'), label: 'КС-2/КС-3' },
  { re: new RegExp(whole('акт[а-я]{0,3}'), 'u'), label: 'акт' },
  { re: new RegExp(start('сч[её]т'), 'u'), label: 'счёт' },
  { re: new RegExp(whole('упд|торг ?12|ттн'), 'u'), label: 'УПД/ТОРГ' },
  { re: new RegExp(start('претензи'), 'u'), label: 'претензия' },
  { re: new RegExp(start('реестр'), 'u'), label: 'реестр' },
  { re: new RegExp(start('письм'), 'u'), label: 'письмо' },
  { re: new RegExp(start('накладн'), 'u'), label: 'накладная' },
  { re: new RegExp(start('доверенност'), 'u'), label: 'доверенность' },
  { re: new RegExp(start('справк'), 'u'), label: 'справка' },
  { re: new RegExp(start('анализ субконто|оборотно сальдов'), 'u'), label: 'бухгалтерская выгрузка' },
];

// «соглашен», а не «соглашени»: в именах встречается «допсоглашенние».
const SUPPLEMENTARY = `доп(?:олнительн[а-я]*)?\\.? ?соглашен|допсоглашен|дс ?№? ?\\d|дс(?!${L})`;
/** ДС в начале имени: «ДС №1 к Спец. …», «дс6», «Дополнительное соглашение № 1». */
const SUPPLEMENTARY_HEAD = new RegExp(`^[^а-яa-z]*(?:${SUPPLEMENTARY})`, 'u');
// Слева допустима цифра: «КС3№7ДС5». Буква — нет: «НДС», «ДСП».
const SUPPLEMENTARY_ANY = new RegExp(`(?<![а-яa-z])(?:${SUPPLEMENTARY})`, 'u');
/** «договор», «дог0108-…», «дог. 551», «к дог. СУ1-10» и «ДП» (договор поставки) отдельным словом. */
const CONTRACT_WORD = new RegExp(`${start('договор')}|${start('дог\\.? ?№? ?\\d')}|${whole('дог|дп')}`, 'u');
const AGREEMENT_WORD = new RegExp(start('соглашен'), 'u');
/** Протокол разногласий; «ПСР» — протокол согласования разногласий. */
const PROTOCOL = new RegExp(`${start('протокол[а-я]* (?:согласования )?разноглас')}|${whole('пср')}`, 'u');
const SPEC_WORD = new RegExp(`${start('спецификац|приложени')}|${whole('спф|спец|прил')}`, 'u');
const REFERS_TO_CONTRACT = new RegExp(`${whole('к')} ?(?:договор|дог|дп|дс|доп)`, 'u');

/** Имя без расширения, в нижнем регистре, `ё` → `е`, `_` и повторные пробелы → пробел. */
export function normalizeName(raw: string): string {
  return raw
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[_\s]+/g, ' ')
    .replace(/-/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

export function classifyDocument(typeNamedId: string | null, fileName: string | null): Classification {
  if (typeNamedId === CONTRACT_TYPE) {
    return { category: 'contract', selection: 'auto', reason: 'тип документа Диадока «Договор»' };
  }
  if (typeNamedId === SUPPLEMENTARY_TYPE) {
    return { category: 'supplementary', selection: 'auto', reason: 'тип документа Диадока «Доп. соглашение»' };
  }
  return classifyName(fileName);
}

/** Отбор неформализованного документа по имени файла. */
export function classifyName(fileName: string | null): Classification {
  if (!fileName?.trim()) return { category: 'unrecognized', selection: 'unrecognized', reason: 'нет имени файла' };
  const n = normalizeName(fileName);
  const looksContractual = CONTRACT_WORD.test(n) || SUPPLEMENTARY_ANY.test(n) || AGREEMENT_WORD.test(n);

  const exclusion = EXCLUSIONS.find((x) => x.re.test(n));
  if (exclusion) {
    return looksContractual
      ? { category: 'excluded', selection: 'excluded', reason: `в имени договор/ДС, но это ${exclusion.label}` }
      : { category: 'unrecognized', selection: 'unrecognized', reason: `${exclusion.label}, не договор` };
  }
  if (SUPPLEMENTARY_HEAD.test(n)) {
    return { category: 'supplementary', selection: 'auto', reason: 'имя начинается с ДС / доп. соглашения' };
  }
  if (PROTOCOL.test(n)) {
    return { category: 'protocol', selection: 'review', reason: 'протокол разногласий' };
  }
  if (SPEC_WORD.test(n) && (REFERS_TO_CONTRACT.test(n) || CONTRACT_WORD.test(n) || SUPPLEMENTARY_ANY.test(n))) {
    return { category: 'spec', selection: 'review', reason: 'спецификация или приложение к договору/ДС' };
  }
  if (SUPPLEMENTARY_ANY.test(n)) {
    return { category: 'supplementary', selection: 'auto', reason: 'в имени ДС / доп. соглашение' };
  }
  if (CONTRACT_WORD.test(n)) {
    return { category: 'contract', selection: 'auto', reason: 'в имени «договор» / «ДП»' };
  }
  if (AGREEMENT_WORD.test(n)) {
    return { category: 'agreement', selection: 'review', reason: 'соглашение (не ДС)' };
  }
  return { category: 'unrecognized', selection: 'unrecognized', reason: 'имя не похоже на договор' };
}

const CONTRACT_REF =
  /(?<![\p{L}\p{N}])(?:договор[\p{L}]*|дог\.?|дп)[\s_.]*(?:(?:поставки|подряда|оказания услуг)[\s_]*)?№?[\s_]*([\p{L}\p{N}][\p{L}\p{N}./_-]*)/giu;

/**
 * Номер договора из имени файла — для колонки описи, по возможности. На отбор
 * не влияет. Токен без цифры номером не считается («Договор поставки корп. 14»).
 */
export function extractContractRef(fileName: string | null): string | null {
  if (!fileName) return null;
  const stem = fileName.replace(/\.[a-z0-9]{2,5}$/i, '');
  for (const m of stem.matchAll(CONTRACT_REF)) {
    const token = m[1]?.replace(/[._-]+$/u, '');
    if (!token || !/\d/.test(token)) continue;
    // Без «№» номером считаем только то, что начинается с цифры или с
    // заглавного кода и цифры («СУ-2-АЛ…», «ПМ-9-28»), а не «Изотерм_2-ой».
    if (m[0].includes('№') || /^\d/.test(token) || /^[A-ZА-ЯЁ]{1,6}[-_]?\d/u.test(token)) return token;
  }
  return null;
}

export const CATEGORY_LABELS: Record<NameCategory | 'package', string> = {
  contract: 'договор',
  supplementary: 'ДС',
  spec: 'спецификация',
  protocol: 'протокол разногласий',
  agreement: 'соглашение',
  excluded: 'исключён',
  unrecognized: 'не распознан',
  package: 'в пакете',
};
