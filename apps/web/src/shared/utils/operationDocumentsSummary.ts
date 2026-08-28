import type { OperationSourceDocument } from '@matcheck/contracts';
import { sourceKindLabel } from './sourceKindLabel';

/**
 * Шапка карточки операции по нескольким документам.
 *
 * Считается ТОЛЬКО по связанным документам (`linked`): позиции после отвязки
 * намеренно сохраняют происхождение, и если складывать всё упомянутое, кнопка
 * «Отвязать» выглядела бы не сработавшей — номер и сумма остались бы на месте.
 * Отбор делает вызывающий код, здесь работаем с тем, что дали.
 */

export type DocumentsOfKind = {
  /** «УПД» / «Накладная» / «Заявка» — подпись чипа. */
  kindLabel: string;
  documents: OperationSourceDocument[];
};

/** Группировка по виду документа с сохранением порядка первого появления. */
export function groupDocumentsByKind(documents: OperationSourceDocument[]): DocumentsOfKind[] {
  const groups: DocumentsOfKind[] = [];
  for (const doc of documents) {
    const kindLabel = sourceKindLabel(doc.kind);
    const group = groups.find((g) => g.kindLabel === kindLabel);
    if (group) group.documents.push(doc);
    else groups.push({ kindLabel, documents: [doc] });
  }
  return groups;
}

export type DateSummary = {
  /** Одна дата, если у всех совпала; иначе «раньшая — поздняя». */
  text: string;
  /** У скольких документов дата есть и сколько их всего — для честной подписи. */
  known: number;
  total: number;
};

/**
 * Сводка по дате. Отсутствующую дату НЕ подменяем соседней: если она есть не у
 * всех, вызывающий код дописывает «(у 3 из 4)» — молчаливое «у всех 26.08» было
 * бы выдумкой.
 */
export function summarizeDates(
  documents: OperationSourceDocument[],
  field: 'docDate' | 'expectedDate',
): DateSummary | null {
  const values = documents.map((d) => d[field]).filter((v): v is string => v !== null && v !== '');
  if (values.length === 0) return null;
  const sorted = [...values].sort();
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  return {
    text: first === last ? first : `${first} — ${last}`,
    known: values.length,
    total: documents.length,
  };
}

export type MoneySummary = {
  /** Сумма в рублях. Складывается в копейках — иначе миллионы копят хвосты. */
  total: number;
  known: number;
  count: number;
};

/** Сумма по документам. Отсутствующая сумма — не ноль: она просто неизвестна. */
export function sumDocumentTotals(documents: OperationSourceDocument[]): MoneySummary | null {
  let kopeks = 0;
  let known = 0;
  for (const doc of documents) {
    if (doc.totalSum === null || doc.totalSum === '') continue;
    const value = Number(doc.totalSum);
    if (!Number.isFinite(value)) continue;
    kopeks += Math.round(value * 100);
    known += 1;
  }
  if (known === 0) return null;
  return { total: kopeks / 100, known, count: documents.length };
}

/**
 * Короткая подпись документов для read-only просмотра операции.
 *
 * Один вид — ярлык отдельно, номера через запятую («УПД № 1, 2»). Виды разные —
 * ярлык не выносится, каждый номер идёт со своим («УПД 1, Накладная ТН-7»):
 * иначе накладная оказалась бы подписана как УПД.
 */
export function formatDocumentsShort(documents: OperationSourceDocument[]): {
  kindLabel: string | null;
  numbers: string | null;
} {
  if (documents.length === 0) return { kindLabel: null, numbers: null };
  const label = (doc: OperationSourceDocument): string => doc.docNumber ?? '— без номера —';
  const groups = groupDocumentsByKind(documents);
  if (groups.length === 1) {
    return {
      kindLabel: groups[0]!.kindLabel,
      numbers: groups[0]!.documents.map(label).join(', '),
    };
  }
  return {
    kindLabel: null,
    numbers: groups
      .flatMap((g) => g.documents.map((doc) => `${g.kindLabel} ${label(doc)}`))
      .join(', '),
  };
}
