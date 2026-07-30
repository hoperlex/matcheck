// Определение объекта (site) для письма с документами от подрядчика.
//
// Зачем. Объект невыводим из самого УПД: реквизиты его не содержат
// (грузополучатель — одно юрлицо, МОЛ пуст в 161 из 161 боевого документа),
// признак в файлах нашёлся лишь в 11 из 36 и неоднозначен. Отправитель тоже не
// помогает: 160 из 166 УПД приходят от одного контрагента, работающего на 17
// объектах. Поэтому объект приходит ТОЛЬКО из явного указания в письме.
//
// Почему автопроход разрешён исключительно по явному маркеру `Объект: <КОД>`.
// Совпадение по «голому» коду, названию или имени файла отправило бы настоящий
// УПД на чужую площадку:
//   - `ВЛ` (ЖК Варшавская Life) совпадает с «влд.» в адресе грузополучателя;
//   - `САД` («Садовническая 69») — обычное слово, а объекты БС2/БС3 называются
//     «ЖК Ботанический сад»;
//   - «Метрополия» — это 5 разных объектов (МЕ1.0…МЕ3.0), PRIMAVERA — 3,
//     «Событие» — СОБ2 и СОБ62.
// Такие совпадения возвращаются как ПОДСКАЗКИ для экрана разбора и никогда не
// приводят к автоматической отправке документа на объект.
//
// Модуль чистый: ни БД, ни сети. Справочник объектов передаётся аргументом.

/** Объект из справочника в том виде, в каком он нужен матчеру. */
export type SiteRef = {
  id: string;
  code: string;
  name: string;
  /** Адрес заполнен у 33 из 38 активных объектов — даёт различающие слова. */
  address?: string | null;
  isActive: boolean;
};

/** Откуда взялась подсказка — показывается оператору на экране разбора. */
export type HintSource = 'bare_code' | 'name' | 'filename';

export type SiteSuggestion = {
  siteId: string;
  code: string;
  source: HintSource;
};

export type SiteMatch =
  /** Ровно один валидный явный маркер — единственный случай автопрохода. */
  | { decision: 'explicit'; siteId: string; code: string }
  /** Несколько разных явных кодов: чей документ — неизвестно. */
  | { decision: 'ambiguous'; codes: string[]; suggestions: SiteSuggestion[] }
  /** Маркер есть, но такого кода в справочнике нет (опечатка, закрытый объект). */
  | { decision: 'unknown_code'; codes: string[]; suggestions: SiteSuggestion[] }
  /** Явного маркера нет — только подсказки, решает оператор. */
  | { decision: 'none'; suggestions: SiteSuggestion[] };

export type SiteMatchInput = {
  subject?: string | null;
  body?: string | null;
  filenames?: readonly string[];
};

/**
 * Технический объект: в матчинге не участвует никогда, иначе тестовые письма
 * начнут создавать документы на нём.
 */
const EXCLUDED_CODES = new Set(['test']);

/** Голый код принимается как подсказка только начиная с этой длины. */
const MIN_BARE_CODE_LENGTH = 4;

/**
 * Маркеры явного указания объекта. Двоеточие или тире, регистр не важен.
 * Значение — до конца строки: коды содержат точки (МЕ1.0), поэтому обрывать
 * по знакам препинания нельзя.
 */
const EXPLICIT_MARKER_RE =
  /(?:объект|площадка|обьект)\s*(?::|-|—|–)\s*([^\r\n;,]{1,40})/giu;

/**
 * Границы «слова» для кириллицы: \b в JS ориентируется на латиницу и цифры,
 * поэтому для кода вроде ЗИЛ33 он срабатывает не там, где нужно.
 */
function boundedCodeRe(code: string): RegExp {
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
}

/**
 * Отрезает цитату и подпись пересланной переписки.
 *
 * Без этого объект из старого письма перебивает объект нынешнего: подрядчики
 * пересылают ветку, где обсуждалась другая площадка.
 */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (
      /^-{2,}\s*(original message|forwarded message|пересылаемое сообщение)/iu.test(t) ||
      /^(от|from)\s*:/iu.test(t) ||
      /^(отправлено|sent)\s*:/iu.test(t) ||
      /^_{5,}$/.test(t) ||
      t.startsWith('>')
    ) {
      break;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Нормализация для сравнения кодов: регистр и внутренние пробелы не важны. */
function normalizeCode(raw: string): string {
  return raw.trim().replace(/\s+/gu, '').toUpperCase();
}

/**
 * Нормализация названия: убираем «ЖК», кавычки, дефисы и лишние пробелы —
 * подрядчик пишет «ЖК Сторис», «СТОРИС», «Сторис.» как одно и то же.
 */
function normalizeName(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[«»"'`]/gu, ' ')
    .replace(/\bЖК\b/gu, ' ')
    .replace(/[‑–—-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function usable(sites: readonly SiteRef[]): SiteRef[] {
  return sites.filter((s) => s.isActive && !EXCLUDED_CODES.has(s.code.toLowerCase()));
}

/**
 * Определяет объект письма.
 *
 * Автопроход (`decision: 'explicit'`) возможен только при ровно одном валидном
 * явном маркере. Всё остальное — работа оператора; подсказки прилагаются, но
 * решения не принимают.
 */
export function matchSite(input: SiteMatchInput, sites: readonly SiteRef[]): SiteMatch {
  const pool = usable(sites);
  const subject = input.subject ?? '';
  const body = stripQuoted(input.body ?? '');
  const filenames = input.filenames ?? [];
  const searchText = `${subject}\n${body}`;

  const byCode = new Map(pool.map((s) => [normalizeCode(s.code), s]));

  // ─── Явные маркеры: единственный путь к автопроходу ─────────────────────
  const explicitRaw: string[] = [];
  for (const m of searchText.matchAll(EXPLICIT_MARKER_RE)) {
    const value = m[1];
    if (value) explicitRaw.push(normalizeCode(value));
  }

  const known: SiteRef[] = [];
  const unknown: string[] = [];
  for (const raw of explicitRaw) {
    const site = byCode.get(raw);
    if (site) {
      if (!known.some((s) => s.id === site.id)) known.push(site);
    } else if (!unknown.includes(raw)) {
      unknown.push(raw);
    }
  }

  const suggestions = collectSuggestions(searchText, filenames, pool);

  if (known.length === 1 && unknown.length === 0) {
    const site = known[0]!;
    return { decision: 'explicit', siteId: site.id, code: site.code };
  }
  if (known.length > 1) {
    return { decision: 'ambiguous', codes: known.map((s) => s.code), suggestions };
  }
  if (unknown.length > 0) {
    // Маркер написан, но код не опознан — почти всегда опечатка. Молча
    // проваливаться в подсказки нельзя: оператор должен увидеть, что именно
    // написал подрядчик.
    return { decision: 'unknown_code', codes: unknown, suggestions };
  }
  return { decision: 'none', suggestions };
}

/**
 * Слова, которые есть у многих объектов и потому ничего не различают.
 * Без этого «ЖК», «очередь» или «шоссе» подсказывали бы что попало.
 */
const STOP_WORDS = new Set([
  'ЖК',
  'БАЗА',
  'ОЧЕРЕДЬ',
  'ОЧЕР',
  'ЭТАП',
  'КВАРТАЛ',
  'БЛОКИ',
  'БЛОК',
  'КОРПУС',
  'КОРП',
  'СТРОЕНИЕ',
  'СТР',
  'ДОМ',
  'ЛОТ',
  'УЛИЦА',
  'УЛИЦЫ',
  'ШОССЕ',
  'ПРОСПЕКТ',
  'ПЕРЕУЛОК',
  'НАБЕРЕЖНАЯ',
  'ВЛАДЕНИЕ',
  'ВЛАД',
  'МОСКВА',
  'ГОРОД',
  'ОБЛАСТЬ',
  'РАЙОН',
  'ПОСЕЛЕНИЕ',
]);

/** Разбор строки на значимые слова для сопоставления. */
function tokenize(raw: string): string[] {
  return normalizeName(raw)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w) && !/^\d+$/u.test(w));
}

/**
 * Подсказки для экрана разбора. К автопроходу не приводят никогда, поэтому
 * правила мягче, чем у явного маркера, — но не настолько, чтобы вводить
 * оператора в заблуждение.
 *
 * Ключевой приём: подсказка выдаётся только по слову, которое встречается
 * ровно у ОДНОГО объекта справочника. «Волоколамское» есть у пяти объектов,
 * «Автозаводская» — у двух, «Метрополия» — у пяти; такие слова отбрасываются
 * автоматически, без ручного списка исключений. А «Алия», «Зиларт»,
 * «Сторис» объект определяют однозначно.
 */
function collectSuggestions(
  searchText: string,
  filenames: readonly string[],
  pool: readonly SiteRef[],
): SiteSuggestion[] {
  // 1) Индекс «слово → объекты», по названию и адресу.
  const owners = new Map<string, Set<string>>();
  const byId = new Map(pool.map((s) => [s.id, s]));
  for (const site of pool) {
    for (const token of [...tokenize(site.name), ...tokenize(site.address ?? '')]) {
      let set = owners.get(token);
      if (!set) {
        set = new Set();
        owners.set(token, set);
      }
      set.add(site.id);
    }
  }

  const found = new Map<string, SiteSuggestion>();
  const add = (siteId: string, source: HintSource) => {
    const site = byId.get(siteId);
    if (site && !found.has(siteId)) {
      found.set(siteId, { siteId, code: site.code, source });
    }
  };

  const filenameText = filenames.join(' ');

  // 2) Голый код — только длинный: ВЛ, ЛК, САД дают ложные совпадения
  //    («влд.» в адресе, слово «сад» в «Ботаническом саду»).
  for (const site of pool) {
    if (site.code.length < MIN_BARE_CODE_LENGTH) continue;
    const re = boundedCodeRe(site.code);
    if (re.test(searchText)) add(site.id, 'bare_code');
    else if (re.test(filenameText)) add(site.id, 'filename');
  }

  // 3) Различающие слова названия и адреса.
  const textTokens = new Set(tokenize(searchText));
  const fileTokens = new Set(tokenize(filenameText));
  for (const [token, ids] of owners) {
    if (ids.size !== 1) continue;
    const siteId = [...ids][0]!;
    if (textTokens.has(token)) add(siteId, 'name');
    else if (fileTokens.has(token)) add(siteId, 'filename');
  }

  return [...found.values()];
}
