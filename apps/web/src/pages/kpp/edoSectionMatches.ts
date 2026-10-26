import type { OperationSourceDocument } from '@matcheck/contracts';
import type { LinkedEdoDocument } from './LinkedEdoChips';

/**
 * Куда в карточке приёмки встаёт привязанная УПД из ЭДО: в блок материалов
 * бумажного документа или отдельно. Две функции — ровно дополнение друг друга:
 * каждая привязка попадает ровно в одно место.
 *
 * В блок — только если документ связан с приёмкой СЕЙЧАС. После отвязки
 * бумажной УПД сервер обнуляет блок у привязки, но список привязок в карточке
 * может быть ещё старым, а блок отвязанного документа — ещё виден (на него
 * ссылаются строки). Без проверки `linked` УПД показалась бы дважды.
 */
export function edoMatchesForSection(
  document: OperationSourceDocument | null,
  matches: readonly LinkedEdoDocument[],
): LinkedEdoDocument[] {
  if (!document?.linked) return [];
  return matches.filter((m) => m.sectionDocumentId === document.id);
}

/** Привязки к приёмке целиком и к блокам документов, которые сейчас не связаны. */
export function edoMatchesWithoutSection(
  matches: readonly LinkedEdoDocument[],
  documents: readonly OperationSourceDocument[],
): LinkedEdoDocument[] {
  const linked = new Set(documents.filter((d) => d.linked).map((d) => d.id));
  return matches.filter((m) => !m.sectionDocumentId || !linked.has(m.sectionDocumentId));
}
