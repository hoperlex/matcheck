// План импорта связей «подрядчик × объект → вид» из выгрузки 1С.
//
// Чистые функции, без базы:
//   1. подрядчик — существующим planContractors (уровни ИНН из скобок / точное
//      имя или алиас / имя без формы / слова в другом порядке). Единственный
//      кандидат по фамилии и инициалам тоже засчитывается (решение владельца
//      25.11: «Сатаневский Никита Михайлович» ↔ «ИП Сатаневский Н.М.»).
//      Справочник контрагентов импорт НЕ меняет: алиасы и новые записи
//      planContractors игнорируются, ненайденные идут в отчёт;
//   2. объект — правилами договоров (site-rules.ts), засчитывается только
//      exact, плюс узкие локальные правила этого файла;
//   3. склейка строк в пару (подрядчик, объект): числа и копейки складываются;
//   4. вид по числу документов;
//   5. дифф с текущим слоем onec_* — только он принадлежит импорту.
// Тот же дифф делает откат: целевой слой берётся из снимка.

import { createHash } from 'node:crypto';
import type { ContractorSiteKindDb, ContractorSiteManualKind } from '../../db/schema.js';
import type { OneCContractor } from '../directories/parse.js';
import {
  planContractors,
  type CcRow,
  type ContractorMatchLevel,
} from '../directories/plan-contractors.js';
import { detectContractSites, siteRuleText } from '../supplier-contracts/site-rules.js';
import type { ContractorSiteRow } from './parse.js';

export const FINGERPRINT_SHOWN = 16;

export type SiteRef = { id: string; code: string; name: string; isActive: boolean };

/** Слой 1С пары. Суммы — строкой с двумя знаками, как numeric(16,2)::text. */
export type OnecLayer = {
  kind: ContractorSiteKindDb;
  realizationDocs: number;
  realizationSum: string;
  tollingDocs: number;
  tollingSum: string;
  /** Названия объекта в 1С — по алфавиту, без повторов. */
  objects: string[];
};

export type CurrentLink = {
  ccId: string;
  siteId: string;
  onec: OnecLayer | null;
  onecLoadedAt: Date | null;
  manualKind: ContractorSiteManualKind | null;
};

export type ContractorSitesState = { cc: CcRow[]; sites: SiteRef[]; links: CurrentLink[] };

export type TargetEntry = {
  ccId: string;
  siteId: string;
  layer: OnecLayer;
  /** Время загрузки для записи; null — время текущей записи. */
  loadedAt: Date | null;
  rowNos: number[];
};

export type ContractorLinkLevel = ContractorMatchLevel | 'initials';

export const CONTRACTOR_LINK_LABELS: Record<ContractorLinkLevel, string> = {
  inn: 'по ИНН в скобках',
  exact: 'точное имя или алиас',
  company_key: 'имя без формы и кавычек',
  token_key: 'те же слова в другом порядке',
  initials: 'по фамилии и инициалам (единственный кандидат)',
};

export type FileTarget = {
  entries: TargetEntry[];
  contractorMatches: Array<{
    raw: string;
    ccId: string;
    via: ContractorLinkLevel;
    rowNos: number[];
  }>;
  unresolvedContractors: Array<{
    raw: string;
    reason: string;
    candidateIds: string[];
    rowNos: number[];
  }>;
  unresolvedObjects: Array<{ rowNo: number; raw: string; objectText: string; reason: string }>;
};

export function kindOf(realizationDocs: number, tollingDocs: number): ContractorSiteKindDb {
  if (realizationDocs > 0 && tollingDocs > 0) return 'realization_tolling';
  return realizationDocs > 0 ? 'realization' : 'tolling_act';
}

/** Копейки → «12345.67» без float-деления. */
export function kopToSum(kop: number): string {
  const whole = Math.trunc(kop / 100);
  const rest = kop - whole * 100;
  return `${whole}.${String(rest).padStart(2, '0')}`;
}

const R = '(?![А-ЯA-Z0-9./])';

/**
 * Локальные правила этого файла — общие SITE_RULES не трогаем, чтобы не
 * изменился подбор объекта у договоров.
 */
const LOCAL_SITE_RULES: ReadonlyArray<{ id: string; code: string; re: RegExp }> = [
  // «ВОЛГОГРАДСКИЙ ПР-Т, ВЛ. 32, ЖК "МЕТРОПОЛИЯ", К. 3». Общее правило МЕ3.0
  // ждёт «ВЛ.32 К.3» подряд, вставка ЖК его ломает. Договоры «вл.32 к.3,
  // №СУ-МЕТ3/…» — 3-я очередь; 2-я очередь в выгрузке — «ВЛ. 32/5, ОЧ. 2».
  {
    id: 'local.metro3.vl32k3',
    code: 'МЕ3.0',
    re: new RegExp(`ВЛ\\.?\\s*32,?\\s*ЖК\\s*["«]?МЕТРОПОЛИЯ["»]?,?\\s*К\\.?\\s*3${R}`),
  },
];

/** Корпус реновации на Фридриха Энгельса — другой проект (site-rules.ts, d56.address). */
const RENOVATION_RE = /РЕНОВАЦИ/;

export type ObjectSite = { code: string; rule: string } | { code: null; reason: string };

export function resolveObjectSite(
  objectText: string,
  portalCodes: ReadonlySet<string>,
): ObjectSite {
  const text = siteRuleText([objectText]);
  if (!text) return { code: null, reason: 'пустой объект' };
  if (RENOVATION_RE.test(text))
    return { code: null, reason: 'корпус реновации — отдельный проект, объекта на портале нет' };
  let found: { code: string; rule: string } | null = null;
  for (const rule of LOCAL_SITE_RULES) {
    if (rule.re.test(text)) {
      found = { code: rule.code, rule: rule.id };
      break;
    }
  }
  if (!found) {
    const d = detectContractSites(text);
    if (d.status !== 'exact') {
      const codes = d.codes.length > 0 ? `: ${d.codes.join(' / ')}` : '';
      const label = { group: 'несколько объектов', conflict: 'противоречие', none: 'не распознан' }[
        d.status
      ];
      return { code: null, reason: `${label}${codes}` };
    }
    found = { code: d.codes[0]!, rule: d.rules.join(',') };
  }
  if (!portalCodes.has(found.code))
    return { code: null, reason: `объекта ${found.code} нет на портале` };
  return found;
}

function pairKey(ccId: string, siteId: string): string {
  return `${ccId}|${siteId}`;
}

/** Целевой слой 1С из файла. */
export function buildFileTarget(
  rows: readonly ContractorSiteRow[],
  contractors: readonly OneCContractor[],
  state: Pick<ContractorSitesState, 'cc' | 'sites'>,
): FileTarget {
  const plan = planContractors([...contractors], state.cc);
  const rowNosByRaw = new Map(contractors.map((c) => [c.raw, c.rowNos]));
  const byRaw = new Map<string, { ccId: string; via: ContractorLinkLevel }>();
  const out: FileTarget = {
    entries: [],
    contractorMatches: [],
    unresolvedContractors: [],
    unresolvedObjects: [],
  };

  for (const m of plan.matches) byRaw.set(m.raw, { ccId: m.id, via: m.via });
  for (const c of plan.initialsCandidates) {
    if (c.candidateIds.length === 1)
      byRaw.set(c.raw, { ccId: c.candidateIds[0]!, via: 'initials' });
    else
      out.unresolvedContractors.push({
        raw: c.raw,
        reason: `по фамилии и инициалам несколько кандидатов: ${c.candidateIds.length}`,
        candidateIds: c.candidateIds,
        rowNos: rowNosByRaw.get(c.raw) ?? [],
      });
  }
  for (const a of plan.ambiguous)
    out.unresolvedContractors.push({
      raw: a.raw,
      reason: `неоднозначно (${CONTRACTOR_LINK_LABELS[a.level]}): кандидатов ${a.candidateIds.length}`,
      candidateIds: a.candidateIds,
      rowNos: rowNosByRaw.get(a.raw) ?? [],
    });
  for (const ins of plan.inserts)
    for (const raw of ins.sources)
      out.unresolvedContractors.push({
        raw,
        reason: 'нет в справочнике «Контрагенты»',
        candidateIds: [],
        rowNos: rowNosByRaw.get(raw) ?? [],
      });
  for (const [raw, m] of byRaw)
    out.contractorMatches.push({
      raw,
      ccId: m.ccId,
      via: m.via,
      rowNos: rowNosByRaw.get(raw) ?? [],
    });

  const siteByCode = new Map(state.sites.map((s) => [s.code, s]));
  const portalCodes = new Set(siteByCode.keys());
  type Acc = {
    ccId: string;
    siteId: string;
    rd: number;
    rk: number;
    td: number;
    tk: number;
    objects: Set<string>;
    rowNos: number[];
  };
  const acc = new Map<string, Acc>();
  for (const row of rows) {
    const m = byRaw.get(row.raw);
    if (!m) continue; // подрядчик уже в отчёте
    const site = resolveObjectSite(row.objectText, portalCodes);
    if (site.code === null) {
      out.unresolvedObjects.push({
        rowNo: row.rowNo,
        raw: row.raw,
        objectText: row.objectText,
        reason: site.reason,
      });
      continue;
    }
    const siteId = siteByCode.get(site.code)!.id;
    const key = pairKey(m.ccId, siteId);
    const a = acc.get(key) ?? {
      ccId: m.ccId,
      siteId,
      rd: 0,
      rk: 0,
      td: 0,
      tk: 0,
      objects: new Set<string>(),
      rowNos: [],
    };
    a.rd += row.realizationDocs;
    a.rk += row.realizationKop;
    a.td += row.tollingDocs;
    a.tk += row.tollingKop;
    if (row.objectText) a.objects.add(row.objectText);
    a.rowNos.push(row.rowNo);
    acc.set(key, a);
  }
  for (const a of acc.values()) {
    out.entries.push({
      ccId: a.ccId,
      siteId: a.siteId,
      layer: {
        kind: kindOf(a.rd, a.td),
        realizationDocs: a.rd,
        realizationSum: kopToSum(a.rk),
        tollingDocs: a.td,
        tollingSum: kopToSum(a.tk),
        objects: [...a.objects].sort(),
      },
      loadedAt: null,
      rowNos: a.rowNos,
    });
  }
  out.entries.sort((x, y) => pairKey(x.ccId, x.siteId).localeCompare(pairKey(y.ccId, y.siteId)));
  return out;
}

export type OpType = 'insert' | 'update' | 'clear' | 'delete';

export type PlanOp = {
  type: OpType;
  ccId: string;
  siteId: string;
  before: OnecLayer | null;
  after: OnecLayer | null;
  /** Для insert/update: время загрузки (null — время записи). */
  loadedAt: Date | null;
};

export type ContractorSitesPlan = {
  ops: PlanOp[];
  /** Пары цели, которых уже нельзя записать (контрагент или объект удалён) — только откат. */
  skipped: Array<{ ccId: string; siteId: string; reason: string }>;
  unchanged: number;
  counts: Record<OpType, number>;
  fingerprint: string;
};

export function sameLayer(a: OnecLayer, b: OnecLayer): boolean {
  return (
    a.kind === b.kind &&
    a.realizationDocs === b.realizationDocs &&
    a.realizationSum === b.realizationSum &&
    a.tollingDocs === b.tollingDocs &&
    a.tollingSum === b.tollingSum &&
    a.objects.length === b.objects.length &&
    a.objects.every((o, i) => o === b.objects[i])
  );
}

/**
 * Дифф текущего слоя onec_* с целевым. Колонки manual_* не меняются никогда:
 * пропавшая из файла пара с ручным видом только теряет данные 1С (clear), без
 * ручного вида или скрытая вручную — удаляется (скрытая строка без 1С не живёт).
 */
export function planLayer(
  state: ContractorSitesState,
  entries: readonly TargetEntry[],
): ContractorSitesPlan {
  const current = new Map(state.links.map((l) => [pairKey(l.ccId, l.siteId), l]));
  const ccIds = new Set(state.cc.map((c) => c.id));
  const siteIds = new Set(state.sites.map((s) => s.id));
  const ops: PlanOp[] = [];
  const skipped: ContractorSitesPlan['skipped'] = [];
  const targetKeys = new Set<string>();
  let unchanged = 0;

  for (const e of entries) {
    if (!ccIds.has(e.ccId) || !siteIds.has(e.siteId)) {
      skipped.push({
        ccId: e.ccId,
        siteId: e.siteId,
        reason: !ccIds.has(e.ccId) ? 'контрагента больше нет' : 'объекта больше нет',
      });
      continue;
    }
    const key = pairKey(e.ccId, e.siteId);
    targetKeys.add(key);
    const cur = current.get(key);
    if (!cur) {
      ops.push({
        type: 'insert',
        ccId: e.ccId,
        siteId: e.siteId,
        before: null,
        after: e.layer,
        loadedAt: e.loadedAt,
      });
    } else if (!cur.onec || !sameLayer(cur.onec, e.layer)) {
      ops.push({
        type: 'update',
        ccId: e.ccId,
        siteId: e.siteId,
        before: cur.onec,
        after: e.layer,
        loadedAt: e.loadedAt,
      });
    } else unchanged++;
  }
  for (const [key, cur] of current) {
    if (!cur.onec || targetKeys.has(key)) continue;
    const keepsManual = cur.manualKind !== null && cur.manualKind !== 'none';
    ops.push({
      type: keepsManual ? 'clear' : 'delete',
      ccId: cur.ccId,
      siteId: cur.siteId,
      before: cur.onec,
      after: null,
      loadedAt: null,
    });
  }
  ops.sort(
    (a, b) =>
      pairKey(a.ccId, a.siteId).localeCompare(pairKey(b.ccId, b.siteId)) ||
      a.type.localeCompare(b.type),
  );
  const counts: Record<OpType, number> = { insert: 0, update: 0, clear: 0, delete: 0 };
  for (const op of ops) counts[op.type]++;
  // Время загрузки в отпечаток не входит: это не изменение данных.
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(ops.map((o) => [o.type, o.ccId, o.siteId, o.before, o.after])))
    .digest('hex');
  return { ops, skipped, unchanged, counts, fingerprint };
}

/** Снимок слоя 1С до записи — для отката. */
export type ContractorSitesSnapshot = {
  version: 1;
  kind: 'contractor-sites';
  takenAt: string;
  fingerprint: string;
  layer: Array<{ ccId: string; siteId: string; onec: OnecLayer; loadedAt: string }>;
};

export function buildSnapshot(
  state: ContractorSitesState,
  fingerprint: string,
  takenAt: Date,
): ContractorSitesSnapshot {
  return {
    version: 1,
    kind: 'contractor-sites',
    takenAt: takenAt.toISOString(),
    fingerprint,
    layer: state.links
      .filter(
        (l): l is CurrentLink & { onec: OnecLayer; onecLoadedAt: Date } =>
          l.onec !== null && l.onecLoadedAt !== null,
      )
      .map((l) => ({
        ccId: l.ccId,
        siteId: l.siteId,
        onec: l.onec,
        loadedAt: l.onecLoadedAt.toISOString(),
      })),
  };
}

/** Целевой слой отката: ровно то, что было в снимке. */
export function snapshotTarget(snap: ContractorSitesSnapshot): { entries: TargetEntry[] } {
  if (snap.version !== 1 || snap.kind !== 'contractor-sites')
    throw new Error('это не снимок импорта связей подрядчиков с объектами');
  return {
    entries: snap.layer.map((l) => ({
      ccId: l.ccId,
      siteId: l.siteId,
      layer: l.onec,
      loadedAt: new Date(l.loadedAt),
      rowNos: [],
    })),
  };
}
