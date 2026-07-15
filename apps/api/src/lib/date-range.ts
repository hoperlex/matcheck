import { gte, lt, lte, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { badRequest } from './http-error.js';

/** Только дата: 2026-07-11. Контракт /materials/journal (from/to без времени). */
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** ISO-8601 с временем и обязательной зоной: 2026-07-11T21:00:00.000Z, ...+05:00. */
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Парсит дату из query-параметра. Принимает YYYY-MM-DD и ISO-8601 с зоной —
 * контракт не сужаем: /materials/journal объявляет from/to как z.string(),
 * а deliveries/shipments шлют ISO.
 *
 * Одного `new Date(raw)` мало по двум причинам:
 *   1) JS глотает посторонние форматы ('12/31/2026', 'Mon Jul 13 2026') —
 *      отсекаем регексом;
 *   2) JS молча нормализует несуществующие даты ('2026-02-30' → 2 марта) —
 *      отсекаем round-trip'ом календарной части.
 * Иначе Invalid Date дошла бы до mapToDriverValue и упала RangeError → 500.
 */
export function parseDateParam(raw: string, field: string): Date {
  const m = DATE_ONLY_RE.exec(raw) ?? DATE_TIME_RE.exec(raw);
  if (!m) {
    throw badRequest(`Некорректная дата в параметре ${field}: ожидается YYYY-MM-DD или ISO-8601`);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw badRequest(`Некорректная дата в параметре ${field}: ${raw}`);
  }
  // Календарная валидность: 2026-02-30 разбирается регексом и даёт валидный
  // Date, но уже другого месяца. Сверяем компоненты через UTC-конструктор —
  // он не зависит от таймзоны сервера.
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw badRequest(`Несуществующая дата в параметре ${field}: ${raw}`);
  }
  return parsed;
}

/**
 * Условия диапазона по timestamp-колонке.
 *
 * ВАЖНО: только типизированные операторы (gte/lt/lte). Raw sql-шаблон
 * (drSql`${col} < ${date}`) НЕ применяет энкодер колонки — Date уходит
 * драйверу объектом и сериализуется как toString()
 * ('Mon Jul 13 2026 21:00:00 GMT+0000'), Postgres такое не парсит → 500.
 * Именно так фильтр по дате не работал с 7e46011.
 *
 * toInclusive: верхняя граница `<=` (журнал материалов) вместо `<`.
 * По умолчанию `<` — deliveries/shipments шлют начало следующего дня.
 */
export function dateRangeConditions(
  column: AnyPgColumn<{ data: Date }>,
  from: string | undefined,
  to: string | undefined,
  opts: { toInclusive?: boolean; fromField?: string; toField?: string } = {},
): SQL[] {
  const conditions: SQL[] = [];
  if (from) {
    conditions.push(gte(column, parseDateParam(from, opts.fromField ?? 'from')));
  }
  if (to) {
    const upper = parseDateParam(to, opts.toField ?? 'to');
    conditions.push(opts.toInclusive ? lte(column, upper) : lt(column, upper));
  }
  return conditions;
}
