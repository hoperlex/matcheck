import { sql, type SQL } from 'drizzle-orm';
import { escapeLike } from './like.js';

/**
 * Поиск по номеру документа, нечувствительный к разделителям: «1029-01»,
 * «1029/01» и «1029 01» — один номер. Человек набирает его так, как видит на
 * бумаге, а распознавание и ЭДО пишут по-своему.
 *
 * Сырое вхождение подстроки остаётся первой веткой — всё, что находилось
 * раньше, находится и теперь; нормализованная ветка только добавляет.
 */

// Пробелы, «/», «.», «_», «\» и «-».
const SEPARATORS_JS = /[\s/._\\-]/g;
// Тот же набор для Postgres ARE. Внутри [] обратная косая экранируется, дефис —
// последним, чтобы не читался как диапазон. Значение уходит bind-параметром.
const SEPARATORS_PG = '[[:space:]/._\\\\-]';

export function normalizeDocNumber(input: string): string {
  return input.toLowerCase().replace(SEPARATORS_JS, '');
}

/** Условие «номер в колонке совпадает с запросом» — сырой ILIKE или без разделителей. */
export function docNumberMatchSql(column: SQL, query: string): SQL {
  const raw = `%${escapeLike(query.trim())}%`;
  const norm = normalizeDocNumber(query.trim());
  if (norm === '') return sql`(${column} ILIKE ${raw})`;
  return sql`(${column} ILIKE ${raw} OR regexp_replace(lower(${column}), ${SEPARATORS_PG}, '', 'g') LIKE ${`%${escapeLike(norm)}%`})`;
}
