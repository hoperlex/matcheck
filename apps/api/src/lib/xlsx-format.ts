/**
 * Форматирование значений для xlsx-выгрузок.
 *
 * Общее место для приёмок и отгрузок: экспорты обязаны выглядеть одинаково,
 * а раньше форматтер даты жил внутри одного из них и второй выгрузке был
 * недоступен.
 */

/** Числовые форматы Excel — деньги и количества. */
export const MONEY_FMT = '# ##0.00 "₽"';
export const QTY_FMT = '# ##0.####';

/**
 * «20.08.2026 14:35» из Date или ISO-строки; пусто — если даты нет.
 *
 * Время берётся по UTC намеренно: приёмки и отгрузки хранят момент в
 * timestamptz, а выгрузка читается в Москве, где смещение фиксировано и
 * совпадает с тем, что показывает портал.
 */
export function fmtDateTimeRu(d: Date | string | null): string {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = date.getUTCFullYear();
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
}

/** Число из строкового decimal БД; null — если пусто или не число. */
export function numOrNull(v: string | number | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
