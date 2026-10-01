import { normalizeInn } from './resolve-contractor.js';
import type { ParsedSupplier } from './supplierMatcher.js';

export type PartyResolutionMode = 'off' | 'shadow' | 'on';

export type RecognizedSupplierDecision = {
  /** Что передать legacy-сопоставлению. null означает: справочник не трогать. */
  supplier: ParsedSupplier | null;
  /** Наблюдение для shadow/on; в off всегда null. */
  reason: 'invalid_inn' | null;
  /** Истинно только когда режим on реально заблокировал запись/поиск. */
  blocked: boolean;
};

/**
 * Граница между недоверенным ответом модели и справочником поставщиков.
 *
 * Пустой ИНН намеренно сохраняет legacy-поведение: часть документов печатает
 * только название, и резкое отключение fuzzy-поиска изменило бы уже работающий
 * поток. Валидный ИНН в режиме on нормализуется к цифрам, чтобы форматирование
 * `77 25-...` не создавало дубль. Если непустой ИНН не проходит длину и
 * контрольную сумму, автоматически выбирать или создавать поставщика нельзя.
 *
 * `off` возвращает тот же объект — это строгий no-op для аварийного отката.
 * `shadow` тоже оставляет данные без изменений, но даёт вызывающему причину
 * для лога. Поэтому выкладка с дефолтом off не меняет ни одного документа.
 */
export function decideRecognizedSupplier(
  supplier: ParsedSupplier,
  mode: PartyResolutionMode,
): RecognizedSupplierDecision {
  if (mode === 'off') return { supplier, reason: null, blocked: false };

  const rawInn = supplier.inn?.trim() ?? '';
  if (!rawInn) return { supplier, reason: null, blocked: false };

  const normalizedInn = normalizeInn(rawInn);
  if (!normalizedInn) {
    return {
      supplier: mode === 'on' ? null : supplier,
      reason: 'invalid_inn',
      blocked: mode === 'on',
    };
  }

  return {
    supplier: mode === 'on' ? { ...supplier, inn: normalizedInn } : supplier,
    reason: null,
    blocked: false,
  };
}
