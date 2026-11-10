// Объект договора 1С по тексту: наименование + номер + «ОбъектВыполнения».
//
// Объект в выгрузке 1С отдельным полем почти не заполнен (505 из 6 007), зато
// зашит в наименование («Автозаводская ул., вл.23/2 ЖК ЗИЛАРТ (ЛОТ 33), ДГ
// №СУ-ЗИЛ33/25-33 …») и в номер («СУ-ПРИМ22/2023-30», распред. письмо
// «ИНДЖ-12»). Результат — ПОДСКАЗКА подбора (порядок и метки), а не запрет.
//
// Правило — точное (один объект) или групповое (законная группа: «ЗИЛАРТ» без
// лота — это ЗИЛ18 или ЗИЛ33). Итог:
//  - S — коды точных правил, G — множества групповых;
//  - пересечение всех групп I (вложенные группы уточняют друг друга:
//    «Волгоградский пр-т» ⊃ «Метрополия, 2-я очередь»);
//  - |S| ≥ 2 → conflict (адрес одного объекта, номер другого);
//  - |S| = 1: код входит в каждую группу → exact, иначе conflict;
//  - S пусто: I из одного кода → exact, из нескольких → group, пусто при
//    непустом G → conflict (несовместимые группы), G пусто → none.
//
// Границы слов явные: `\b` в JS с кириллицей не работает. Голого «-ИНЖ» нет
// намеренно: в распред. письмах «Инж» — направление работ («0002-KING-Инж» —
// это КИНГ, а не ИНДЖОЙ).

export type SiteDetectStatus = 'exact' | 'group' | 'conflict' | 'none';

export type SiteRule = {
  id: string;
  /** Один код — точное правило, несколько — групповое. */
  codes: readonly string[];
  re: RegExp;
  /** Правило не применяется, если текст совпал с этим шаблоном. */
  unless?: RegExp;
  /** Правило применяется, только если текст совпал и с этим шаблоном. */
  requires?: RegExp;
};

export type SiteDetectResult = {
  status: SiteDetectStatus;
  /** Коды объектов (при conflict — все претенденты), по алфавиту. */
  codes: string[];
  /** id сработавших правил — для отчёта и подсказки. */
  rules: string[];
};

/** Левая и правая граница «слова» для кириллицы и латиницы. */
const L = '(?<![А-ЯA-Z0-9])';
const R = '(?![А-ЯA-Z0-9])';
const re = (src: string) => new RegExp(src);

const METRO = re('ВОЛГОГРАДСК|МЕТРОПОЛ|СУ-МЕТ');
const ILMEN = re('ИЛЬМЕНСК|СУ-ИЛ[3З]?/|СУ-СС/');
const RENOVATION = re('РЕНОВАЦИ|СУ-ДМР/|СУ-ДРМ/');

export const SITE_RULES: readonly SiteRule[] = [
  // ── ЗИЛАРТ: лот 33 (ЖК МАРК) и лот 18 (ГРАНД), без лота — группа ──
  { id: 'zil33.lot', codes: ['ЗИЛ33'], re: re(`ЛОТ\\s*№?\\s*33${R}`) },
  { id: 'zil33.code', codes: ['ЗИЛ33'], re: re(`ЗИЛ\\s*33${R}`) },
  { id: 'zil33.mark', codes: ['ЗИЛ33'], re: re(`${L}МАРК${R}`) },
  { id: 'zil18.lot', codes: ['ЗИЛ18'], re: re(`ЛОТ[ЫА]?\\s*№?\\s*18${R}`) },
  { id: 'zil18.code', codes: ['ЗИЛ18'], re: re(`ЗИЛ\\s*18${R}|ДОМ\\s*18${R}`) },
  {
    id: 'zil.group',
    codes: ['ЗИЛ18', 'ЗИЛ33'],
    re: re(`ЗИЛАРТ|АВТОЗАВОДСК|СУ-ЗИЛ/|СУ-ЗА/|${L}ЗИЛ${R}`),
  },

  // ── СОБЫТИЕ (Раменки): 6.1, 6.2, «6» — группа 6.1+6.2; «2» — СОБЫТИЕ-2 ──
  { id: 'sob61', codes: ['СОБ61'], re: re(`СОБЫТИЕ[\\s-]*6\\.1${R}|СУ-СОБ\\s*6\\.1/`) },
  { id: 'sob62', codes: ['СОБ62'], re: re(`СОБЫТИЕ[\\s-]*6\\.2${R}|СУ-СОБ\\s*6\\.2/`) },
  { id: 'sob6.group', codes: ['СОБ61', 'СОБ62'], re: re(`СОБЫТИЕ[\\s-]*6(?![.\\d])|СУ-СОБ6/`) },
  { id: 'sob2', codes: ['СОБ2'], re: re(`СОБЫТИЕ[\\s-]*2(?![.\\d])|СУ-СОБ2/`) },

  // ── ДОМ 56 (Фридриха Энгельса); реновация на той же улице — другой проект ──
  { id: 'd56.name', codes: ['Д56'], re: re(`ДОМ\\s*56${R}|56/1${R}|СУ-ДМ(56)?/|СУ-ДОМ\\s*56/|СУ-ДМ-ФР`) },
  {
    id: 'd56.address',
    codes: ['Д56'],
    re: re('ФРИДРИХА ЭНГЕЛЬСА'),
    unless: RENOVATION,
  },

  // ── ALIA (Лётная) ──
  { id: 'al13', codes: ['АЛ13'], re: re(`${L}[AÁ]LIA${R}|${L}АЛИЯ${R}|ЛЕТНАЯ|СУ-АЛ/`) },

  // ── PRIMAVERA (Волоколамское ш., 71/13 · 71/14 · 71/12) ──
  { id: 'prim13', codes: ['ПРИМ13'], re: re(`71/13${R}|СУ-ПР(ИМ)?\\s*13/|СУ-П13/|VIVALDI`) },
  { id: 'prim14', codes: ['ПРИМ14'], re: re(`71/14${R}|СУ-ПР(ИМ)?\\s*14/|BELLINI`) },
  { id: 'prim22', codes: ['ПРИМ22'], re: re(`71/12${R}|СУ-ПР(ИМ+)?\\s*22/|ROSSINI`) },
  {
    id: 'prim.group',
    codes: ['ПРИМ13', 'ПРИМ14', 'ПРИМ22'],
    re: re('PRIMAVERA|ПРИМАВЕР|СУ-ПРИМ/'),
  },

  // ── INJOY (Адмирала Макарова) ──
  {
    id: 'injoy',
    codes: ['ИНДЖ'],
    re: re(`INJOY|JNJOY|ИНДЖОЙ|${L}ИНДЖ${R}|АДМИРАЛА МАКАРОВА|СУ-ИНЖ/`),
  },

  // ── KING&SONS (Мосфильмовская) ──
  { id: 'king', codes: ['КИНГ'], re: re(`${L}KING${R}|${L}КИНГ|МОСФИЛЬМОВСК|СУ-КС/|СУ-КНС/`) },

  // ── WAVE (Борисовские Пруды) ──
  { id: 'wave', codes: ['ВЕЙ2'], re: re(`${L}WAVE${R}|ВЕЙВ|БОРИСОВСКИЕ ПРУДЫ|СУ-БП/`) },

  // ── STORIES (Раменки ВТМО) ──
  { id: 'stories', codes: ['СТОР'], re: re('STORIES|СТОРИЗ|СТОРИС|124/3А|СУ-СТ/') },

  // ── CITY BAY (Волоколамское ш., 97 — 1 этап, 93-97 — 2 этап) ──
  { id: 'cb2', codes: ['СБ2'], re: re(`93-97|СУ-СБ2(-\\d+)?/|СУ-СИТИ2/`) },
  { id: 'cb1', codes: ['СБ1'], re: re(`ВЛ\\.?\\s*97${R}|СУ-СБ1(-\\d+)?/`) },
  { id: 'cb.group', codes: ['СБ1', 'СБ2'], re: re('CITY BAY|СИТИ БЕЙ|СУ-СБ/') },

  // ── Метрополия (Волгоградский пр-т): 1-я очередь, 2-я (этапы 1.1, 1.2, 2), 3-я ──
  { id: 'me10', codes: ['МЕ1.0'], re: re(`32/3${R}|СУ-МЕТ1/`), requires: METRO },
  { id: 'me11', codes: ['МЕ1.1'], re: re(`ЭТ(АП|\\.)?\\s*1\\.1${R}|СУ-МЕТ2-1\\.1/`), requires: METRO },
  { id: 'me12', codes: ['МЕ1.2'], re: re(`ЭТ(АП|\\.)?\\s*1\\.2${R}|СУ-МЕТ2-1\\.2/`), requires: METRO },
  {
    id: 'me20',
    codes: ['МЕ2.0'],
    re: re(`ОЧ\\.?\\s*2,?\\s*ЭТ(АП|\\.)?\\s*2(\\.0)?(?![.\\d])|СУ-МЕТ2-2/`),
    requires: METRO,
  },
  {
    id: 'me30',
    codes: ['МЕ3.0'],
    re: re(`ВЛ\\.?\\s*32,?\\s*К\\.?\\s*3${R}|ВЛ\\.?\\s*32,?\\s*ЭТАП\\s*3${R}|СУ-МЕТ3/`),
    requires: METRO,
  },
  { id: 'me2.group', codes: ['МЕ1.1', 'МЕ1.2', 'МЕ2.0'], re: re(`ОЧ\\.?\\s*2${R}|СУ-МЕТ2/`), requires: METRO },
  {
    id: 'me.group',
    codes: ['МЕ1.0', 'МЕ1.1', 'МЕ1.2', 'МЕ2.0', 'МЕ3.0'],
    re: re('ВОЛГОГРАДСКИЙ ПР|МЕТРОПОЛ|СУ-МЕТ'),
  },

  // ── Прочие объекты одной улицей/кодом ──
  { id: 'sad', codes: ['САД'], re: re('САДОВНИЧЕСК|СУ-САД/') },
  { id: 'nst', codes: ['НСТ'], re: re('ВИННИЦК|НАСТОЯЩЕЕ|СУ-ВИН/') },
  { id: 'pavs', codes: ['ПАВС'], re: re('ДУБИНИНСК|ПАВЕЛЕЦК|СУ-ДУБ/') },
  { id: 'vl', codes: ['ВЛ'], re: re('КОТЛЯКОВСК|ВАРШАВСК|СУ-КОТ2/') },
  { id: 'toph', codes: ['ТОПХ'], re: re(`ЭЛЕКТРОЛИТН|ТОП\\s*ХИЛС|СУ-ЭЛ(-\\d+)?/`) },
  { id: 'ogn', codes: ['ОГН'], re: re(`${L}ОГНИ${R}|СУ-ОГ2/`) },
  { id: 'sas3', codes: ['САС3'], re: re('САВЕЛОВСК|СКЛАДОЧН') },
  { id: 'sip', codes: ['СИП'], re: re('СИРЕНЕВ') },
  { id: 'tag.group', codes: ['СИП', 'ТГЛ'], re: re('ТАГИЛЬСК|СУ-ТАГ\\d*/') },
  { id: 'lk', codes: ['ЛК'], re: re('КУТУЗОВСК') },
  { id: 'gzht.group', codes: ['ГЖТ', 'ЛК'], re: re('ГЖАТСК') },
  { id: 'ss3', codes: ['СС3'], re: re(`3-Я ОЧЕРЕД|ОЧ\\.?\\s*3${R}|${L}3 ОЧ|СУ-ИЛ[3З]/`), requires: ILMEN },
  { id: 'ss.group', codes: ['СС2', 'СС3'], re: ILMEN },
  { id: 'dpr', codes: ['ДПР'], re: re('ХОВРИНО[\\s-]*СЕВЕРН|ДИСКАВЕРИ ПАРК') },
  { id: 'dsk', codes: ['ДСК'], re: re('ХОВРИНО[\\s-]*ЮЖН|СУ-ТПУ-ХОВ/') },
  { id: 'hov.group', codes: ['ДПР', 'ДСК'], re: re('ХОВРИНО|ДЫБЕНКО|СУ-ХОВ/') },
  { id: 'bs2', codes: ['БС2'], re: re('СЕРЕБРЯКОВ') },
  { id: 'bs3', codes: ['БС3'], re: re('ЛАЗОРЕВ') },
  { id: 'bs.group', codes: ['БС2', 'БС3'], re: re('БОТАНИЧЕСК') },
];

/** Текст для правил: верхний регистр, ё→е, пробелы схлопнуты. */
export function siteRuleText(parts: ReadonlyArray<string | null | undefined>): string {
  return parts
    .filter((p): p is string => !!p && p.trim() !== '')
    .join(' | ')
    .toUpperCase()
    .replace(/Ё/g, 'Е')
    .replace(/\s+/g, ' ')
    .trim();
}

const sorted = (s: Iterable<string>) => [...s].sort((a, b) => a.localeCompare(b, 'ru'));

/**
 * Объект договора по тексту — по всем правилам, без оглядки на объекты портала:
 * коды, которых в портале нет, отбрасывает план импорта (desiredFields) уже
 * после, чтобы группа с одним известным объектом не стала «точно».
 */
export function detectContractSites(text: string, rules: readonly SiteRule[] = SITE_RULES): SiteDetectResult {
  const fired: SiteRule[] = [];
  for (const rule of rules) {
    if (!rule.re.test(text)) continue;
    if (rule.unless?.test(text)) continue;
    if (rule.requires && !rule.requires.test(text)) continue;
    fired.push(rule);
  }
  const exact = new Set<string>();
  const groups: Set<string>[] = [];
  for (const rule of fired) {
    if (rule.codes.length === 1) exact.add(rule.codes[0]!);
    else groups.push(new Set(rule.codes));
  }
  const ruleIds = fired.map((r) => r.id);

  if (exact.size >= 2) {
    return { status: 'conflict', codes: sorted(exact), rules: ruleIds };
  }
  if (exact.size === 1) {
    const [code] = [...exact];
    const outside = groups.filter((g) => !g.has(code!));
    if (outside.length === 0) return { status: 'exact', codes: [code!], rules: ruleIds };
    const all = new Set<string>([code!]);
    for (const g of outside) for (const c of g) all.add(c);
    return { status: 'conflict', codes: sorted(all), rules: ruleIds };
  }
  if (groups.length === 0) return { status: 'none', codes: [], rules: ruleIds };

  let inter = new Set(groups[0]);
  for (const g of groups.slice(1)) inter = new Set([...inter].filter((c) => g.has(c)));
  if (inter.size === 1) return { status: 'exact', codes: sorted(inter), rules: ruleIds };
  if (inter.size > 1) return { status: 'group', codes: sorted(inter), rules: ruleIds };
  const all = new Set<string>();
  for (const g of groups) for (const c of g) all.add(c);
  return { status: 'conflict', codes: sorted(all), rules: ruleIds };
}
