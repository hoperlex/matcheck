/**
 * Убирает хвостовые нули в дробной части decimal-строки из API
 * (Drizzle отдаёт numeric как строку: "796.0000", "1.10", "22.00").
 * null/undefined → "" (пустая ячейка), нет точки → исходная строка.
 */
export function formatDecimal(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}
