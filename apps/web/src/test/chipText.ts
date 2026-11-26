import type { MatcherFunction } from '@testing-library/react';

/**
 * Плашка шапки (HeaderChip / HeaderAddButton — класс `mc-chip`) по её полному
 * тексту. Подпись и значение плашки лежат в разных span'ах, а `getByText`
 * сравнивает только собственный текст узла — «Дата документа: 25.11.2026»
 * целиком он не найдёт.
 *
 * Пробелы нормализуются, как у `getByText` по умолчанию: деньги приходят из
 * Intl с неразрывными пробелами, а в тестах пишутся обычными.
 */
export function chipText(expected: string | RegExp): MatcherFunction {
  return (_content, element) => {
    if (!element?.classList.contains('mc-chip')) return false;
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    return typeof expected === 'string' ? text === expected : expected.test(text);
  };
}
