/**
 * УПД из ЭДО приёмок — вход правила `computeEdoSummary`.
 *
 * Все связи, а не только без блока: пару по блоку правило строит само. Номер,
 * дата и суммы — из реестра, у старого пути (импортированная карточка
 * Диадока) — из документа; так же, как у чипов и `GET …/edo-matches`.
 *
 * Число приёмок у УПД — через `edoDocumentUsage`: та же идентичность, что у
 * привязки (реестр и импорт, двойник у другого оператора, все пути связи),
 * а не счёт строк по одному id.
 */
import { eq, inArray, sql as drSql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  deliveryEdoMatches,
  edoAccounts,
  edoExportDocuments,
  sourceDocuments,
} from '../../db/schema.js';
import type { EdoSummaryInput, ScanDocumentInput } from './edo-effective-totals.js';
import { edoDocumentUsage, edoUsageKey } from './edo-usage.js';

function toMoney(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function loadEdoSummaryInputs(
  db: Db,
  deliveryIds: readonly string[],
): Promise<Map<string, EdoSummaryInput[]>> {
  const byDelivery = new Map<string, EdoSummaryInput[]>();
  if (deliveryIds.length === 0) return byDelivery;
  const rows = await db
    .select({
      deliveryId: deliveryEdoMatches.deliveryId,
      matchId: deliveryEdoMatches.id,
      exportDocumentId: deliveryEdoMatches.exportDocumentId,
      sourceDocumentId: deliveryEdoMatches.sourceDocumentId,
      sectionDocumentId: deliveryEdoMatches.sectionDocumentId,
      operator: drSql<
        string | null
      >`case when ${deliveryEdoMatches.exportDocumentId} is not null then ${edoAccounts.provider} else 'diadoc' end`,
      docNumber: drSql<
        string | null
      >`coalesce(${edoExportDocuments.documentNumber}, ${sourceDocuments.docNumber})`,
      docDate: drSql<
        string | null
      >`coalesce(to_char(${edoExportDocuments.documentDate}, 'YYYY-MM-DD'), to_char(${sourceDocuments.docDate}, 'YYYY-MM-DD'))`,
      totalSum: drSql<
        string | null
      >`(case when ${deliveryEdoMatches.exportDocumentId} is not null then ${edoExportDocuments.totalSum} else ${sourceDocuments.totalSum} end)::text`,
      vatSum: drSql<
        string | null
      >`(case when ${deliveryEdoMatches.exportDocumentId} is not null then ${edoExportDocuments.vatSum} else ${sourceDocuments.vatSum} end)::text`,
    })
    .from(deliveryEdoMatches)
    .leftJoin(edoExportDocuments, eq(edoExportDocuments.id, deliveryEdoMatches.exportDocumentId))
    .leftJoin(edoAccounts, eq(edoAccounts.id, edoExportDocuments.edoAccountId))
    .leftJoin(sourceDocuments, eq(sourceDocuments.id, deliveryEdoMatches.sourceDocumentId))
    .where(inArray(deliveryEdoMatches.deliveryId, [...deliveryIds]))
    // Порядок привязки — как блоки ЭДО в карточке.
    .orderBy(deliveryEdoMatches.deliveryId, deliveryEdoMatches.linkedAt, deliveryEdoMatches.id);
  if (rows.length === 0) return byDelivery;

  const refs = rows.map((row) =>
    row.exportDocumentId
      ? { source: 'export' as const, id: row.exportDocumentId }
      : { source: 'import' as const, id: row.sourceDocumentId! },
  );
  const usage = await edoDocumentUsage(db, refs, null);

  rows.forEach((row, index) => {
    const ref = refs[index]!;
    const list = byDelivery.get(row.deliveryId) ?? [];
    list.push({
      matchId: row.matchId,
      source: ref.source,
      documentId: ref.id,
      operator: row.operator ?? 'diadoc',
      docNumber: row.docNumber,
      docDate: row.docDate,
      totalSum: toMoney(row.totalSum),
      vatSum: toMoney(row.vatSum),
      sectionDocumentId: row.sectionDocumentId,
      // Эта приёмка связана с УПД, поэтому меньше одной не бывает.
      deliveryCount: Math.max(1, usage.get(edoUsageKey(ref))?.count ?? 1),
    });
    byDelivery.set(row.deliveryId, list);
  });
  return byDelivery;
}

/**
 * Документы операций для правила — без сводок карточки (выгрузка их не
 * строит): связанные плюс упомянутые в происхождении строк. Дата — YYYY-MM-DD,
 * как у `OperationSourceDocument`, иначе пара «итог и дата» в выгрузке и в
 * списке разошлась бы.
 */
export async function loadScanDocumentInputs(
  db: Db,
  links: readonly { deliveryId: string; sourceDocumentId: string }[],
  items: readonly { deliveryId: string; sourceDocumentId: string | null }[],
): Promise<Map<string, ScanDocumentInput[]>> {
  const linkedByDelivery = new Map<string, Set<string>>();
  const mentionedByDelivery = new Map<string, Set<string>>();
  const mention = (deliveryId: string, docId: string) => {
    const set = mentionedByDelivery.get(deliveryId) ?? new Set<string>();
    set.add(docId);
    mentionedByDelivery.set(deliveryId, set);
  };
  for (const link of links) {
    const set = linkedByDelivery.get(link.deliveryId) ?? new Set<string>();
    set.add(link.sourceDocumentId);
    linkedByDelivery.set(link.deliveryId, set);
    mention(link.deliveryId, link.sourceDocumentId);
  }
  for (const item of items) {
    if (item.sourceDocumentId) mention(item.deliveryId, item.sourceDocumentId);
  }
  const ids = [...new Set([...mentionedByDelivery.values()].flatMap((set) => [...set]))];
  const byDelivery = new Map<string, ScanDocumentInput[]>();
  if (ids.length === 0) return byDelivery;
  const rows = await db
    .select({
      id: sourceDocuments.id,
      kind: sourceDocuments.kind,
      docNumber: sourceDocuments.docNumber,
      docDate: drSql<string | null>`to_char(${sourceDocuments.docDate}, 'YYYY-MM-DD')`,
      totalSum: drSql<string | null>`${sourceDocuments.totalSum}::text`,
    })
    .from(sourceDocuments)
    .where(inArray(sourceDocuments.id, ids));
  const rowById = new Map(rows.map((row) => [row.id, row]));
  for (const [deliveryId, docIds] of mentionedByDelivery) {
    const linked = linkedByDelivery.get(deliveryId) ?? new Set<string>();
    const list: ScanDocumentInput[] = [];
    for (const docId of docIds) {
      const row = rowById.get(docId);
      if (!row) continue;
      list.push({ ...row, linked: linked.has(docId) });
    }
    byDelivery.set(deliveryId, list);
  }
  return byDelivery;
}
