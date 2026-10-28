// Склейка дублей поставщиков сверх правил 22.10 (plan-merges.ts). Включается
// только явно: import-directories.ts --near-inn и --pairs.
//
// Правила 22.10 сравнивают строки внутри группы с одинаковым companyKey. Мимо
// них проходит дубль, у которого и ИНН, и имя прочитаны с ошибкой: «ПЕТРОВИЧ
// СТД» рядом с «СТД ПЕТРОВИЧ», «ООО «МОЖАЙСК»» рядом с «АО "ИСТКУЛЬТ
// МОЖАЙСК"». Здесь два пути:
//
//   near_inn_name — автоматически, только когда доказуемо одна организация:
//     - источник не из BillHub, без статуса СБ и комментария;
//     - ИНН источника битый (не проходит длину или контрольную сумму): такой
//       ИНН не принадлежит никому;
//     - ровно ОДНА запись справочника с корректным ИНН находится в одной
//       правке от него (замена, вставка, удаление или перестановка соседних
//       цифр). Две и больше — только отчёт;
//     - формы собственности не противоречат;
//     - имя близко к имени или алиасу цели: ключи отличаются не больше чем на
//       две правки и не больше чем на четверть длины. Иначе — отчёт;
//     - цели можно верить: она из BillHub, либо у её имени и имени источника
//       нет других корректных ИНН и её ИНН не принадлежит подрядчику или
//       СУ-10 («Контрагенты»). Проверка на бою 27.10 показала, зачем: модель
//       иногда читает ИНН с ошибкой, у которой контрольная сумма сходится
//       случайно («СТД Петрович» — 10 разных корректных ИНН), или берёт ИНН
//       покупателя («ТУЛА-СТАЛЬ» с ИНН СУ-10). Склейка в такую запись не
//       чинит, а узаконивает ошибку — это решает человек ручной парой.
//     Имя источника уходит в алиасы цели, как у склейки 22.10: это та же
//     организация с опечаткой в имени.
//
//   manual — пары «источник → цель», которые человек подтвердил по отчёту.
//     Имя не сравнивается, формы тоже — это решение человека. Остальные
//     проверки прежние. Алиасы НЕ добавляются: имя источника часто ошибка
//     распознавания («ООО «МОЖАЙСК»» вместо «АО "ИСТКУЛЬТ МОЖАЙСК"»), а алиас
//     участвует в нечётком поиске матчера и закрепил бы неверную привязку
//     новых документов. Строка источника целиком остаётся в снимке отката.

import { companyKey, editDistance, formsCompatible, mergeAliases, validInn } from './names.js';
import { applySupplierChanges, type SupplierPatch, type SupplierRow } from './plan-suppliers.js';
import type { DoubtfulDuplicate, SupplierMerge } from './plan-merges.js';

export type ManualPair = { sourceId: string; targetId: string };

export type PairIssue = ManualPair & { problem: string };

export type ExtraMergePlan = {
  merges: SupplierMerge[];
  doubtful: DoubtfulDuplicate[];
  pairIssues: PairIssue[];
  /** id → итоговая правка (алиасы целей near_inn_name). */
  updates: Map<string, SupplierPatch>;
  deleteIds: string[];
};

function allDigits(s: string): string {
  return s.replace(/\D/g, '');
}

function hasData(r: SupplierRow): boolean {
  return Boolean(r.lastSecurityStatus) || Boolean(r.foundingDocumentsComment?.trim());
}

/** Имена одной организации с опечаткой: ключи близки с поправкой на длину. */
export function namesClose(a: string, b: string): boolean {
  const ka = companyKey(a);
  const kb = companyKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const allowed = Math.min(2, Math.floor(Math.min(ka.length, kb.length) / 4));
  return allowed > 0 && editDistance(ka, kb) <= allowed;
}

/** Корректные ИНН в одной правке от цифр источника. */
function oneEditNeighbours(digits: string, valid: ReadonlyMap<string, SupplierRow>): SupplierRow[] {
  const out: SupplierRow[] = [];
  for (const [inn, row] of valid) {
    if (Math.abs(inn.length - digits.length) > 1) continue;
    if (inn.length === digits.length) {
      // Одна правка той же длины — замена или перестановка: не больше двух
      // несовпавших позиций. Отсекает почти всё без полного расчёта.
      let diff = 0;
      for (let i = 0; i < inn.length && diff <= 2; i++) if (inn[i] !== digits[i]) diff++;
      if (diff > 2) continue;
    }
    if (editDistance(digits, inn) === 1) out.push(row);
  }
  return out;
}

export function planExtraMerges(
  rows: readonly SupplierRow[],
  opts: {
    nearInn: boolean;
    pairs: readonly ManualPair[];
    /** Корректные ИНН «Контрагентов» (подрядчики и СУ-10) — не цели near_inn. */
    contractorInns?: ReadonlySet<string>;
  },
): ExtraMergePlan {
  const merges: SupplierMerge[] = [];
  const doubtful: DoubtfulDuplicate[] = [];
  const pairIssues: PairIssue[] = [];
  const updates = new Map<string, SupplierPatch>();
  const deleteIds: string[] = [];

  if (opts.nearInn) {
    const valid = new Map<string, SupplierRow>();
    const validByKey = new Map<string, Set<string>>();
    for (const r of rows) {
      const inn = validInn(r.inn);
      if (!inn) continue;
      if (!valid.has(inn)) valid.set(inn, r);
      const key = companyKey(r.name);
      validByKey.set(key, new Set([...(validByKey.get(key) ?? []), inn]));
    }
    const pending = new Map<string, SupplierRow[]>();
    for (const r of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
      if (r.billhubId !== null || hasData(r) || validInn(r.inn)) continue;
      const digits = allDigits(r.inn);
      if (digits.length < 9 || digits.length > 13) continue;
      const near = oneEditNeighbours(digits, valid);
      if (near.length === 0) continue;
      const key = companyKey(r.name);
      if (near.length > 1) {
        doubtful.push({ key, reason: 'near_inn_ambiguous', ids: [r.id], targetId: null });
        continue;
      }
      const target = near[0]!;
      if (!formsCompatible(r.name, target.name)) {
        doubtful.push({ key, reason: 'form_conflict', ids: [r.id], targetId: target.id });
        continue;
      }
      if (target.billhubId === null) {
        const targetInn = validInn(target.inn)!;
        if (opts.contractorInns?.has(targetInn)) {
          doubtful.push({
            key,
            reason: 'near_inn_target_contractor',
            ids: [r.id],
            targetId: target.id,
          });
          continue;
        }
        const namesakes = [key, companyKey(target.name)].flatMap((k) => [
          ...(validByKey.get(k) ?? []),
        ]);
        if (namesakes.some((inn) => inn !== targetInn)) {
          doubtful.push({
            key,
            reason: 'near_inn_several_valid',
            ids: [r.id],
            targetId: target.id,
          });
          continue;
        }
      }
      pending.set(target.id, [...(pending.get(target.id) ?? []), r]);
    }

    // Имя сравнивается с именем цели, её алиасами и именами уже принятых
    // источников — до неподвижной точки. После записи имена принятых станут
    // алиасами цели, и повторный план обязан дать то же решение; без
    // замыкания он мог бы «дотянуть» соседа, похожего на новый алиас, и
    // проверка «план после записи пуст» откатила бы всю транзакцию.
    const byId = new Map(rows.map((r) => [r.id, r]));
    const byTarget = new Map<string, SupplierMerge['sources']>();
    for (const [targetId, candidates] of pending) {
      const target = byId.get(targetId)!;
      const known = [target.name, ...target.aliases];
      const accepted: SupplierRow[] = [];
      let rest = candidates;
      for (let changed = true; changed; ) {
        changed = false;
        const next: SupplierRow[] = [];
        for (const r of rest) {
          if (known.some((n) => namesClose(r.name, n))) {
            accepted.push(r);
            known.push(r.name, ...r.aliases);
            changed = true;
          } else {
            next.push(r);
          }
        }
        rest = next;
      }
      for (const r of rest) {
        doubtful.push({
          key: companyKey(r.name),
          reason: 'near_inn_name_far',
          ids: [r.id],
          targetId,
        });
      }
      if (accepted.length > 0) {
        byTarget.set(
          targetId,
          accepted
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((r) => ({ id: r.id, inn: r.inn, name: r.name, class: 'near_inn_name' as const })),
        );
      }
    }

    for (const [targetId, sources] of [...byTarget].sort(([a], [b]) => a.localeCompare(b))) {
      const target = byId.get(targetId)!;
      const aliases = mergeAliases(
        target.aliases,
        sources.flatMap((s) => [s.name, ...byId.get(s.id)!.aliases]),
        target.name,
      );
      if (aliases.dropped.length > 0) {
        doubtful.push({
          key: companyKey(target.name),
          reason: 'aliases_overflow',
          ids: sources.map((s) => s.id),
          targetId,
        });
        continue;
      }
      merges.push({ key: companyKey(target.name), targetId, sources, aliasesAdded: aliases.added });
      if (aliases.added.length > 0) updates.set(targetId, { aliases: aliases.aliases });
      deleteIds.push(...sources.map((s) => s.id));
    }
  }

  if (opts.pairs.length > 0) {
    // Пары проверяются на строках ПОСЛЕ автоматической склейки: источник,
    // которого уже нет, — не ошибка, а «уже склеен» (повторный запуск после
    // записи обязан дать пустой план).
    const rowsNow = applySupplierChanges(rows, updates, [], deleteIds);
    const byId = new Map(rowsNow.map((r) => [r.id, r]));
    const seenSources = new Set<string>();
    const pairTargets = new Set(opts.pairs.map((p) => p.targetId));
    const pairSources = new Set(opts.pairs.map((p) => p.sourceId));
    const byTarget = new Map<string, SupplierMerge['sources']>();
    for (const p of opts.pairs) {
      const problem = pairProblem(p, byId, seenSources, pairTargets, pairSources, deleteIds);
      seenSources.add(p.sourceId);
      if (problem) {
        pairIssues.push({ ...p, problem });
        continue;
      }
      const s = byId.get(p.sourceId)!;
      const list = byTarget.get(p.targetId) ?? [];
      list.push({ id: s.id, inn: s.inn, name: s.name, class: 'manual' });
      byTarget.set(p.targetId, list);
    }
    for (const [targetId, sources] of [...byTarget].sort(([a], [b]) => a.localeCompare(b))) {
      merges.push({
        key: companyKey(byId.get(targetId)!.name),
        targetId,
        sources,
        aliasesAdded: [],
      });
      deleteIds.push(...sources.map((s) => s.id));
    }
  }

  // Строку, которую человек склеил парой, в «сомнительных» не показываем.
  const merged = new Set(deleteIds);
  const stillDoubtful = doubtful
    .map((d) => ({ ...d, ids: d.ids.filter((id) => !merged.has(id)) }))
    .filter((d) => d.ids.length > 0);
  return { merges, doubtful: stillDoubtful, pairIssues, updates, deleteIds };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Файл ручных пар: строка «id источника;id цели» (или через запятую или
 * табуляцию). Пустые строки и «#…» пропускаются; первая строка может быть
 * заголовком. Любая другая строка — ошибка: молча пропущенная пара хуже
 * остановки до записи.
 */
export function parseManualPairs(text: string): { pairs: ManualPair[]; errors: string[] } {
  const pairs: ManualPair[] = [];
  const errors: string[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let first = true;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const isFirst = first;
    first = false;
    const cells = line.split(/[;,\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
    const [sourceId, targetId] = cells;
    if (sourceId && targetId && UUID_RE.test(sourceId) && UUID_RE.test(targetId)) {
      pairs.push({ sourceId: sourceId.toLowerCase(), targetId: targetId.toLowerCase() });
      return;
    }
    const isHeader = isFirst && !cells.some((c) => UUID_RE.test(c));
    if (!isHeader) errors.push(`строка ${i + 1}: нужны два id через «;» — «${line}»`);
  });
  return { pairs, errors };
}

function pairProblem(
  p: ManualPair,
  byId: ReadonlyMap<string, SupplierRow>,
  seenSources: ReadonlySet<string>,
  pairTargets: ReadonlySet<string>,
  pairSources: ReadonlySet<string>,
  autoDeletes: readonly string[],
): string | null {
  if (p.sourceId === p.targetId) return 'источник и цель совпадают';
  if (seenSources.has(p.sourceId)) return 'источник указан дважды';
  const source = byId.get(p.sourceId);
  if (!source) {
    return autoDeletes.includes(p.sourceId)
      ? 'источник уже склеен автоматически в этом запуске'
      : 'источника нет — уже склеен или удалён';
  }
  const target = byId.get(p.targetId);
  if (!target) return 'цели нет в справочнике';
  if (source.billhubId !== null) return 'источник из BillHub — не удаляется';
  if (hasData(source)) return 'у источника есть статус СБ или комментарий';
  if (pairSources.has(p.targetId)) return 'цель сама указана источником другой пары';
  if (pairTargets.has(p.sourceId)) return 'источник указан целью другой пары';
  return null;
}
