// План склейки дублей поставщиков. Распознавание УПД путает цифры ИНН, шаг 1
// матчера (точный ИНН) промахивается и создаёт новую строку — так в справочнике
// копятся копии одной организации с битыми ИНН.
//
// Склеиваем автоматически только то, что доказуемо одна организация:
//   - группа — одинаковый companyKey (имя без формы, кавычек и регистра);
//   - в группе ровно один корректный ИНН (контрольная сумма); если их
//     несколько или ни одного — вся группа уходит на ручную проверку;
//   - источник не из BillHub, без статуса СБ и комментария, формы
//     собственности не противоречат;
//   - ИНН источника — те же цифры, что у цели, либо битый ИНН (не проходит
//     контрольную сумму или длину) ровно в одной правке от цели. Битый ИНН не
//     принадлежит никакой организации, поэтому совпадение имени, формы и одна
//     ошибка чтения — достаточное основание. Две правки, пустой ИНН, далёкий
//     ИНН — только отчёт.
//   - имя и алиасы источника должны поместиться в алиасы цели, иначе склейка
//     потеряла бы данные — тоже на ручную проверку.

import { companyKey, editDistance, formsCompatible, mergeAliases, validInn } from './names.js';
import { applySupplierChanges, type SupplierPatch, type SupplierRow } from './plan-suppliers.js';

export type MergeSourceClass = 'same_inn' | 'one_edit';

export type DoubtfulReason =
  | 'several_valid_inn'
  | 'no_valid_inn'
  | 'billhub_row'
  | 'form_conflict'
  | 'has_data'
  | 'empty_inn'
  | 'two_edits'
  | 'far_inn'
  | 'aliases_overflow'
  | 'dirty_inn_conflict';

export const DOUBTFUL_LABELS: Record<DoubtfulReason, string> = {
  several_valid_inn: 'в группе несколько корректных ИНН',
  no_valid_inn: 'в группе нет корректного ИНН',
  billhub_row: 'строка из BillHub — не удаляется',
  form_conflict: 'разные формы собственности',
  has_data: 'у строки есть статус СБ или комментарий',
  empty_inn: 'пустой ИНН',
  two_edits: 'ИНН отличается на 2 цифры',
  far_inn: 'ИНН отличается сильнее',
  aliases_overflow: 'имена не помещаются в 20 алиасов цели',
  dirty_inn_conflict: 'грязный ИНН не очищен: такие цифры есть у другой строки',
};

export type SupplierMerge = {
  key: string;
  targetId: string;
  sources: Array<{ id: string; inn: string; name: string; class: MergeSourceClass }>;
  aliasesAdded: string[];
};

export type DoubtfulDuplicate = {
  key: string;
  reason: DoubtfulReason;
  ids: string[];
  targetId: string | null;
};

export type InnCleanup = { id: string; from: string; to: string };

export type MergePlan = {
  merges: SupplierMerge[];
  doubtful: DoubtfulDuplicate[];
  innCleanups: InnCleanup[];
  /** Алиасы целей и очищенные ИНН. */
  updates: Map<string, SupplierPatch>;
  deleteIds: string[];
  rowsAfter: SupplierRow[];
};

function allDigits(s: string): string {
  return s.replace(/\D/g, '');
}

function hasData(r: SupplierRow): boolean {
  return Boolean(r.lastSecurityStatus) || Boolean(r.foundingDocumentsComment?.trim());
}

export function planSupplierMerges(
  rows: readonly SupplierRow[],
  docCounts: ReadonlyMap<string, number>,
): MergePlan {
  const groups = new Map<string, SupplierRow[]>();
  for (const r of rows) {
    const key = companyKey(r.name);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const merges: SupplierMerge[] = [];
  const doubtful: DoubtfulDuplicate[] = [];
  const updates = new Map<string, SupplierPatch>();
  const deleteIds: string[] = [];

  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.length < 2) continue;
    const valid = new Set(group.map((r) => validInn(r.inn)).filter((v): v is string => v !== null));
    if (valid.size !== 1) {
      doubtful.push({
        key,
        reason: valid.size > 1 ? 'several_valid_inn' : 'no_valid_inn',
        ids: group.map((r) => r.id),
        targetId: null,
      });
      continue;
    }
    const inn = [...valid][0]!;
    const target = group
      .filter((r) => validInn(r.inn) === inn)
      .sort(
        (a, b) =>
          Number(b.billhubId !== null) - Number(a.billhubId !== null) ||
          (docCounts.get(b.id) ?? 0) - (docCounts.get(a.id) ?? 0) ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      )[0]!;

    const sources: SupplierMerge['sources'] = [];
    for (const r of group) {
      if (r.id === target.id) continue;
      const verdict = sourceVerdict(r, target, inn);
      if (verdict !== 'same_inn' && verdict !== 'one_edit') {
        doubtful.push({ key, reason: verdict, ids: [r.id], targetId: target.id });
        continue;
      }
      sources.push({ id: r.id, inn: r.inn, name: r.name, class: verdict });
    }
    if (sources.length === 0) continue;

    const byId = new Map(group.map((r) => [r.id, r]));
    const aliases = mergeAliases(
      target.aliases,
      sources.flatMap((s) => [s.name, ...byId.get(s.id)!.aliases]),
      target.name,
    );
    if (aliases.dropped.length > 0) {
      doubtful.push({
        key,
        reason: 'aliases_overflow',
        ids: sources.map((s) => s.id),
        targetId: target.id,
      });
      continue;
    }
    merges.push({ key, targetId: target.id, sources, aliasesAdded: aliases.added });
    if (aliases.added.length > 0) updates.set(target.id, { aliases: aliases.aliases });
    deleteIds.push(...sources.map((s) => s.id));
  }

  // Грязный ИНН строки BillHub («7722466153,», «ИНН 9704043737») матчер не
  // находит никогда и создаёт рядом чистый дубль. Чистим до цифр, но только
  // если после склейки этих цифр нет ни у одной другой строки.
  const afterMerge = applySupplierChanges(rows, updates, [], deleteIds);
  const innCleanups: InnCleanup[] = [];
  for (const r of afterMerge) {
    if (r.billhubId === null) continue;
    const clean = validInn(r.inn);
    if (!clean || clean === r.inn) continue;
    const taken = afterMerge.some((o) => o.id !== r.id && allDigits(o.inn) === clean);
    if (taken) {
      doubtful.push({
        key: companyKey(r.name),
        reason: 'dirty_inn_conflict',
        ids: [r.id],
        targetId: null,
      });
      continue;
    }
    innCleanups.push({ id: r.id, from: r.inn, to: clean });
    updates.set(r.id, { ...updates.get(r.id), inn: clean });
  }

  return {
    merges,
    doubtful,
    innCleanups,
    updates,
    deleteIds,
    rowsAfter: applySupplierChanges(rows, updates, [], deleteIds),
  };
}

function sourceVerdict(
  r: SupplierRow,
  target: SupplierRow,
  targetInn: string,
): DoubtfulReason | MergeSourceClass {
  if (r.billhubId !== null) return 'billhub_row';
  if (!formsCompatible(r.name, target.name)) return 'form_conflict';
  if (hasData(r)) return 'has_data';
  const d = allDigits(r.inn);
  if (d === targetInn) return 'same_inn';
  if (!d) return 'empty_inn';
  // Корректный, но другой ИНН сюда не доходит: тогда в группе было бы два
  // корректных ИНН и она целиком ушла бы на ручную проверку.
  if (validInn(r.inn)) return 'several_valid_inn';
  const dist = editDistance(d, targetInn);
  if (dist === 1) return 'one_edit';
  return dist === 2 ? 'two_edits' : 'far_inn';
}
