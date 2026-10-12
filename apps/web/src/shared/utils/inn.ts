/**
 * ИНН организации или ИП: нормализация и проверка контрольных цифр.
 *
 * Копия серверного алгоритма (apps/api/src/domain/sourceDocuments/
 * resolve-contractor.ts → normalizeInn / isValidInnChecksum). Сервер проверяет
 * ИНН сторон документа сам и отвечает 400 на битый — здесь та же проверка
 * нужна, чтобы подсветить поле до отправки, а не после. Разойтись копиям
 * нельзя: тест на обе стороны держит одни и те же контрольные значения.
 *
 * Контрольные цифры — не формальность: распознавание переставляет цифры на
 * плохих сканах (7736255088 вместо 7736255508), а справочник хранит ИНН
 * свободным текстом, с пробелами и дефисами.
 */

/** Цифры ИНН, если их 10 или 12 и контрольные сходятся; иначе null. */
export function normalizeInn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 10 && digits.length !== 12) return null;
  return isValidInnChecksum(digits) ? digits : null;
}

/** Контрольные цифры ИНН по алгоритму ФНС: одна для 10 знаков, две для 12. */
export function isValidInnChecksum(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  const d = [...digits].map(Number);
  const check = (weights: readonly number[], at: number) =>
    (weights.reduce((acc, w, i) => acc + w * d[i]!, 0) % 11) % 10 === d[at];
  if (d.length === 10) return check([2, 4, 10, 3, 5, 9, 4, 6, 8], 9);
  if (d.length === 12) {
    return (
      check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 10) && check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 11)
    );
  }
  return false;
}
