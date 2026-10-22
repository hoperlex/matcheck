// План импорта подрядчиков из выгрузки 1С «Списание по субподряду» в
// справочник «Контрагенты» (customer_counterparties — это и есть подрядчики,
// см. resolve-contractor.ts). ИНН в выгрузке почти нет, поэтому сопоставление
// по уровням, и на каждом засчитывается только единственное совпадение:
//   1. ИНН из скобок («АЛЬЯНС ООО (7716967786)») — если он есть, только по нему;
//   2. точное совпадение с именем или алиасом;
//   3. companyKey — имя без формы, кавычек и регистра;
//   4. tokenKey — то же без учёта порядка слов («ГОРИЗОНТ СК» ↔ «СК Горизонт»).
// Несколько совпадений — неоднозначно: в отчёт, строку не создаём (в
// справочнике уже есть тёзки, например три 'ООО "МАСТЕР"'). Совпадение только
// по фамилии и инициалам — кандидат для человека: запись не меняем и новую не
// создаём, иначе почти наверняка задвоим подрядчика.

import {
  collapseSpaces,
  companyKey,
  formsCompatible,
  innDigits,
  mergeAliases,
  personInitialsKey,
  styleContractorName,
  tokenKey,
} from './names.js';
import type { OneCContractor } from './parse.js';

export type CcRow = { id: string; inn: string; name: string; aliases: string[] };

export type ContractorMatchLevel = 'inn' | 'exact' | 'company_key' | 'token_key';

export const CONTRACTOR_LEVEL_LABELS: Record<ContractorMatchLevel, string> = {
  inn: 'по ИНН',
  exact: 'точное имя или алиас',
  company_key: 'имя без формы и кавычек',
  token_key: 'те же слова в другом порядке',
};

export type ContractorMatch = { raw: string; id: string; via: ContractorMatchLevel };

export type ContractorInsert = {
  /** Стабильный ключ для отпечатка плана (id выдаётся при записи). */
  key: string;
  name: string;
  inn: string;
  aliases: string[];
  sources: string[];
};

export type ContractorPlan = {
  matches: ContractorMatch[];
  /** id → итоговые алиасы (только изменившиеся строки). */
  aliasUpdates: Map<string, string[]>;
  inserts: ContractorInsert[];
  ambiguous: Array<{ raw: string; level: ContractorMatchLevel; candidateIds: string[] }>;
  initialsCandidates: Array<{ raw: string; candidateIds: string[] }>;
  findings: Array<{ raw: string; detail: string }>;
};

function exactKey(s: string): string {
  return collapseSpaces(s).toLowerCase().replace(/ё/g, 'е');
}

class Index {
  private readonly map = new Map<string, Set<string>>();
  add(key: string | null, id: string) {
    if (!key) return;
    const set = this.map.get(key) ?? new Set<string>();
    set.add(id);
    this.map.set(key, set);
  }
  get(keys: Array<string | null>): string[] {
    const out = new Set<string>();
    for (const k of keys) if (k) for (const id of this.map.get(k) ?? []) out.add(id);
    return [...out];
  }
}

export function planContractors(file: OneCContractor[], cc: CcRow[]): ContractorPlan {
  const byId = new Map(cc.map((r) => [r.id, r]));
  const byInn = new Index();
  const byExact = new Index();
  const byCompany = new Index();
  const byToken = new Index();
  const byInitials = new Index();
  for (const r of cc) {
    byInn.add(innDigits(r.inn), r.id);
    for (const n of [r.name, ...r.aliases]) {
      byExact.add(exactKey(n), r.id);
      byCompany.add(companyKey(n), r.id);
      byToken.add(tokenKey(n), r.id);
      byInitials.add(personInitialsKey(n), r.id);
    }
  }

  const plan: ContractorPlan = {
    matches: [],
    aliasUpdates: new Map(),
    inserts: [],
    ambiguous: [],
    initialsCandidates: [],
    findings: [],
  };
  const insertsByKey = new Map<string, ContractorInsert>();

  for (const c of file) {
    const compatible = (ids: string[]) =>
      ids.filter((id) => formsCompatible(c.base, byId.get(id)!.name));

    let matched: { id: string; via: ContractorMatchLevel } | null = null;
    let ambiguous = false;
    if (c.inn) {
      const ids = byInn.get([c.inn]);
      if (ids.length === 1) matched = { id: ids[0]!, via: 'inn' };
      else if (ids.length > 1) {
        plan.ambiguous.push({ raw: c.raw, level: 'inn', candidateIds: ids });
        ambiguous = true;
      }
    } else {
      const levels: Array<[ContractorMatchLevel, string[]]> = [
        [
          'exact',
          compatible(
            byExact.get([exactKey(c.raw), exactKey(c.base), exactKey(styleContractorName(c.base))]),
          ),
        ],
        ['company_key', compatible(byCompany.get([companyKey(c.base)]))],
        ['token_key', compatible(byToken.get([tokenKey(c.base)]))],
      ];
      for (const [level, ids] of levels) {
        if (ids.length === 1) {
          matched = { id: ids[0]!, via: level };
          break;
        }
        if (ids.length > 1) {
          plan.ambiguous.push({ raw: c.raw, level, candidateIds: ids });
          ambiguous = true;
          break;
        }
      }
    }
    if (ambiguous) continue;

    if (matched) {
      plan.matches.push({ raw: c.raw, ...matched });
      const row = byId.get(matched.id)!;
      if (companyKey(c.raw) === companyKey(row.name)) continue;
      const current = plan.aliasUpdates.get(row.id) ?? row.aliases;
      const merged = mergeAliases(current, [c.raw], row.name);
      if (merged.added.length > 0) plan.aliasUpdates.set(row.id, merged.aliases);
      if (merged.dropped.length > 0) {
        plan.findings.push({ raw: c.raw, detail: `не влез алиас у «${row.name}»: лимит 20` });
      }
      continue;
    }

    if (!c.inn) {
      const ids = compatible(byInitials.get([personInitialsKey(c.base)]));
      if (ids.length > 0) {
        plan.initialsCandidates.push({ raw: c.raw, candidateIds: ids });
        continue;
      }
    }

    const name = styleContractorName(c.base);
    const key = c.inn ? `inn:${c.inn}` : `name:${companyKey(c.base) || exactKey(c.base)}`;
    const known = insertsByKey.get(key);
    if (known) {
      known.aliases = mergeAliases(known.aliases, [c.raw], known.name).aliases;
      known.sources.push(c.raw);
      continue;
    }
    const insert: ContractorInsert = {
      key,
      name,
      inn: c.inn ?? '',
      aliases: mergeAliases([], [c.raw], name).aliases,
      sources: [c.raw],
    };
    insertsByKey.set(key, insert);
    plan.inserts.push(insert);
  }
  return plan;
}

/** Справочник после применения плана (новым строкам — id из `ids` или ключ). */
export function applyContractorChanges(
  rows: readonly CcRow[],
  plan: Pick<ContractorPlan, 'aliasUpdates' | 'inserts'>,
  ids?: ReadonlyMap<string, string>,
): CcRow[] {
  const out = rows.map((r) => ({ ...r, aliases: [...(plan.aliasUpdates.get(r.id) ?? r.aliases)] }));
  for (const ins of plan.inserts) {
    out.push({
      id: ids?.get(ins.key) ?? ins.key,
      inn: ins.inn,
      name: ins.name,
      aliases: [...ins.aliases],
    });
  }
  return out;
}
