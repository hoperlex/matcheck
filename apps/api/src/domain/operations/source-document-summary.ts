/**
 * Сводка по документам операции (приёмки/отгрузки) для карточки.
 *
 * Документов у операции бывает несколько (связь многие-ко-многим, UNIQUE снят
 * миграцией 0063), и они делятся на два набора, которые нельзя смешивать:
 *
 *  - СВЯЗАННЫЕ — те, что сейчас в delivery_sources / shipment_sources. По ним
 *    карточка строит шапку: номера, даты, сумму, кнопку «Отвязать»;
 *  - УПОМЯНУТЫЕ — связанные плюс те, что остались в происхождении позиций
 *    (`*_items.source_document_id`) после отвязки. По ним строятся блоки
 *    материалов: отвязка позиции не удаляет и происхождение не обнуляет, и
 *    строки обязаны остаться под подписью своего документа.
 *
 * Если бы шапка считалась по упомянутым, «Отвязать» выглядело бы не
 * сработавшим: номер и сумма остались бы на месте.
 */

import type { OperationSourceDocument } from '@matcheck/contracts';
import { sourceDocuments } from '../../db/schema.js';

export type SourceDocumentSummaryRow = {
  id: string;
  kind: OperationSourceDocument['kind'];
  status: OperationSourceDocument['status'];
  docNumber: string | null;
  docDate: Date | string | null;
  expectedDate: Date | string | null;
  totalSum: string | null;
  vatSum: string | null;
};

/**
 * Колонки выборки сводки — один набор на оба маршрута и на оба пути DTO
 * (одиночный и батч), чтобы форма ответа не разъехалась.
 */
export const SOURCE_DOCUMENT_SUMMARY_COLUMNS = {
  id: sourceDocuments.id,
  kind: sourceDocuments.kind,
  status: sourceDocuments.status,
  docNumber: sourceDocuments.docNumber,
  docDate: sourceDocuments.docDate,
  expectedDate: sourceDocuments.expectedDate,
  totalSum: sourceDocuments.totalSum,
  vatSum: sourceDocuments.vatSum,
} as const;

/** YYYY-MM-DD — ровно как в GET /source-documents: карточка печатает как есть. */
function dateOnly(value: Date | string | null): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

/**
 * @param rows строки source_documents по всем упомянутым документам (порядок не важен)
 * @param linkedIds документы, привязанные к операции, В ПОРЯДКЕ sourceDocumentIds —
 *   он же порядок первых элементов результата, поэтому sourceDocuments[0]
 *   совпадает с primarySourceDocument
 * @param mentionedIds все упомянутые документы (связанные ∪ происхождение позиций)
 */
export function buildOperationSourceDocuments(args: {
  rows: readonly SourceDocumentSummaryRow[];
  linkedIds: readonly string[];
  mentionedIds: readonly string[];
}): OperationSourceDocument[] {
  const { rows, linkedIds, mentionedIds } = args;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const linked = new Set(linkedIds);

  const toSummary = (row: SourceDocumentSummaryRow): OperationSourceDocument => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    docNumber: row.docNumber,
    docDate: dateOnly(row.docDate),
    expectedDate: dateOnly(row.expectedDate),
    totalSum: row.totalSum,
    vatSum: row.vatSum,
    linked: linked.has(row.id),
  });

  const head: OperationSourceDocument[] = [];
  for (const id of linkedIds) {
    const row = byId.get(id);
    if (row) head.push(toSummary(row));
  }

  // Отвязанные — после связанных, в человеческом порядке: он больше ничем не
  // задан (в sourceDocumentIds их нет), а строки блока должны идти стабильно.
  const rest = mentionedIds
    .filter((id) => !linked.has(id))
    .map((id) => byId.get(id))
    .filter((row): row is SourceDocumentSummaryRow => row !== undefined)
    .map(toSummary)
    .sort((a, b) => {
      if (a.docDate !== b.docDate) {
        if (a.docDate === null) return 1;
        if (b.docDate === null) return -1;
        return a.docDate < b.docDate ? -1 : 1;
      }
      const an = a.docNumber ?? '';
      const bn = b.docNumber ?? '';
      if (an !== bn) return an < bn ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });

  return [...head, ...rest];
}
