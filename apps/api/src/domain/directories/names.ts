// Имена и ИНН для импорта справочников (поставщики BillHub, подрядчики 1С).
//
// Здесь только сравнение и приведение к виду справочника. Хранимое имя
// сохраняет форму собственности (ООО/АО/ИП): АО «Монолитстрой» и ООО
// «Монолитстрой» — разные юрлица. Форма, кавычки, регистр, ё и опечатки
// «000/OOO/ОО» игнорируются только в ключах сравнения.
//
// Границы слов — через \p{L} с флагом u: \b в JS работает только с латиницей,
// и «ООО» в «ЭСКО ООО» им не ловится.

import { isValidInnChecksum, normalizeInn } from '../sourceDocuments/resolve-contractor.js';

export type LegalForm = 'ООО' | 'АО' | 'ИП';

export function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// Латиница, которую выгрузки ставят вместо кириллицы («OOO», «CТРОЙ»).
const LATIN_LOOKALIKES: Record<string, string> = {
  A: 'А',
  B: 'В',
  C: 'С',
  E: 'Е',
  H: 'Н',
  K: 'К',
  M: 'М',
  O: 'О',
  P: 'Р',
  T: 'Т',
  X: 'Х',
  Y: 'У',
};

const FORM_TOKENS: Record<string, LegalForm> = {
  ООО: 'ООО',
  // Опечатки выгрузок: нули вместо «О» и потерянная буква.
  '000': 'ООО',
  ОО: 'ООО',
  АО: 'АО',
  ПАО: 'АО',
  ЗАО: 'АО',
  ОАО: 'АО',
  НАО: 'АО',
  ИП: 'ИП',
};

/** Слова отчества, которые не дают инициала («Гаджиев Хаял Меджнун Оглы»). */
const PATRONYMIC_PARTICLES = new Set(['ОГЛЫ', 'КЫЗЫ', 'УГЛИ', 'ОГЛИ']);

const BRACKET_INN_RE = /\(\s*(?:ИНН\s*)?(\d{9,12})\s*\)/iu;

function tokens(name: string): string[] {
  const upper = name
    .toUpperCase()
    .replace(/Ё/g, 'Е')
    .replace(/[ABCEHKMOPTXY]/g, (ch) => LATIN_LOOKALIKES[ch] ?? ch)
    .replace(/ОБЩЕСТВО\s+С\s+ОГРАНИЧЕННОЙ\s+ОТВЕТСТВЕННОСТЬЮ/g, ' ООО ')
    .replace(/(?:(?:НЕ)?ПУБЛИЧНОЕ\s+|ЗАКРЫТОЕ\s+|ОТКРЫТОЕ\s+)?АКЦИОНЕРНОЕ\s+ОБЩЕСТВО/g, ' АО ')
    .replace(/ИНДИВИДУАЛЬНЫЙ\s+ПРЕДПРИНИМАТЕЛЬ/g, ' ИП ')
    .replace(/\(\s*(?:ИНН\s*)?\d{9,12}\s*\)/g, ' ')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/[«»"'‘’“”„‚ʼ`.,;:!?()[\]{}/\\|+*#№&]/g, ' ')
    .replace(/\s*-\s*/g, '-');
  return upper.split(/\s+/).filter((t) => t !== '' && t !== '-');
}

/** Ключ сравнения: имя без формы собственности, кавычек и регистра. */
export function companyKey(name: string): string {
  return tokens(name)
    .filter((t) => !(t in FORM_TOKENS))
    .join(' ');
}

/** Ключ без учёта порядка слов: 1С пишет «ГОРИЗОНТ СК», справочник — «СК Горизонт». */
export function tokenKey(name: string): string {
  return tokens(name)
    .filter((t) => !(t in FORM_TOKENS))
    .sort()
    .join(' ');
}

/** Форма собственности по имени; ПАО/ЗАО/ОАО/НАО — семейство АО. */
export function legalForm(name: string): LegalForm | null {
  for (const t of tokens(name)) {
    const form = FORM_TOKENS[t];
    if (form) return form;
  }
  return null;
}

/** Формы противоречат, только если распознаны обе и различаются. */
export function formsCompatible(a: string, b: string): boolean {
  const fa = legalForm(a);
  const fb = legalForm(b);
  return !fa || !fb || fa === fb;
}

/**
 * Опечатка формы в начале имени → «ООО »: «000 Компания "Карат"»,
 * «OOO "ТД "АНМАКС"» (латиница), «ОО "Пластко"». Остальное не трогаем.
 */
export function fixLegalFormTypo(name: string): string {
  const trimmed = name.trim();
  const m = /^([0OО]{3}|ОО)(?=[\s"«“„])/u.exec(trimmed);
  if (!m || m[1] === 'ООО') return trimmed;
  return `ООО${trimmed.slice(m[1]!.length)}`;
}

/**
 * Фамилия и инициалы: «Порунов Артём Владимирович» и «ИП Порунов А.В.» дают
 * «ПОРУНОВ АВ». null, если имя не похоже на ФИО.
 */
export function personInitialsKey(name: string): string | null {
  const t = tokens(name).filter((x) => !(x in FORM_TOKENS) && !PATRONYMIC_PARTICLES.has(x));
  if (t.length < 2 || t.length > 3) return null;
  if (!t.every((x) => /^[А-Я-]+$/u.test(x))) return null;
  const [surname, ...rest] = t;
  return `${surname} ${rest.map((x) => x[0]).join('')}`;
}

export type BracketInn = {
  /** Имя без скобки с ИНН. */
  base: string;
  /** ИНН из скобки, если контрольная сумма сошлась. */
  inn: string | null;
  /** Цифры из скобки как есть (для находки «неверный ИНН»). */
  innRaw: string | null;
};

/** «АЛЬЯНС ООО (7716967786)», «МАСТЕР ООО (ИНН5017084167)», «ПЕРСПЕКТИВА ООО( ИНН9717168726)». */
export function extractBracketInn(raw: string): BracketInn {
  const m = BRACKET_INN_RE.exec(raw);
  if (!m) return { base: collapseSpaces(raw), inn: null, innRaw: null };
  const base = collapseSpaces(raw.slice(0, m.index) + ' ' + raw.slice(m.index + m[0].length));
  return { base, inn: normalizeInn(m[1]!), innRaw: m[1]! };
}

/**
 * Имя подрядчика из 1С в стиле справочника: «ЭСКО ООО» → `ООО "ЭСКО"`,
 * «Каширин А. Г. ИП» → «ИП Каширин А. Г.». Нестандартное («ГРАДДОМСТРОЙ ООО
 * ИК»), физлица и уже правильное оставляем как есть.
 */
export function styleContractorName(base: string): string {
  const s = collapseSpaces(base);
  const org = /^(.+?)\s+(ООО|АО|ПАО|ЗАО|ОАО|НАО)$/u.exec(s);
  if (org && !/["«»]/.test(org[1]!)) return `${org[2]} "${org[1]}"`;
  const ip = /^(.+?)\s+ИП$/u.exec(s);
  if (ip) return `ИП ${ip[1]}`;
  return s;
}

/** Цифры ИНН длиной 10/12 без проверки контрольной суммы — для сопоставления. */
export function innDigits(raw: string | null | undefined): string | null {
  const d = (raw ?? '').replace(/\D/g, '');
  return d.length === 10 || d.length === 12 ? d : null;
}

/** Корректный ИНН (длина и контрольная сумма) или null. */
export function validInn(raw: string | null | undefined): string | null {
  return normalizeInn(raw);
}

/** ИНН для новой строки: чистые цифры, если ИНН корректен, иначе как в источнике. */
export function cleanInn(raw: string): string {
  return normalizeInn(raw) ?? raw.trim();
}

export { isValidInnChecksum };

/**
 * Расстояние Дамерау–Левенштейна (оптимальное выравнивание строк): замена,
 * вставка, удаление и перестановка соседних символов стоят 1.
 */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = v;
    }
  }
  return d[m]![n]!;
}

export const ALIASES_MAX = 20;
export const ALIAS_MAX_LEN = 500;

function aliasKey(s: string): string {
  return collapseSpaces(s).toLowerCase();
}

/**
 * Дописать алиасы в пределах лимитов карточки (контракт: до 20 штук по 500
 * символов), без повторов (регистр и пробелы не различаются) и без дубля
 * самого имени. Существующие не трогаем; что не влезло — в `dropped`.
 */
export function mergeAliases(
  existing: readonly string[],
  add: readonly string[],
  name: string,
): { aliases: string[]; added: string[]; dropped: string[] } {
  const aliases = [...existing];
  const seen = new Set([aliasKey(name), ...existing.map(aliasKey)]);
  const added: string[] = [];
  const dropped: string[] = [];
  for (const raw of add) {
    const a = collapseSpaces(raw);
    if (!a || seen.has(aliasKey(a))) continue;
    if (a.length > ALIAS_MAX_LEN || aliases.length >= ALIASES_MAX) {
      dropped.push(a);
      continue;
    }
    seen.add(aliasKey(a));
    aliases.push(a);
    added.push(a);
  }
  return { aliases, added, dropped };
}
