/**
 * Подсветка строк в Операциях → Принятые: «в процессе сегодня» (жёлтый)
 * vs «незавершено со вчера и раньше» (красный). Логика зеркалит
 * серверный endpoint /reports/operations-counters: в работе = status
 * filled (приёмка) или shipped (отгрузка) и не подтверждено МОЛ.
 * Граница «сегодня / вчера» — по МСК (Europe/Moscow).
 */

export const ROW_CLASS_PROGRESS_TODAY = 'matcheck-row-progress-today';
export const ROW_CLASS_OVERDUE = 'matcheck-row-overdue';

// Форматируем дату в МСК как 'YYYY-MM-DD'. Используем 'sv-SE' — её
// формат совпадает с ISO-датой.
function mscDateString(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(d);
}

export function todayMscDateString(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
}

/**
 * Класс строки для приёмки или отгрузки в журнале «Принятые».
 *  - statusCode = 'filled' | 'shipped' (в работе, без МОЛ);
 *  - dateIso = arrivedAt (приёмка) или shippedAt (отгрузка);
 * Иначе — пустая строка (без подсветки).
 *
 * NULL-dateIso → 'overdue' (запись без даты — точно не сегодняшняя).
 */
export function operationsRowClass(args: {
  statusCode: string;
  dateIso: string | null;
}): string {
  const inProgress = args.statusCode === 'filled' || args.statusCode === 'shipped';
  if (!inProgress) return '';
  const date = mscDateString(args.dateIso);
  if (date === null) return ROW_CLASS_OVERDUE;
  const today = todayMscDateString();
  if (date === today) return ROW_CLASS_PROGRESS_TODAY;
  if (date < today) return ROW_CLASS_OVERDUE;
  return '';
}
