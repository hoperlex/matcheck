/**
 * Подписи и сводки пробного разбора ЭДО.
 *
 * Вынесены из вёрстки, чтобы их можно было проверить тестом: итог отбора —
 * главное, что администратор читает в отчёте, и опечатка в арифметике здесь
 * читалась бы как «потеряли документы».
 */
import type { EdoDryRunReport } from '@matcheck/contracts';

/** ПрТовРаб: предмет позиции УПД. */
const ITEM_KIND_LABELS: Record<number, string> = {
  1: 'имущество',
  2: 'работа',
  3: 'услуга',
  4: 'права',
  5: 'иное',
};

export function itemKindLabel(kind: number | null): string {
  return kind === null ? 'признак не указан' : (ITEM_KIND_LABELS[kind] ?? `код ${kind}`);
}

/**
 * «Скачано 7 УПД: 3 — материалы, 4 — работы или услуги».
 *
 * Считается по отчёту, а не по «найдено»: найденные сверх предела не
 * скачивались, и про их содержимое сказать нечего.
 */
export function contentSummary(report: EdoDryRunReport): string {
  const total = report.selection.byContent.reduce((n, c) => n + c.count, 0);
  if (total === 0) return 'УПД не скачивались';
  const parts = report.selection.byContent.map((c) => `${c.count} — ${c.label}`);
  return `Скачано УПД: ${total}. ${parts.join(', ')}`;
}

/** Сколько документов прошли бы в карточки. */
export function acceptedCount(report: EdoDryRunReport): number {
  return report.documents.filter((d) => d.accepted).length;
}

export type ContentTone = 'green' | 'orange' | 'default' | 'red';

/** Цвет метки категории: материалы — зелёный, «не определено» — жёлтый, сбой — красный. */
export function contentTone(category: string | null): ContentTone {
  if (category === 'materials') return 'green';
  if (category === 'undetermined') return 'orange';
  if (category === null) return 'red';
  return 'default';
}
