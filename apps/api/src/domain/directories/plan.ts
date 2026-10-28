// Общий план импорта справочников: поставщики BillHub → склейка дублей →
// подрядчики 1С. Чистая функция от входа и состояния базы; dry-run и apply
// строят его одинаково, а отпечаток плана связывает проверенный человеком
// dry-run с тем, что apply запишет.

import { createHash } from 'node:crypto';
import type { BillhubSupplier, OneCContractor } from './parse.js';
import { planContractors, type CcRow, type ContractorPlan } from './plan-contractors.js';
import { validInn } from './names.js';
import { planSupplierMerges, type MergePlan } from './plan-merges.js';
import type { ManualPair } from './plan-near-inn.js';
import {
  planSuppliers,
  type SupplierImportPlan,
  type SupplierPatch,
  type SupplierRow,
} from './plan-suppliers.js';

export type DirectoriesInput = {
  suppliers?: BillhubSupplier[];
  contractors?: OneCContractor[];
  /**
   * Склейка дублей по текущей таблице без файла BillHub. С файлом склейка
   * всегда идёт по строкам после импорта, флаг не нужен.
   */
  mergesOnly?: boolean;
  /** Класс near_inn_name: битый ИНН в одной правке от единственной записи. */
  nearInn?: boolean;
  /** Ручные пары «источник → цель», подтверждённые человеком по отчёту. */
  pairs?: ManualPair[];
};

export type DirectoriesState = {
  suppliers: SupplierRow[];
  /** id поставщика → число документов, которые на него ссылаются. */
  docCounts: Map<string, number>;
  contractors: CcRow[];
};

export type DirectoriesPlan = {
  suppliers: SupplierImportPlan | null;
  merges: MergePlan | null;
  contractors: ContractorPlan | null;
  /** Итоговые правки существующих строк suppliers: импорт + алиасы целей + чистка ИНН. */
  supplierUpdates: Map<string, SupplierPatch>;
  /** Новые строки BillHub (с алиасами, если строка стала целью склейки). */
  supplierInserts: SupplierRow[];
  supplierDeletes: string[];
  opCount: number;
  fingerprint: string;
};

export function buildDirectoriesPlan(
  input: DirectoriesInput,
  state: DirectoriesState,
): DirectoriesPlan {
  const suppliersPlan = input.suppliers ? planSuppliers(input.suppliers, state.suppliers) : null;
  const mergeBase = suppliersPlan
    ? suppliersPlan.rowsAfter
    : input.mergesOnly
      ? state.suppliers
      : null;
  const merges = mergeBase
    ? planSupplierMerges(mergeBase, state.docCounts, {
        nearInn: input.nearInn,
        pairs: input.pairs,
        contractorInns: new Set(
          state.contractors.map((c) => validInn(c.inn)).filter((v): v is string => v !== null),
        ),
      })
    : null;
  const contractors = input.contractors
    ? planContractors(input.contractors, state.contractors)
    : null;

  const supplierUpdates = new Map<string, SupplierPatch>(suppliersPlan?.updates ?? []);
  const supplierInserts = (suppliersPlan?.inserts ?? []).map((r) => ({ ...r }));
  const insertById = new Map(supplierInserts.map((r) => [r.id, r]));
  for (const [id, patch] of merges?.updates ?? []) {
    // Цель склейки может оказаться новой строкой BillHub — тогда алиасы
    // ложатся в саму вставку, а не в UPDATE несуществующей строки.
    const inserted = insertById.get(id);
    if (inserted) Object.assign(inserted, patch);
    else supplierUpdates.set(id, { ...supplierUpdates.get(id), ...patch });
  }
  const supplierDeletes = [...(merges?.deleteIds ?? [])];

  const opCount =
    supplierUpdates.size +
    supplierInserts.length +
    supplierDeletes.length +
    (contractors?.aliasUpdates.size ?? 0) +
    (contractors?.inserts.length ?? 0);

  return {
    suppliers: suppliersPlan,
    merges,
    contractors,
    supplierUpdates,
    supplierInserts,
    supplierDeletes,
    opCount,
    fingerprint: planFingerprint({ supplierUpdates, supplierInserts, merges, contractors }),
  };
}

function sortedEntries(o: object): Array<[string, unknown]> {
  return Object.entries(o)
    .map(([k, v]): [string, unknown] => [k, v instanceof Date ? v.toISOString() : v])
    .sort(([a], [b]) => a.localeCompare(b));
}

/**
 * sha256 отсортированного списка операций. Время и id новых подрядчиков (их
 * выдаёт запись) в отпечаток не входят — он одинаков у dry-run и apply, если
 * состояние базы между ними не изменилось.
 */
export function planFingerprint(p: {
  supplierUpdates: ReadonlyMap<string, SupplierPatch>;
  supplierInserts: readonly SupplierRow[];
  merges: MergePlan | null;
  contractors: ContractorPlan | null;
}): string {
  const ops: string[] = [];
  for (const [id, patch] of p.supplierUpdates)
    ops.push(JSON.stringify(['su', id, sortedEntries(patch)]));
  for (const r of p.supplierInserts) ops.push(JSON.stringify(['si', sortedEntries(r)]));
  for (const m of p.merges?.merges ?? []) {
    ops.push(JSON.stringify(['sm', m.targetId, m.sources.map((s) => s.id).sort()]));
  }
  for (const [id, aliases] of p.contractors?.aliasUpdates ?? [])
    ops.push(JSON.stringify(['ca', id, aliases]));
  for (const ins of p.contractors?.inserts ?? []) {
    ops.push(JSON.stringify(['ci', ins.key, ins.name, ins.inn, ins.aliases]));
  }
  ops.sort();
  return createHash('sha256').update(ops.join('\n')).digest('hex');
}

/** Отпечаток в CLI показываем и принимаем по первым 16 символам. */
export const FINGERPRINT_SHOWN = 16;
