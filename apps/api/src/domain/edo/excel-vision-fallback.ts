import type { UpdPdfParsed } from '@matcheck/contracts';
import { validateUpdTotals } from './upd-validation.js';

// Гибрид Excel→Vision (подшаг 1). Структурный парсер остаётся ОСНОВНЫМ путём;
// Vision — страховка для частичных/сомнительных результатов, и он лишь ДОБИРАЕТ
// пустые поля шапки, не затирая валидные структурные items/totals.
// Полный арбитраж items↔items — отдельный подшаг 2.

export type ExcelFallbackReason =
  | 'no_structural'
  | 'no_items'
  | 'low_confidence'
  | 'validation_mismatch'
  | 'vat_missing_with_rate'
  | 'no_doc_header_without_items';

const CONFIDENCE_THRESHOLD = 0.7;

/**
 * Сильные признаки, что структурный Excel-результат частичный/сомнительный и
 * стоит попробовать Vision-fallback.
 *
 * Намеренно НЕ триггерим на слабые одиночные сигналы, чтобы не гонять Vision
 * (libreoffice-рендер + токены) на рабочих файлах:
 *   - только пустой docNumber при нормальных позициях/суммах — НЕ повод;
 *   - одна позиция — норма;
 *   - пустой vatSum при vatRate==0 / «Без НДС» — норма.
 */
export function getExcelVisionFallbackReasons(
  structural: UpdPdfParsed | null,
): ExcelFallbackReason[] {
  if (structural == null) return ['no_structural'];

  const reasons: ExcelFallbackReason[] = [];
  if (structural.items.length === 0) reasons.push('no_items');
  if (structural.confidence < CONFIDENCE_THRESHOLD) reasons.push('low_confidence');

  // Суммы не сходятся. hasMismatch учитывает только реальные mismatch —
  // skip/no_expected/no_actual там помечены ok:true и не считаются ошибкой.
  if (validateUpdTotals(structural).hasMismatch) reasons.push('validation_mismatch');

  // НДС должен быть (есть ставка > 0 хотя бы в одной позиции), но шапочный
  // vatSum не извлёкся. Без признака ставки (vatRate==0/null) — не триггерим.
  if (structural.vatSum == null && structural.items.some((i) => (i.vatRate ?? 0) > 0)) {
    reasons.push('vat_missing_with_rate');
  }

  // Нет ни номера, ни даты И при этом нет позиций — документ-«пустышка».
  // Комбинация обязательна: пустой docNumber/docDate сам по себе (при нормальных
  // items) сюда не попадает.
  if (
    (structural.docNumber == null || structural.docDate == null) &&
    structural.items.length === 0
  ) {
    reasons.push('no_doc_header_without_items');
  }

  return reasons;
}

export function needsExcelVisionFallback(structural: UpdPdfParsed | null): boolean {
  return getExcelVisionFallbackReasons(structural).length > 0;
}

export type ExcelMergeResult = {
  result: UpdPdfParsed;
  mergedFields: string[];
  /** true — структурного по сути не было, взяли Vision целиком (как раньше). */
  tookVisionWhole: boolean;
};

/**
 * Аккуратный merge структурного результата с Vision-fallback.
 *
 * - Структурного нет / нет позиций / низкая уверенность → берём Vision целиком
 *   (поведение как до гибрида).
 * - Структурный валиден по позициям → Vision ДОБИРАЕТ только ПУСТЫЕ поля шапки
 *   (docNumber/docDate/vatSum/totalSum/supplier/recipient/itemsCount), а
 *   structural.items НЕ затираются. confidence не завышаем слепо.
 *
 * Полную замену items на Vision (когда структурные не проходят validation, а
 * Vision проходит) этот шаг НЕ делает — это подшаг 2 (validation-арбитраж).
 */
export function mergeExcelStructuralWithVision(
  structural: UpdPdfParsed | null,
  vision: UpdPdfParsed,
): ExcelMergeResult {
  if (
    structural == null ||
    structural.items.length === 0 ||
    structural.confidence < CONFIDENCE_THRESHOLD
  ) {
    return { result: vision, mergedFields: [], tookVisionWhole: true };
  }

  const mergedFields: string[] = [];
  function fill<T>(s: T | null | undefined, v: T | null | undefined, name: string): T | null {
    if (s != null) return s;
    if (v != null) {
      mergedFields.push(name);
      return v;
    }
    return s ?? null;
  }

  const result: UpdPdfParsed = {
    ...structural,
    docNumber: fill(structural.docNumber, vision.docNumber, 'docNumber'),
    docDate: fill(structural.docDate, vision.docDate, 'docDate'),
    vatSum: fill(structural.vatSum, vision.vatSum, 'vatSum'),
    totalSum: fill(structural.totalSum, vision.totalSum, 'totalSum'),
    itemsCount: fill(structural.itemsCount, vision.itemsCount, 'itemsCount'),
    supplier: fill(structural.supplier, vision.supplier, 'supplier'),
    recipient: fill(structural.recipient, vision.recipient, 'recipient'),
    // КЛЮЧЕВОЕ: структурные позиции не затираем.
    items: structural.items,
    // Не завышаем уверенность слепо: max(structural, min(vision, 0.9)).
    confidence: Math.max(structural.confidence, Math.min(vision.confidence, 0.9)),
  };

  return { result, mergedFields, tookVisionWhole: false };
}
