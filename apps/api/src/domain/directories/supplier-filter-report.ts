// Отчёт по группам поставщиков (фильтр «Поставщик» и окно выбора в карточке)
// перед выпуском: что склеилось, что выдача потеряла и что добавила по
// сравнению с прежним фильтром «одна запись справочника + контрагенты по ИНН».
//
// Расчёт — те же функции, что у фильтра (buildSupplierFilterGroups,
// matchCounterpartiesToGroups), поэтому отчёт показывает ровно то, что увидит
// человек. Только чтение. Запуск — scripts/supplier-filter-report.ts.

import ExcelJS from 'exceljs';
import { isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  counterparties,
  customerCounterparties,
  deliveries,
  deliverySources,
  shipmentSources,
  shipments,
  sourceDocuments,
  suppliers,
} from '../../db/schema.js';
import { loadOwnInns } from '../sourceDocuments/supplier-inn-check.js';
import { companyKey, editDistance } from './names.js';
import {
  buildSupplierFilterGroups,
  filterInn,
  isCorrectFilterInn,
  matchCounterpartiesToGroups,
  type CounterpartyForMatch,
  type SupplierFilterGroup,
  type SupplierGroupContext,
  type SupplierGroupRow,
} from './supplier-filter-groups.js';

/** Запись справочника для отчёта: статус СБ и комментарий решают, можно ли её склеить. */
export type ReportSupplierRow = SupplierGroupRow & {
  lastSecurityStatus?: string | null;
  foundingDocumentsComment?: string | null;
};

export type ReportInput = {
  suppliers: ReportSupplierRow[];
  ctx: SupplierGroupContext;
  counterparties: CounterpartyForMatch[];
  documents: { id: string; number: string | null; dirId: string | null; opId: string | null }[];
  deliveries: { id: string; displayId: number; opId: string | null }[];
  deliverySources: { ownerId: string; documentId: string }[];
  shipments: { id: string; displayId: number; opId: string | null }[];
  shipmentSources: { ownerId: string; documentId: string }[];
};

type RowKind = 'приёмка' | 'отгрузка' | 'документ';
/** Как строка попала в выдачу. */
type Via =
  | { by: 'dir'; supplierId: string }
  | { by: 'op'; counterpartyId: string; match: 'old_inn' | 'billhub_inn' | 'inn_and_name' };
type Found = Map<string, Via>; // `${kind}:${id}` → путь

export type LostRow = {
  supplierId: string;
  supplierName: string;
  supplierInn: string;
  group: string;
  kind: RowKind;
  ref: string;
  counterparty: string;
};
export type AddedRow = { group: string; kind: RowKind; ref: string; reason: string };

export type SupplierFilterReport = {
  suppliers: number;
  groups: SupplierFilterGroup[];
  duplicateLabels: string[];
  members: Array<{
    group: string;
    representative: boolean;
    representativeWhy: string;
    id: string;
    name: string;
    inn: string;
    billhub: boolean;
    correctInn: boolean;
    foreignInn: boolean;
    docs: number;
  }>;
  limitation: Array<{
    group: string;
    members: number;
    inns: string;
    billhub: number;
    docs: number;
  }>;
  abbreviations: Array<{ group: string; keys: string; members: number }>;
  lost: LostRow[];
  added: AddedRow[];
  billhubException: AddedRow[];
  pairCandidates: PairCandidate[];
  pairRejected: PairRejected[];
};

export type PairRule = 'а: ТД X ↔ X' | 'б: остаток тёзок';

/** Кандидат в ручную пару import-directories --pairs: дубль → запись BillHub. */
export type PairCandidate = {
  rule: PairRule;
  sourceId: string;
  sourceName: string;
  sourceInn: string;
  sourceDocs: number;
  targetId: string;
  targetName: string;
  targetInn: string;
  /** Правок между ИНН (замена, вставка, удаление, перестановка цифр). */
  distance: number;
};

export type PairRejected = { rule: PairRule; source: string; target: string; reason: string };

// Ведущее сокращение ключа: «ТД ТУЛА-СТАЛЬ» → «ТУЛА-СТАЛЬ».
const LEADING_ABBREVIATION = /^(?:ТД|ТК|СК|ГК|СТД|СЗ) (.+)$/u;
// Сколько правок ИНН ещё считается ошибкой чтения той же организации.
const PAIR_MAX_INN_EDITS = 2;

/**
 * Хвосты, которые группировка сознательно не склеивает (решение 03.11), —
 * кандидатами в ручные пары справочника. Решает человек: CSV выходит
 * закомментированным.
 *
 *   (а) «ТД X» и «X»: ровно у одной стороны есть BillHub, и ИНН записи другой
 *       стороны в ≤2 правках от ИНН записи BillHub. Общее правило «ТД X = X»
 *       отвергнуто: на бою половина таких пар — разные фирмы.
 *   (б) остаток тёзок («ИНН не подтверждён»): ИНН в ≤2 правках ровно от одного
 *       ИНН BillHub своего имени.
 *
 * Цель — всегда запись BillHub с верным ИНН. Источник — не из BillHub и без
 * статуса СБ и комментария: такие склейка (pairProblem) отклоняет сама.
 */
export function buildPairCandidates(
  groups: readonly SupplierFilterGroup[],
  rows: readonly ReportSupplierRow[],
): { candidates: PairCandidate[]; rejected: PairRejected[] } {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const candidates: PairCandidate[] = [];
  const rejected: PairRejected[] = [];
  const membersOf = (gs: readonly SupplierFilterGroup[]): ReportSupplierRow[] =>
    gs.flatMap((g) => g.memberIds.map((id) => byId.get(id)!));
  // Записи BillHub с верным ИНН — по одной на ИНН (основная идёт первой).
  const targetsOf = (gs: readonly SupplierFilterGroup[]): ReportSupplierRow[] => {
    const seen = new Map<string, ReportSupplierRow>();
    for (const m of membersOf(gs)) {
      const d = filterInn(m.inn);
      if (m.billhubId !== null && isCorrectFilterInn(d) && !seen.has(d!)) seen.set(d!, m);
    }
    return [...seen.values()];
  };
  const pairFor = (
    rule: PairRule,
    source: ReportSupplierRow,
    targets: readonly ReportSupplierRow[],
  ): void => {
    const label = `${source.name} (ИНН ${source.inn || '—'})`;
    if (source.billhubId !== null) {
      rejected.push({
        rule,
        source: label,
        target: '',
        reason: 'источник из BillHub — не удаляется',
      });
      return;
    }
    if (source.lastSecurityStatus || source.foundingDocumentsComment?.trim()) {
      rejected.push({
        rule,
        source: label,
        target: '',
        reason: 'у источника статус СБ или комментарий',
      });
      return;
    }
    const d = filterInn(source.inn);
    const near = d
      ? targets
          .map((t) => ({ t, distance: editDistance(d, filterInn(t.inn)!) }))
          .filter((x) => x.distance <= PAIR_MAX_INN_EDITS)
      : [];
    if (near.length !== 1) {
      rejected.push({
        rule,
        source: label,
        target: targets.map((t) => `${t.name} (ИНН ${t.inn})`).join('; '),
        reason: near.length === 0 ? 'нет связи по ИНН' : 'ИНН близок к нескольким записям BillHub',
      });
      return;
    }
    const { t, distance } = near[0]!;
    candidates.push({
      rule,
      sourceId: source.id,
      sourceName: source.name,
      sourceInn: source.inn,
      sourceDocs: source.docCount ?? 0,
      targetId: t.id,
      targetName: t.name,
      targetInn: t.inn,
      distance,
    });
  };

  const byKey = new Map<string, SupplierFilterGroup[]>();
  for (const g of groups) if (g.key) byKey.set(g.key, [...(byKey.get(g.key) ?? []), g]);

  // (а) «ТД X» ↔ «X».
  for (const [key, withAbbr] of byKey) {
    const m = LEADING_ABBREVIATION.exec(key);
    const plain = m ? byKey.get(m[1]!) : undefined;
    if (!plain) continue;
    const rule: PairRule = 'а: ТД X ↔ X';
    const hasBillhub = (gs: readonly SupplierFilterGroup[]) =>
      membersOf(gs).some((r) => r.billhubId !== null);
    const [a, b] = [hasBillhub(withAbbr), hasBillhub(plain)];
    if (a === b) {
      rejected.push({
        rule,
        source: withAbbr[0]!.label,
        target: plain[0]!.label,
        reason: a ? 'обе стороны в BillHub — вероятно, разные фирмы' : 'ни одной записи BillHub',
      });
      continue;
    }
    const [sourceSide, targetSide] = a ? [plain, withAbbr] : [withAbbr, plain];
    const targets = targetsOf(targetSide);
    if (targets.length === 0) {
      rejected.push({
        rule,
        source: sourceSide[0]!.label,
        target: targetSide[0]!.label,
        reason: 'у записи BillHub некорректный ИНН',
      });
      continue;
    }
    for (const r of membersOf(sourceSide)) pairFor(rule, r, targets);
  }

  // (б) Остаток тёзок: группа имени без записи BillHub с верным ИНН, когда
  // таких записей у имени ≥2 — то есть «ИНН не подтверждён».
  for (const list of byKey.values()) {
    const targets = targetsOf(list);
    if (targets.length < 2) continue;
    for (const g of list) {
      if (targetsOf([g]).length > 0) continue;
      for (const r of membersOf([g])) pairFor('б: остаток тёзок', r, targets);
    }
  }
  return { candidates, rejected };
}

/**
 * CSV для import-directories --pairs (формат parseManualPairs). Каждая строка
 * закомментирована: в склейку попадает только то, что человек раскомментировал.
 */
export function pairCandidatesCsv(candidates: readonly PairCandidate[]): string {
  const lines = [
    '# Кандидаты в ручные пары: источник;цель — дубль справочника → запись BillHub.',
    '# Отчёт supplier-filter-report.ts. Раскомментируйте подтверждённые строки и',
    '# запустите import-directories.ts --merges-only --pairs <этот файл> (сначала dry-run).',
    ...candidates.map(
      (c) =>
        `# ${c.sourceId};${c.targetId};${c.rule};${c.sourceName} (ИНН ${c.sourceInn || '—'}, док. ${c.sourceDocs}) → ${c.targetName} (ИНН ${c.targetInn}), правок ИНН ${c.distance}`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

function push<K, V>(m: Map<K, V[]>, k: K | null, v: V): void {
  if (k === null) return;
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

export function computeSupplierFilterReport(input: ReportInput): SupplierFilterReport {
  const groups = buildSupplierFilterGroups(input.suppliers, input.ctx);
  const byId = new Map(input.suppliers.map((s) => [s.id, s]));
  const cpById = new Map(input.counterparties.map((c) => [c.id, c]));
  const cpByInn = new Map<string, CounterpartyForMatch[]>();
  for (const c of input.counterparties) push(cpByInn, filterInn(c.inn), c);

  const docsByDir = new Map<string, string[]>();
  const docsByOp = new Map<string, string[]>();
  const docNumber = new Map<string, string>();
  for (const d of input.documents) {
    push(docsByDir, d.dirId, d.id);
    push(docsByOp, d.opId, d.id);
    docNumber.set(d.id, d.number ?? d.id);
  }
  const owners = (
    rows: ReportInput['deliveries'],
    links: ReportInput['deliverySources'],
  ): { byOp: Map<string, string[]>; byDoc: Map<string, string[]>; ref: Map<string, string> } => {
    const byOp = new Map<string, string[]>();
    const byDoc = new Map<string, string[]>();
    const ref = new Map<string, string>();
    for (const r of rows) {
      push(byOp, r.opId, r.id);
      ref.set(r.id, String(r.displayId));
    }
    for (const l of links) push(byDoc, l.documentId, l.ownerId);
    return { byOp, byDoc, ref };
  };
  const del = owners(input.deliveries, input.deliverySources);
  const shp = owners(input.shipments, input.shipmentSources);

  // Что находит фильтр по набору записей справочника и контрагентов — по тем
  // же путям, что SQL в deliveries.ts / shipments.ts / list-filters.ts.
  // Прежний фильтр отгрузок смотрел только на свой supplier_id, без документа.
  const collect = (
    dirIds: readonly string[],
    ops: ReadonlyMap<string, Via>,
    shipmentDocs: boolean,
  ): Found => {
    const found: Found = new Map();
    const docs = new Map<string, Via>();
    for (const dirId of dirIds) {
      for (const doc of docsByDir.get(dirId) ?? []) docs.set(doc, { by: 'dir', supplierId: dirId });
    }
    for (const [cpId, via] of ops) {
      for (const doc of docsByOp.get(cpId) ?? []) if (!docs.has(doc)) docs.set(doc, via);
    }
    for (const [doc, via] of docs) found.set(`документ:${doc}`, via);
    for (const [kind, o] of [
      ['приёмка', del],
      ['отгрузка', shp],
    ] as const) {
      for (const [cpId, via] of ops) {
        for (const id of o.byOp.get(cpId) ?? []) found.set(`${kind}:${id}`, via);
      }
      if (kind === 'отгрузка' && !shipmentDocs) continue;
      for (const [doc, via] of docs) {
        for (const id of o.byDoc.get(doc) ?? []) {
          if (!found.has(`${kind}:${id}`)) found.set(`${kind}:${id}`, via);
        }
      }
    }
    return found;
  };
  const refOf = (key: string): { kind: RowKind; ref: string } => {
    const [kind, id] = key.split(':') as [RowKind, string];
    const ref =
      kind === 'документ'
        ? (docNumber.get(id) ?? id)
        : ((kind === 'приёмка' ? del : shp).ref.get(id) ?? id);
    return { kind, ref };
  };
  const cpLabel = (cpId: string): string => {
    const c = cpById.get(cpId);
    return c ? `${c.name} (ИНН ${c.inn})` : cpId;
  };
  const reasonOf = (via: Via): string => {
    if (via.by === 'dir') {
      const s = byId.get(via.supplierId);
      return `документ на записи «${s?.name ?? via.supplierId}» (ИНН ${s?.inn || '—'})`;
    }
    return via.match === 'billhub_inn'
      ? `контрагент ${cpLabel(via.counterpartyId)} — ИНН записи BillHub, имя другое`
      : `контрагент ${cpLabel(via.counterpartyId)} — ИНН и имя/алиас`;
  };

  // Прежний фильтр по одной записи: она сама + контрагенты с её ИНН.
  const oldFound = (s: SupplierGroupRow): Found => {
    const d = filterInn(s.inn);
    const ops = new Map<string, Via>();
    for (const c of d ? (cpByInn.get(d) ?? []) : []) {
      ops.set(c.id, { by: 'op', counterpartyId: c.id, match: 'old_inn' });
    }
    return collect([s.id], ops, false);
  };
  const newFound = (g: SupplierFilterGroup): Found => {
    const candidates = g.inns.flatMap((i) => cpByInn.get(i.digits) ?? []);
    const ops = new Map<string, Via>();
    for (const [cpId, match] of matchCounterpartiesToGroups([g], candidates)) {
      ops.set(cpId, { by: 'op', counterpartyId: cpId, match });
    }
    return collect(g.memberIds, ops, true);
  };

  const members: SupplierFilterReport['members'] = [];
  const limitation: SupplierFilterReport['limitation'] = [];
  const abbreviations: SupplierFilterReport['abbreviations'] = [];
  const lost: LostRow[] = [];
  const added: AddedRow[] = [];
  const billhubException: AddedRow[] = [];
  const foreign = (d: string | null): boolean =>
    d !== null && (input.ctx.ownInns?.has(d) === true || input.ctx.contractorInns?.has(d) === true);

  for (const g of groups) {
    const rows = g.memberIds.map((id) => byId.get(id)!);
    const rep = byId.get(g.value)!;
    const repInn = filterInn(rep.inn);
    const repWhy =
      rep.billhubId !== null && isCorrectFilterInn(repInn)
        ? 'BillHub, ИНН верный'
        : rep.billhubId !== null
          ? 'BillHub'
          : isCorrectFilterInn(repInn) && !foreign(repInn)
            ? 'ИНН верный, не свой и не подрядчика'
            : isCorrectFilterInn(repInn)
              ? 'ИНН верный'
              : rows.length > 1
                ? 'больше документов / старше'
                : 'единственная запись';
    if (rows.length > 1) {
      for (const r of rows) {
        const d = filterInn(r.inn);
        members.push({
          group: g.label,
          representative: r.id === g.value,
          representativeWhy: r.id === g.value ? repWhy : '',
          id: r.id,
          name: r.name,
          inn: r.inn,
          billhub: r.billhubId !== null,
          correctInn: isCorrectFilterInn(d),
          foreignInn: foreign(d),
          docs: r.docCount ?? 0,
        });
      }
      const correct = [
        ...new Set(rows.map((r) => filterInn(r.inn)).filter((d) => isCorrectFilterInn(d))),
      ];
      if (correct.length >= 2) {
        limitation.push({
          group: g.label,
          members: rows.length,
          inns: correct.join(', '),
          billhub: rows.filter((r) => r.billhubId !== null).length,
          docs: rows.reduce((n, r) => n + (r.docCount ?? 0), 0),
        });
      }
      const keys = [...new Set(rows.map((r) => companyKey(r.name)))];
      if (keys.length > 1)
        abbreviations.push({ group: g.label, keys: keys.join(' | '), members: rows.length });
    }

    const now = newFound(g);
    for (const r of rows) {
      for (const [key, via] of oldFound(r)) {
        if (now.has(key)) continue;
        const { kind, ref } = refOf(key);
        lost.push({
          supplierId: r.id,
          supplierName: r.name,
          supplierInn: r.inn,
          group: g.label,
          kind,
          ref,
          counterparty: via.by === 'op' ? cpLabel(via.counterpartyId) : '',
        });
      }
    }
    const before = oldFound(rep);
    for (const [key, via] of now) {
      const { kind, ref } = refOf(key);
      if (via.by === 'op' && via.match === 'billhub_inn') {
        billhubException.push({ group: g.label, kind, ref, reason: reasonOf(via) });
      }
      if (!before.has(key)) added.push({ group: g.label, kind, ref, reason: reasonOf(via) });
    }
  }

  const counts = new Map<string, number>();
  for (const g of groups) counts.set(g.label, (counts.get(g.label) ?? 0) + 1);
  const pairs = buildPairCandidates(groups, input.suppliers);
  return {
    suppliers: input.suppliers.length,
    groups,
    duplicateLabels: [...counts].filter(([, n]) => n > 1).map(([l]) => l),
    members,
    limitation,
    abbreviations,
    lost,
    added,
    billhubException,
    pairCandidates: pairs.candidates,
    pairRejected: pairs.rejected,
  };
}

/** Всё для отчёта одним проходом по базе (только SELECT). */
export async function loadSupplierFilterReportInput(db: Db): Promise<ReportInput> {
  const [sup, counts, ownInns, cc, cps, docs, dels, dsrc, ships, ssrc] = await Promise.all([
    db
      .select({
        id: suppliers.id,
        name: suppliers.name,
        inn: suppliers.inn,
        aliases: suppliers.aliases,
        billhubId: suppliers.billhubId,
        createdAt: suppliers.createdAt,
        lastSecurityStatus: suppliers.lastSecurityStatus,
        foundingDocumentsComment: suppliers.foundingDocumentsComment,
      })
      .from(suppliers),
    db
      .select({ id: sourceDocuments.supplierDirectoryId, n: sql<number>`count(*)::int` })
      .from(sourceDocuments)
      .where(isNotNull(sourceDocuments.supplierDirectoryId))
      .groupBy(sourceDocuments.supplierDirectoryId),
    loadOwnInns(db),
    db.select({ inn: customerCounterparties.inn }).from(customerCounterparties),
    db
      .select({
        id: counterparties.id,
        inn: counterparties.inn,
        name: counterparties.name,
        aliases: counterparties.aliases,
      })
      .from(counterparties),
    db
      .select({
        id: sourceDocuments.id,
        number: sourceDocuments.docNumber,
        dirId: sourceDocuments.supplierDirectoryId,
        opId: sourceDocuments.supplierId,
      })
      .from(sourceDocuments)
      .where(
        sql`${sourceDocuments.supplierDirectoryId} is not null or ${sourceDocuments.supplierId} is not null`,
      ),
    db
      .select({ id: deliveries.id, displayId: deliveries.displayId, opId: deliveries.supplierId })
      .from(deliveries)
      .where(sql`${deliveries.pendingDeletionAt} is null`),
    db
      .select({ ownerId: deliverySources.deliveryId, documentId: deliverySources.sourceDocumentId })
      .from(deliverySources),
    db
      .select({ id: shipments.id, displayId: shipments.displayId, opId: shipments.supplierId })
      .from(shipments)
      .where(sql`${shipments.pendingDeletionAt} is null`),
    db
      .select({ ownerId: shipmentSources.shipmentId, documentId: shipmentSources.sourceDocumentId })
      .from(shipmentSources),
  ]);
  const docCount = new Map(counts.map((c) => [c.id, c.n]));
  return {
    suppliers: sup.map((s) => ({ ...s, docCount: docCount.get(s.id) ?? 0 })),
    ctx: {
      ownInns,
      contractorInns: new Set(
        cc.map((c) => filterInn(c.inn)).filter((d): d is string => d !== null),
      ),
    },
    counterparties: cps,
    documents: docs,
    deliveries: dels,
    deliverySources: dsrc,
    shipments: ships,
    shipmentSources: ssrc,
  };
}

export async function buildSupplierFilterReportXlsx(r: SupplierFilterReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const frozen = { views: [{ state: 'frozen' as const, ySplit: 1 }] };
  const sheet = (title: string, columns: Partial<ExcelJS.Column>[]) => {
    const ws = wb.addWorksheet(title, frozen);
    ws.columns = columns;
    ws.getRow(1).font = { bold: true };
    return ws;
  };

  const multi = r.groups.filter((g) => g.memberIds.length > 1);
  const summary = sheet('Сводка', [
    { header: 'Показатель', key: 'k', width: 60 },
    { header: 'Значение', key: 'v', width: 14 },
  ]);
  for (const [k, v] of [
    ['Записей справочника', r.suppliers],
    ['Строк выбора (групп)', r.groups.length],
    ['Групп из нескольких записей', multi.length],
    ['Записей в них', multi.reduce((n, g) => n + g.memberIds.length, 0)],
    ['Повторяющихся подписей (должно быть 0)', r.duplicateLabels.length],
    ['Имён с несколькими верными ИНН без двух ИНН BillHub', r.limitation.length],
    ['Групп, склеенных сокращениями (ТД, СТД, ГК…)', r.abbreviations.length],
    ['Потери: строк, которые прежний фильтр находил, а новый нет', r.lost.length],
    ['Добавления к выдаче основной записи', r.added.length],
    ['Строк только через ИНН записи BillHub (имя другое)', r.billhubException.length],
    ['Кандидатов в ручные пары', r.pairCandidates.length],
    ['Пар отклонено (с причиной)', r.pairRejected.length],
  ] as const) {
    summary.addRow({ k, v });
  }

  const m = sheet('Группы', [
    { header: 'Строка выбора', key: 'group', width: 50 },
    { header: 'Основная', key: 'rep', width: 9 },
    { header: 'Почему основная', key: 'why', width: 34 },
    { header: 'id записи', key: 'id', width: 38 },
    { header: 'Название записи', key: 'name', width: 50 },
    { header: 'ИНН', key: 'inn', width: 14 },
    { header: 'BillHub', key: 'bh', width: 8 },
    { header: 'ИНН верный', key: 'ok', width: 11 },
    { header: 'ИНН свой/подрядчика', key: 'foreign', width: 18 },
    { header: 'Документов', key: 'docs', width: 11 },
  ]);
  for (const x of r.members) {
    m.addRow({
      group: x.group,
      rep: x.representative ? 'да' : '',
      why: x.representativeWhy,
      id: x.id,
      name: x.name,
      inn: x.inn,
      bh: x.billhub ? 'да' : '',
      ok: x.correctInn ? 'да' : '',
      foreign: x.foreignInn ? 'да' : '',
      docs: x.docs,
    });
  }

  const lost = sheet('Потери', [
    { header: 'Запись справочника', key: 'name', width: 46 },
    { header: 'ИНН записи', key: 'inn', width: 14 },
    { header: 'Строка выбора', key: 'group', width: 46 },
    { header: 'Что', key: 'kind', width: 10 },
    { header: '№ / id', key: 'ref', width: 16 },
    { header: 'Находилась через контрагента', key: 'cp', width: 56 },
  ]);
  for (const x of r.lost) {
    lost.addRow({
      name: x.supplierName,
      inn: x.supplierInn,
      group: x.group,
      kind: x.kind,
      ref: x.ref,
      cp: x.counterparty,
    });
  }

  for (const [title, rows] of [
    ['Добавления', r.added],
    ['Исключение BillHub', r.billhubException],
  ] as const) {
    const ws = sheet(title, [
      { header: 'Строка выбора', key: 'group', width: 50 },
      { header: 'Что', key: 'kind', width: 10 },
      { header: '№ / id', key: 'ref', width: 16 },
      { header: 'Почему найдена', key: 'reason', width: 90 },
    ]);
    for (const x of rows) ws.addRow(x);
  }

  const lim = sheet('Ограничение', [
    { header: 'Строка выбора', key: 'group', width: 50 },
    { header: 'Записей', key: 'members', width: 9 },
    { header: 'Верные ИНН', key: 'inns', width: 60 },
    { header: 'Из BillHub', key: 'billhub', width: 11 },
    { header: 'Документов', key: 'docs', width: 11 },
    { header: 'Тёзки? (решение)', key: 'decision', width: 18 },
  ]);
  for (const x of r.limitation) lim.addRow(x);

  const abbr = sheet('Сокращения', [
    { header: 'Строка выбора', key: 'group', width: 50 },
    { header: 'Ключи имён до свёртки', key: 'keys', width: 80 },
    { header: 'Записей', key: 'members', width: 9 },
  ]);
  for (const x of r.abbreviations) abbr.addRow(x);

  const cand = sheet('Кандидаты в пары', [
    { header: 'Правило', key: 'rule', width: 18 },
    { header: 'Источник (дубль)', key: 'sourceName', width: 46 },
    { header: 'ИНН источника', key: 'sourceInn', width: 14 },
    { header: 'Документов', key: 'sourceDocs', width: 11 },
    { header: 'Цель (BillHub)', key: 'targetName', width: 46 },
    { header: 'ИНН цели', key: 'targetInn', width: 14 },
    { header: 'Правок ИНН', key: 'distance', width: 11 },
    { header: 'id источника', key: 'sourceId', width: 38 },
    { header: 'id цели', key: 'targetId', width: 38 },
  ]);
  for (const x of r.pairCandidates) cand.addRow(x);

  const rej = sheet('Пары — отклонено', [
    { header: 'Правило', key: 'rule', width: 18 },
    { header: 'Источник', key: 'source', width: 50 },
    { header: 'Цель', key: 'target', width: 60 },
    { header: 'Причина', key: 'reason', width: 44 },
  ]);
  for (const x of r.pairRejected) rej.addRow(x);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
