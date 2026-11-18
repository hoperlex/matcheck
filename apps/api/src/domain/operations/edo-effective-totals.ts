/**
 * Номера, даты и суммы приёмки с учётом привязанных УПД из ЭДО/СБИС.
 *
 * Шапка карточки, окно просмотра, колонки списка и выгрузка в Excel раньше
 * считали по скану и по факту строк, даже когда к приёмке привязана УПД из
 * ЭДО — юридический документ с точными суммами. Правило здесь одно на все
 * четыре места: где есть пара «УПД из ЭДО ↔ документ скана», скан заменяется
 * УПД; всё, что пары не имеет, считается как раньше.
 *
 * Пара:
 *   - по блоку — УПД привязана к блоку документа (`sectionDocumentId`); это
 *     явное действие человека, вид документа не важен (бывает и накладная);
 *   - без блока — только по содержанию и только с единственным кандидатом
 *     вида `upd`: сначала по номеру, затем по итогу и дате. Связь «к приёмке
 *     целиком» НЕ значит «заменить всю приёмку»: отвязка скана обнуляет блок
 *     (unlink-source), и без проверки содержания УПД скана A «съела» бы
 *     соседний документ B.
 *
 * Базы сумм разные и не смешиваются:
 *   - шапка — итоги документов С НДС (как `sumDocumentTotals` в вебе);
 *   - список и Excel — без НДС (Σ qty × price) и отдельно НДС, как
 *     `computeItemsTotal`/`computeItemsVatSum`.
 *
 * Неизвестное не становится нулём: УПД без итога в шапке — «указана у k из n»,
 * в списке её группа остаётся на факте своих строк.
 */
import { normalizeDocNumber as cleanDocNumber } from '../edo/upd-doc-number.js';
import { computeItemsTotal, computeItemsVatSum } from '../../lib/operation-sums.js';

/** УПД из ЭДО, привязанная к приёмке. Суммы — числа, null = неизвестно. */
export type EdoSummaryInput = {
  matchId: string;
  source: 'import' | 'export';
  /** id строки реестра (export) или карточки импорта (import). */
  documentId: string;
  operator: string;
  docNumber: string | null;
  /** YYYY-MM-DD. */
  docDate: string | null;
  totalSum: number | null;
  vatSum: number | null;
  sectionDocumentId: string | null;
  /** Сколько разных приёмок с этой УПД, включая эту. */
  deliveryCount: number;
};

/** Документ операции — подмножество `OperationSourceDocument`. */
export type ScanDocumentInput = {
  id: string;
  kind: string;
  docNumber: string | null;
  docDate: string | null;
  totalSum: string | null;
  linked: boolean;
};

export type ItemMoneyInput = {
  sourceDocumentId: string | null;
  price: string | null;
  qtyActual: string | null;
  qtyPlanned: string | null;
  vatSum: string | null;
};

export type EdoPairedBy = 'section' | 'number' | 'sum_date';

export type EdoSummaryDocument = {
  matchId: string;
  source: 'import' | 'export';
  documentId: string;
  operator: string;
  docNumber: string | null;
  docDate: string | null;
  totalSum: number | null;
  vatSum: number | null;
  sectionDocumentId: string | null;
  pairedSourceDocumentId: string | null;
  pairedBy: EdoPairedBy | null;
  deliveryCount: number;
  /** Строки этой УПД заменили факт в списке и выгрузке. */
  replacesFact: boolean;
};

export type EdoSummary = {
  documents: EdoSummaryDocument[];
  /** Связанные документы скана без пары — в шапке остаются как есть. */
  unpairedLinkedDocumentIds: string[];
  /**
   * Остались и УПД из ЭДО без пары, и связанный скан УПД без пары: сумма могла
   * учесть один документ дважды — сказать об этом человеку.
   */
  ambiguous: boolean;
  /** Наибольшее число приёмок у одной УПД (1 — общих нет). */
  sharedMax: number;
  header: {
    /** Σ известных частей (с НДС); null — ни одной известной. */
    total: number | null;
    /** Частей с известным итогом и всего частей (УПД ЭДО + сканы без пары). */
    known: number;
    count: number;
    source: 'edo' | 'mixed';
    /** Только по парам со сканом вида `upd` и известными итогами; иначе null. */
    comparison: { edo: number; scan: number; mismatch: boolean } | null;
  };
  list: {
    /** Без НДС: ЭДО заменённых групп + факт остальных строк. */
    exVat: number | null;
    vat: number | null;
    source: 'edo' | 'mixed' | 'fact';
    edoExVat: number | null;
    edoVat: number | null;
    /** Остаток факта: все строки, кроме строк заменённых групп. */
    factExVat: number | null;
    factVat: number | null;
    /** УПД, которые не заменили факт: нет итога или НДС. */
    edoMissing: number;
  };
};

/** Разница больше копейки — расхождение; ровно копейка — округление. */
const MISMATCH_CENTS = 1;

const toCents = (value: number): number => Math.round(value * 100);
const fromCents = (cents: number): number => cents / 100;

function parseMoney(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Ключ номера для пары: без «№», регистра, гомоглифов и разделителей, без
 * ведущих нулей в группах цифр. «001029-01» и «1029-01», «1116-1» и «1116-01»
 * — один номер; так их пишут распознавание и ЭДО. null — номера без цифр нет.
 */
export function docNumberPairKey(raw: string | null): string | null {
  const clean = cleanDocNumber(raw);
  if (clean === null) return null;
  return clean
    .replace(/(^|\D)0+(?=\d)/g, '$1')
    .replace(/[\s/._\\-]/g, '')
    .toUpperCase();
}

export function computeEdoSummary(args: {
  edo: readonly EdoSummaryInput[];
  documents: readonly ScanDocumentInput[];
  items: readonly ItemMoneyInput[];
}): EdoSummary | null {
  const { edo, documents, items } = args;
  if (edo.length === 0) return null;

  const docById = new Map(documents.map((d) => [d.id, d]));
  const paired = new Map<string, { docId: string; by: EdoPairedBy }>();
  const takenDocs = new Set<string>();

  // 1. Явные пары — по блоку. Блок, которого среди документов нет (связь
  //    устарела), — как связь без блока.
  for (const e of edo) {
    if (e.sectionDocumentId && docById.has(e.sectionDocumentId)) {
      paired.set(e.matchId, { docId: e.sectionDocumentId, by: 'section' });
      takenDocs.add(e.sectionDocumentId);
    }
  }

  // 2. Без блока — по содержанию, единственный кандидат вида `upd`. Сначала
  //    все пары по номеру, потом по итогу и дате: иначе совпадение по сумме у
  //    первой УПД могло бы забрать документ, который второй подходит по номеру.
  const free = edo.filter((e) => !paired.has(e.matchId));
  const candidates = () => documents.filter((d) => d.kind === 'upd' && !takenDocs.has(d.id));

  for (const e of free) {
    const key = docNumberPairKey(e.docNumber);
    if (key === null) continue;
    const hits = candidates().filter((d) => docNumberPairKey(d.docNumber) === key);
    if (hits.length === 1) {
      paired.set(e.matchId, { docId: hits[0]!.id, by: 'number' });
      takenDocs.add(hits[0]!.id);
    }
  }
  for (const e of free) {
    if (paired.has(e.matchId) || e.totalSum === null || e.docDate === null) continue;
    const edoCents = toCents(e.totalSum);
    const hits = candidates().filter((d) => {
      const total = parseMoney(d.totalSum);
      return total !== null && Math.abs(toCents(total) - edoCents) <= 1 && d.docDate === e.docDate;
    });
    if (hits.length === 1) {
      paired.set(e.matchId, { docId: hits[0]!.id, by: 'sum_date' });
      takenDocs.add(hits[0]!.id);
    }
  }

  // Группы: документ скана и все его УПД; УПД без пары — группа сама по себе.
  type Group = { docId: string | null; edo: EdoSummaryInput[] };
  const groups: Group[] = [];
  const groupByDoc = new Map<string, Group>();
  for (const e of edo) {
    const pair = paired.get(e.matchId);
    if (!pair) {
      groups.push({ docId: null, edo: [e] });
      continue;
    }
    let group = groupByDoc.get(pair.docId);
    if (!group) {
      group = { docId: pair.docId, edo: [] };
      groupByDoc.set(pair.docId, group);
      groups.push(group);
    }
    group.edo.push(e);
  }

  const unpairedLinked = documents.filter((d) => d.linked && !takenDocs.has(d.id));

  // ── Шапка: с НДС, итоги документов ──
  let headerCents = 0;
  let headerKnown = 0;
  for (const e of edo) {
    if (e.totalSum === null) continue;
    headerCents += toCents(e.totalSum);
    headerKnown++;
  }
  for (const d of unpairedLinked) {
    const total = parseMoney(d.totalSum);
    if (total === null) continue;
    headerCents += toCents(total);
    headerKnown++;
  }
  // Сравнение — только с документом УПД, связанным сейчас: отвязанный человек
  // уже убрал из приёмки, а накладная — не та бумага, чтобы сверять итог.
  let cmpEdo = 0;
  let cmpScan = 0;
  let comparable = 0;
  for (const g of groups) {
    if (g.docId === null) continue;
    const doc = docById.get(g.docId);
    if (!doc || doc.kind !== 'upd' || !doc.linked) continue;
    const scan = parseMoney(doc.totalSum);
    if (scan === null || g.edo.some((e) => e.totalSum === null)) continue;
    cmpEdo += g.edo.reduce((sum, e) => sum + toCents(e.totalSum!), 0);
    cmpScan += toCents(scan);
    comparable++;
  }

  // ── Список и Excel: без НДС и НДС отдельно ──
  const replacedDocs = new Set<string>();
  const replacedMatches = new Set<string>();
  let edoExVatCents = 0;
  let edoVatCents = 0;
  let edoMissing = 0;
  for (const g of groups) {
    const complete = g.edo.every((e) => e.totalSum !== null && e.vatSum !== null);
    if (!complete) {
      edoMissing += g.edo.length;
      continue;
    }
    for (const e of g.edo) {
      edoExVatCents += toCents(e.totalSum!) - toCents(e.vatSum!);
      edoVatCents += toCents(e.vatSum!);
      replacedMatches.add(e.matchId);
    }
    if (g.docId !== null) replacedDocs.add(g.docId);
  }
  const residual = items.filter(
    (it) => it.sourceDocumentId === null || !replacedDocs.has(it.sourceDocumentId),
  );
  const factExVat = computeItemsTotal(residual);
  const factVat = computeItemsVatSum(residual);
  const anyReplaced = replacedMatches.size > 0;
  const edoExVat = anyReplaced ? fromCents(edoExVatCents) : null;
  const edoVat = anyReplaced ? fromCents(edoVatCents) : null;
  const add = (a: number | null, b: number | null) =>
    a === null && b === null ? null : (a ?? 0) + (b ?? 0);

  return {
    documents: edo.map((e) => {
      const pair = paired.get(e.matchId);
      return {
        matchId: e.matchId,
        source: e.source,
        documentId: e.documentId,
        operator: e.operator,
        docNumber: e.docNumber,
        docDate: e.docDate,
        totalSum: e.totalSum,
        vatSum: e.vatSum,
        sectionDocumentId: e.sectionDocumentId,
        pairedSourceDocumentId: pair?.docId ?? null,
        pairedBy: pair?.by ?? null,
        deliveryCount: e.deliveryCount,
        replacesFact: replacedMatches.has(e.matchId),
      };
    }),
    unpairedLinkedDocumentIds: unpairedLinked.map((d) => d.id),
    ambiguous:
      edo.some((e) => !paired.has(e.matchId)) && unpairedLinked.some((d) => d.kind === 'upd'),
    sharedMax: Math.max(1, ...edo.map((e) => e.deliveryCount)),
    header: {
      total: headerKnown > 0 ? fromCents(headerCents) : null,
      known: headerKnown,
      count: edo.length + unpairedLinked.length,
      // Накладная без суммы в итог ничего не вносит — подпись остаётся «по ЭДО».
      source: unpairedLinked.some((d) => parseMoney(d.totalSum) !== null) ? 'mixed' : 'edo',
      comparison:
        comparable > 0
          ? {
              edo: fromCents(cmpEdo),
              scan: fromCents(cmpScan),
              mismatch: Math.abs(cmpEdo - cmpScan) > MISMATCH_CENTS,
            }
          : null,
    },
    list: {
      exVat: anyReplaced ? add(edoExVat, factExVat) : factExVat,
      vat: anyReplaced ? add(edoVat, factVat) : factVat,
      source: !anyReplaced ? 'fact' : factExVat !== null || factVat !== null ? 'mixed' : 'edo',
      edoExVat,
      edoVat,
      factExVat,
      factVat,
      edoMissing,
    },
  };
}
