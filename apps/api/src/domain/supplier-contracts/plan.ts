// План импорта договоров 1С — чистая функция над разобранным файлом и
// состоянием базы. Сопоставление по GUID договора (onec_id).
//
//  - insert   — договора нет в базе;
//  - update   — изменились поля из 1С или пересчитанный объект;
//  - missing  — договора нет в файле, а missing_since ещё пуст: ставим время
//               импорта. Уже пропавший и всё ещё отсутствующий операции НЕ
//               даёт — иначе дата переписывалась бы каждым импортом и план
//               после apply не был бы пуст;
//  - returned — договор снова в файле, а missing_since стоит: снимаем.
//
// Отпечаток — sha256 отсортированных операций, без времени и новых id: dry-run
// и apply над одинаковыми данными дают один отпечаток.

import { createHash } from 'node:crypto';
import type { SupplierContractKind, SupplierContractSiteStatus } from '../../db/schema.js';
import type { ParsedContract } from './parse.js';
import { detectContractSites, siteRuleText } from './site-rules.js';

export const FINGERPRINT_SHOWN = 16;
/** Доля живых договоров, пропажу которой без --allow-mass-missing не принимаем. */
export const MASS_MISSING_SHARE = 0.2;

/** Поля договора, которые пишет импорт (кроме missing_since). */
export type ContractFields = {
  counterpartyOnecId: string | null;
  counterpartyName: string;
  counterpartyInn: string;
  name: string;
  number: string | null;
  contractDate: string | null;
  kind: SupplierContractKind;
  objectText: string | null;
  siteStatus: SupplierContractSiteStatus;
  /** id объектов, по возрастанию. */
  siteIds: string[];
  siteRule: string | null;
};

export const CONTRACT_FIELD_KEYS = [
  'counterpartyOnecId',
  'counterpartyName',
  'counterpartyInn',
  'name',
  'number',
  'contractDate',
  'kind',
  'objectText',
  'siteStatus',
  'siteIds',
  'siteRule',
] as const satisfies readonly (keyof ContractFields)[];

export type ContractStateRow = ContractFields & {
  id: string;
  onecId: string;
  /** ISO или null. */
  missingSince: string | null;
};

export type ContractsState = {
  contracts: ContractStateRow[];
  /** Объекты портала: код → id. */
  sitesByCode: Map<string, string>;
  /** Привязки к приёмкам: id договора → display_id приёмок. */
  linkedDeliveries: Map<string, string[]>;
};

export type PlanInsert = { onecId: string; rowNo: number; fields: ContractFields; siteCodes: string[] };
export type PlanUpdate = {
  id: string;
  onecId: string;
  rowNo: number;
  changed: (keyof ContractFields)[];
  before: Partial<ContractFields>;
  after: Partial<ContractFields>;
  /** Договор вернулся в выгрузку: missing_since снимается (прежнее значение). */
  returnedFrom: string | null;
};
export type PlanMissing = { id: string; onecId: string; name: string; counterpartyName: string };

export type AffectedLink = {
  contractId: string;
  onecId: string;
  name: string;
  reason: 'kind' | 'site' | 'missing';
  detail: string;
  deliveries: string[];
};

export type ContractsPlan = {
  inserts: PlanInsert[];
  updates: PlanUpdate[];
  missing: PlanMissing[];
  returned: number;
  unchanged: number;
  /** Договоров без missing_since до импорта. */
  liveBefore: number;
  massMissing: boolean;
  affectedLinks: AffectedLink[];
  /** Коды правил, которых нет среди объектов портала, с числом договоров. */
  unknownSiteCodes: Map<string, number>;
  opCount: number;
  fingerprint: string;
};

const sameArray = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

function fieldEqual<K extends keyof ContractFields>(k: K, a: ContractFields[K], b: ContractFields[K]): boolean {
  if (k === 'siteIds') return sameArray(a as string[], b as string[]);
  return a === b;
}

/** Желаемые поля договора из строки файла (объект — по правилам). */
export function desiredFields(
  c: ParsedContract,
  sitesByCode: ReadonlyMap<string, string>,
): { fields: ContractFields; siteCodes: string[]; unknownCodes: string[] } {
  // Статус — по полному набору правил: группа «СОБЫТИЕ 6», у которой в портале
  // есть только один объект, остаётся группой, а не становится «точно». Коды,
  // которых в портале нет, отбрасываются уже после; не осталось ни одного —
  // объект для портала не определён.
  const raw = detectContractSites(siteRuleText([c.name, c.number, c.objectText]));
  const knownCodes = raw.codes.filter((code) => sitesByCode.has(code));
  const unknownCodes = raw.codes.filter((code) => !sitesByCode.has(code));
  const siteIds = knownCodes.map((code) => sitesByCode.get(code)!).sort();
  return {
    fields: {
      counterpartyOnecId: c.counterpartyOnecId,
      counterpartyName: c.counterpartyName,
      counterpartyInn: c.counterpartyInn,
      name: c.name,
      number: c.number,
      contractDate: c.contractDate,
      kind: c.kind,
      objectText: c.objectText,
      siteStatus: knownCodes.length > 0 ? raw.status : 'none',
      siteIds,
      siteRule: raw.rules.length > 0 ? raw.rules.join(',') : null,
    },
    siteCodes: knownCodes,
    unknownCodes,
  };
}

export function buildContractsPlan(parsed: readonly ParsedContract[], state: ContractsState): ContractsPlan {
  const byOnecId = new Map(state.contracts.map((r) => [r.onecId, r]));
  const inFile = new Set<string>();
  const inserts: PlanInsert[] = [];
  const updates: PlanUpdate[] = [];
  const unknownSiteCodes = new Map<string, number>();
  const affectedLinks: AffectedLink[] = [];
  const codeById = new Map([...state.sitesByCode].map(([code, id]) => [id, code]));
  const codes = (ids: readonly string[]) => ids.map((id) => codeById.get(id) ?? id).join(', ') || '—';
  let unchanged = 0;
  let returned = 0;

  for (const c of parsed) {
    inFile.add(c.onecId);
    const { fields, siteCodes, unknownCodes } = desiredFields(c, state.sitesByCode);
    for (const code of unknownCodes) unknownSiteCodes.set(code, (unknownSiteCodes.get(code) ?? 0) + 1);
    const cur = byOnecId.get(c.onecId);
    if (!cur) {
      inserts.push({ onecId: c.onecId, rowNo: c.rowNo, fields, siteCodes });
      continue;
    }
    const changed: (keyof ContractFields)[] = [];
    const before: Partial<ContractFields> = {};
    const after: Partial<ContractFields> = {};
    for (const k of CONTRACT_FIELD_KEYS) {
      if (fieldEqual(k, cur[k], fields[k])) continue;
      changed.push(k);
      (before as Record<string, unknown>)[k] = cur[k];
      (after as Record<string, unknown>)[k] = fields[k];
    }
    const returnedFrom = cur.missingSince;
    if (changed.length === 0 && returnedFrom === null) {
      unchanged++;
      continue;
    }
    if (returnedFrom !== null) returned++;
    updates.push({ id: cur.id, onecId: c.onecId, rowNo: c.rowNo, changed, before, after, returnedFrom });

    const deliveries = state.linkedDeliveries.get(cur.id);
    if (deliveries && deliveries.length > 0) {
      if (changed.includes('kind')) {
        affectedLinks.push({
          contractId: cur.id,
          onecId: cur.onecId,
          name: cur.name,
          reason: 'kind',
          detail: `вид: ${cur.kind} → ${fields.kind}`,
          deliveries,
        });
      }
      if (changed.includes('siteIds') || changed.includes('siteStatus')) {
        affectedLinks.push({
          contractId: cur.id,
          onecId: cur.onecId,
          name: cur.name,
          reason: 'site',
          detail: `объект: ${cur.siteStatus} ${codes(cur.siteIds)} → ${fields.siteStatus} ${codes(fields.siteIds)}`,
          deliveries,
        });
      }
    }
  }

  const missing: PlanMissing[] = [];
  let liveBefore = 0;
  for (const r of state.contracts) {
    if (r.missingSince === null) liveBefore++;
    if (inFile.has(r.onecId) || r.missingSince !== null) continue;
    missing.push({ id: r.id, onecId: r.onecId, name: r.name, counterpartyName: r.counterpartyName });
    const deliveries = state.linkedDeliveries.get(r.id);
    if (deliveries && deliveries.length > 0) {
      affectedLinks.push({
        contractId: r.id,
        onecId: r.onecId,
        name: r.name,
        reason: 'missing',
        detail: 'нет в выгрузке',
        deliveries,
      });
    }
  }

  inserts.sort((a, b) => a.onecId.localeCompare(b.onecId));
  updates.sort((a, b) => a.onecId.localeCompare(b.onecId));
  missing.sort((a, b) => a.onecId.localeCompare(b.onecId));

  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        v: 1,
        inserts: inserts.map((i) => [i.onecId, i.fields]),
        updates: updates.map((u) => [u.onecId, u.after, u.returnedFrom !== null]),
        missing: missing.map((m) => m.onecId),
      }),
    )
    .digest('hex');

  return {
    inserts,
    updates,
    missing,
    returned,
    unchanged,
    liveBefore,
    massMissing: liveBefore > 0 && missing.length > liveBefore * MASS_MISSING_SHARE,
    affectedLinks,
    unknownSiteCodes,
    opCount: inserts.length + updates.length + missing.length,
    fingerprint,
  };
}
