/**
 * Строки материалов под итогом приёмки в выгрузке «Принятые» с УПД из ЭДО.
 *
 * Итог строки приёмки в Excel — тот же, что в списке (`edoSummary.list`), а
 * под ним — строки самой УПД из ЭДО вместо факта её пары: иначе сумма строк в
 * файле не сходилась бы с итогом, и считать по выгрузке было бы нельзя.
 * Строки, которых в УПД нет (другой документ, ручная строка), остаются фактом.
 *
 * Строки УПД читаются тем же путём, что таблица в карточке и PDF
 * (`linked-edo-items.ts`): из XML реестра или из карточки импорта. Не
 * прочиталась — под итогом факт пары с причиной: пропуск строк выглядел бы как
 * пустая поставка.
 */
import type { FastifyBaseLogger } from 'fastify';
import { inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { edoExportDocuments } from '../../db/schema.js';
import { createBoundedLimiter } from '../../lib/bounded-limiter.js';
import {
  readExportItems,
  readImportedItems,
  type LinkedEdoItem,
  type LinkedEdoItemsResult,
} from '../edo/linked-edo-items.js';
import type { EdoSummary, EdoSummaryDocument, ItemMoneyInput } from './edo-effective-totals.js';

/** Сколько УПД читать из хранилища одновременно. */
export const EXPORT_EDO_READ_CONCURRENCY = 6;
/**
 * Общий срок на чтение УПД одной выгрузки. Каждая читается не дольше 15 с, но
 * сотня зависших чтений растянула бы выгрузку на минуты; после срока
 * оставшиеся УПД идут фактом с причиной.
 */
export const EXPORT_EDO_READ_BUDGET_MS = 90_000;

export function edoLinesKey(doc: Pick<EdoSummaryDocument, 'source' | 'documentId'>): string {
  return `${doc.source}:${doc.documentId}`;
}

const budgetExceeded = (): LinkedEdoItemsResult => ({
  state: 'storage_failed',
  totals: null,
  reasons: ['время выгрузки истекло'],
  items: [],
});

/**
 * Строки УПД, которые заменяют факт (`replacesFact`), — по одному чтению на
 * документ, даже если он стоит в нескольких приёмках выгрузки.
 */
export async function readEdoLinesForExport(
  db: Db,
  log: FastifyBaseLogger,
  documents: readonly EdoSummaryDocument[],
  opts: { concurrency?: number; budgetMs?: number } = {},
): Promise<Map<string, LinkedEdoItemsResult>> {
  const unique = new Map<string, EdoSummaryDocument>();
  for (const doc of documents) {
    if (doc.replacesFact) unique.set(edoLinesKey(doc), doc);
  }
  const result = new Map<string, LinkedEdoItemsResult>();
  if (unique.size === 0) return result;

  const exportIds = [...unique.values()]
    .filter((doc) => doc.source === 'export')
    .map((doc) => doc.documentId);
  const exportRows = exportIds.length
    ? await db
        .select({
          id: edoExportDocuments.id,
          status: edoExportDocuments.status,
          s3Key: edoExportDocuments.s3Key,
          sizeBytes: edoExportDocuments.sizeBytes,
        })
        .from(edoExportDocuments)
        .where(inArray(edoExportDocuments.id, exportIds))
    : [];
  const exportById = new Map(exportRows.map((row) => [row.id, row]));

  const limiter = createBoundedLimiter({
    concurrency: opts.concurrency ?? EXPORT_EDO_READ_CONCURRENCY,
    maxQueue: unique.size,
  });
  const startedAt = Date.now();
  const budgetMs = opts.budgetMs ?? EXPORT_EDO_READ_BUDGET_MS;

  await Promise.all(
    [...unique].map(([key, doc]) =>
      limiter(async () => {
        if (Date.now() - startedAt > budgetMs) {
          result.set(key, budgetExceeded());
          return;
        }
        try {
          if (doc.source === 'export') {
            const row = exportById.get(doc.documentId);
            result.set(
              key,
              row
                ? await readExportItems(row, { log })
                : { state: 'storage_failed', totals: null, reasons: [], items: [] },
            );
          } else {
            result.set(
              key,
              await readImportedItems(db, doc.documentId, {
                totalSum: doc.totalSum === null ? null : String(doc.totalSum),
                vatSum: doc.vatSum === null ? null : String(doc.vatSum),
              }),
            );
          }
        } catch (err) {
          log.warn({ err, documentId: doc.documentId }, 'export.xlsx: edo lines read failed');
          result.set(key, { state: 'storage_failed', totals: null, reasons: [], items: [] });
        }
      }),
    ),
  );
  return result;
}

/** Почему строк УПД нет — коротко, для колонки «Источник». */
export function edoLinesFailureText(result: LinkedEdoItemsResult | undefined): string {
  if (!result) return 'файл не прочитан';
  switch (result.state) {
    case 'storage_failed':
      return result.reasons[0] ?? 'файл не получен из хранилища';
    case 'parse_failed':
      return 'файл не разобрался';
    case 'too_large':
      return 'УПД слишком большая';
    case 'incomplete':
      return result.reasons.join('; ') || 'позиции не прочитаны';
    default:
      return 'файл не прочитан';
  }
}

export type ExportLine<T extends ItemMoneyInput> =
  | { kind: 'edo'; doc: EdoSummaryDocument; item: LinkedEdoItem }
  /** `note` — почему факт стоит на месте строк УПД; null — обычная строка факта. */
  | { kind: 'fact'; item: T; note: string | null }
  /** УПД без пары со сканом не прочиталась, а факта на её месте нет. */
  | { kind: 'edo_missing'; doc: EdoSummaryDocument; reason: string };

/**
 * Порядок строк под итогом: сначала УПД из ЭДО (в порядке привязки), затем
 * остаток факта в исходном порядке.
 */
export function planExportLines<T extends ItemMoneyInput>(
  summary: EdoSummary,
  items: readonly T[],
  lines: ReadonlyMap<string, LinkedEdoItemsResult>,
): ExportLine<T>[] {
  const out: ExportLine<T>[] = [];
  // Группа — документ скана и все его УПД; УПД без пары — сама по себе.
  const groups = new Map<string, EdoSummaryDocument[]>();
  for (const doc of summary.documents) {
    if (!doc.replacesFact) continue;
    const key = doc.pairedSourceDocumentId ?? `edo:${doc.matchId}`;
    groups.set(key, [...(groups.get(key) ?? []), doc]);
  }
  const replacedDocs = new Set(
    summary.documents
      .filter((doc) => doc.replacesFact && doc.pairedSourceDocumentId !== null)
      .map((doc) => doc.pairedSourceDocumentId!),
  );

  for (const docs of groups.values()) {
    const results = docs.map((doc) => lines.get(edoLinesKey(doc)));
    if (results.every((r) => r?.state === 'ready')) {
      docs.forEach((doc, i) => {
        for (const item of results[i]!.items) out.push({ kind: 'edo', doc, item });
      });
      continue;
    }
    // Хоть одна УПД группы не прочиталась — на её месте факт пары целиком:
    // половина строк из УПД и половина из факта не сложилась бы ни во что.
    const failedIndex = results.findIndex((r) => r?.state !== 'ready');
    const reason = edoLinesFailureText(results[failedIndex]);
    const pairedId = docs[0]!.pairedSourceDocumentId;
    const fact = pairedId ? items.filter((it) => it.sourceDocumentId === pairedId) : [];
    if (fact.length > 0) {
      for (const item of fact) {
        out.push({ kind: 'fact', item, note: `строки ЭДО не прочитаны: ${reason}` });
      }
    } else {
      out.push({ kind: 'edo_missing', doc: docs[failedIndex]!, reason });
    }
  }

  for (const item of items) {
    if (item.sourceDocumentId !== null && replacedDocs.has(item.sourceDocumentId)) continue;
    out.push({ kind: 'fact', item, note: null });
  }
  return out;
}
