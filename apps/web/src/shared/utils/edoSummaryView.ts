import type { EdoSummary, OperationSourceDocument } from '@matcheck/contracts';
import { formatMoneyRu } from './formatRu';

/**
 * Подписи по `edoSummary` приёмки — номер, дата и суммы по УПД из ЭДО/СБИС
 * (правило на сервере: domain/operations/edo-effective-totals.ts). Одни и те же
 * в шапке карточки, окне просмотра и колонках списка.
 */

/** «на 2 приёмки», «на 5 приёмок», «на 21 приёмку». */
export function deliveriesAccusative(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'приёмку';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'приёмки';
  return 'приёмок';
}

/** «УПД на 3 приёмки» — у общей УПД сумма полная в каждой приёмке. */
export function sharedEdoText(summary: EdoSummary): string | null {
  return summary.sharedMax > 1
    ? `УПД на ${summary.sharedMax} ${deliveriesAccusative(summary.sharedMax)}`
    : null;
}

/** Связанные документы скана без пары в ЭДО — в шапке они остаются как есть. */
export function unpairedScanDocuments(
  summary: EdoSummary,
  linked: readonly OperationSourceDocument[],
): OperationSourceDocument[] {
  const ids = new Set(summary.unpairedLinkedDocumentIds);
  return linked.filter((doc) => ids.has(doc.id));
}

/** Даты для «Дата документа»: УПД из ЭДО и документы скана без пары. */
export function edoDateSources(
  summary: EdoSummary,
  linked: readonly OperationSourceDocument[],
): Pick<OperationSourceDocument, 'docDate' | 'expectedDate'>[] {
  return [
    ...summary.documents.map((doc) => ({ docDate: doc.docDate, expectedDate: null })),
    ...unpairedScanDocuments(summary, linked),
  ];
}

/** Номера для окна просмотра и выгрузки: УПД из ЭДО, затем сканы без пары. */
export function edoNumbersText(
  summary: EdoSummary,
  linked: readonly OperationSourceDocument[],
): string {
  return [
    ...summary.documents.map((doc) => doc.docNumber ?? 'без номера'),
    ...unpairedScanDocuments(summary, linked).map((doc) => doc.docNumber ?? 'без номера'),
  ].join(', ');
}

/** Подпись суммы шапки: целиком по ЭДО или вместе со сканом без пары. */
export function edoHeaderSumLabel(summary: EdoSummary): string {
  return summary.header.source === 'edo' ? 'Сумма по ЭДО' : 'Сумма по документам';
}

/** Подсказка к сумме шапки — откуда цифра и о чём предупредить. */
export function edoHeaderSumHint(summary: EdoSummary): string {
  const parts = [
    summary.header.source === 'edo'
      ? 'Итог по УПД из ЭДО.'
      : 'Итог по УПД из ЭДО и документам, у которых пары в ЭДО нет (по скану).',
  ];
  const shared = sharedEdoText(summary);
  if (shared) parts.push(`${shared}: в каждой из них сумма УПД полная.`);
  if (summary.ambiguous) {
    parts.push(
      'Не все УПД из ЭДО сопоставлены со сканами — один документ мог попасть в сумму дважды. ' +
        'Привяжите УПД к блоку документа кнопкой «+ ЭДО».',
    );
  }
  return parts.join(' ');
}

/** Пометка расхождения со сканом: «по скану 156 336,00 ₽» или null. */
export function edoScanMismatch(summary: EdoSummary): { text: string; hint: string } | null {
  const cmp = summary.header.comparison;
  if (!cmp?.mismatch) return null;
  return {
    text: `по скану ${formatMoneyRu(cmp.scan)}`,
    hint: `Итог со скана расходится с УПД из ЭДО: ЭДО ${formatMoneyRu(cmp.edo)}, скан ${formatMoneyRu(cmp.scan)}.`,
  };
}

/** Метка источника у сумм списка; null — сумма по факту, как раньше. */
export function edoListSourceLabel(summary: EdoSummary | undefined): string | null {
  if (!summary) return null;
  if (summary.list.source === 'edo') return 'ЭДО';
  if (summary.list.source === 'mixed') return 'ЭДО + факт';
  return null;
}

/** Подсказка к суммам списка: разложение и факт приёмки рядом. */
export function edoListHint(
  summary: EdoSummary,
  fact: { exVat: number | null; vat: number | null },
): string {
  const { list } = summary;
  const lines: string[] = [];
  if (list.source === 'mixed') {
    lines.push(
      `ЭДО: без НДС ${formatMoneyRu(list.edoExVat)} · НДС ${formatMoneyRu(list.edoVat)}; ` +
        `факт строк вне УПД: без НДС ${formatMoneyRu(list.factExVat)} · НДС ${formatMoneyRu(list.factVat)}.`,
    );
  } else {
    lines.push('Суммы по УПД из ЭДО.');
  }
  lines.push(
    `Факт приёмки: без НДС ${formatMoneyRu(fact.exVat)} · НДС ${formatMoneyRu(fact.vat)}.`,
  );
  if (list.edoMissing > 0) lines.push(`У ${list.edoMissing} УПД нет суммы — их строки по факту.`);
  const shared = sharedEdoText(summary);
  if (shared) lines.push(`${shared}: сумма УПД полная в каждой.`);
  return lines.join(' ');
}

/** Суммы колонок списка: по ЭДО, если она заменила факт, иначе как раньше. */
export function listSums(
  summary: EdoSummary | undefined,
  fact: { exVat: number | null; vat: number | null },
): { exVat: number | null; vat: number | null } {
  if (!summary || summary.list.source === 'fact') return fact;
  return { exVat: summary.list.exVat, vat: summary.list.vat };
}
