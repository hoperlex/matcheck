import { describe, it, expect } from 'vitest';
import { and } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { dateRangeConditions, parseDateParam } from '../src/lib/date-range.js';
import { deliveries } from '../src/db/schema.js';

const dialect = new PgDialect();

/** Компилирует условия в SQL+params, как это сделает драйвер. Без БД. */
function compile(conditions: ReturnType<typeof dateRangeConditions>) {
  return dialect.sqlToQuery(and(...conditions)!);
}

describe('dateRangeConditions', () => {
  it('отдаёт границы драйверу СТРОКАМИ, а не объектами Date', () => {
    // Регресс на баг из 7e46011: raw sql-шаблон `${col} < ${new Date(x)}`
    // не применял энкодер колонки, и Postgres получал
    // 'Mon Jul 13 2026 21:00:00 GMT+0000' вместо ISO → 500.
    const { params } = compile(
      dateRangeConditions(deliveries.arrivedAt, '2026-07-11T21:00:00.000Z', '2026-07-13T21:00:00.000Z'),
    );
    expect(params).toHaveLength(2);
    // Проверяем именно typeof: JSON.stringify(Date) тоже выглядит как ISO,
    // поэтому сравнение сериализованного значения пропустило бы Date-объект.
    for (const p of params) {
      expect(typeof p).toBe('string');
    }
    // timestamptz-колонка → энкодер отдаёт ISO. Раньше здесь было
    // 'Mon Jul 13 2026 21:00:00 GMT+0000 (Coordinated Universal Time)'.
    expect(params[0]).toBe('2026-07-11T21:00:00.000Z');
    expect(params[1]).toBe('2026-07-13T21:00:00.000Z');
  });

  it('верхняя граница строгая по умолчанию и нестрогая при toInclusive', () => {
    const strict = compile(dateRangeConditions(deliveries.arrivedAt, undefined, '2026-07-13'));
    expect(strict.sql).toContain('<');
    expect(strict.sql).not.toContain('<=');

    const inclusive = compile(
      dateRangeConditions(deliveries.arrivedAt, undefined, '2026-07-13', { toInclusive: true }),
    );
    expect(inclusive.sql).toContain('<=');
  });

  it('нижняя граница всегда включительная', () => {
    const { sql } = compile(dateRangeConditions(deliveries.arrivedAt, '2026-07-11', undefined));
    expect(sql).toContain('>=');
  });

  it('без границ не даёт условий', () => {
    expect(dateRangeConditions(deliveries.arrivedAt, undefined, undefined)).toEqual([]);
  });
});

describe('parseDateParam', () => {
  it('принимает YYYY-MM-DD — контракт /materials/journal не сужен', () => {
    expect(parseDateParam('2026-07-11', 'from').toISOString()).toBe('2026-07-11T00:00:00.000Z');
  });

  it('принимает ISO-8601 с зоной', () => {
    expect(parseDateParam('2026-07-11T21:00:00.000Z', 'from').toISOString()).toBe(
      '2026-07-11T21:00:00.000Z',
    );
    expect(parseDateParam('2026-07-11T00:00:00+05:00', 'from').toISOString()).toBe(
      '2026-07-10T19:00:00.000Z',
    );
  });

  it.each([
    ['мусор', 'произвольная строка'],
    ['2026-02-30', 'календарно невозможная дата — JS молча даёт 2 марта'],
    ['2026-13-01', 'несуществующий месяц'],
    ['12/31/2026', 'посторонний формат, который JS всё же понимает'],
    ['Mon Jul 13 2026 21:00:00 GMT+0000', 'ровно то, во что превращался Date в raw sql'],
  ])('отвергает %s (%s) с кодом 400', (raw) => {
    let caught: unknown;
    try {
      parseDateParam(raw, 'arrivedTo');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    // 400, а не падение с RangeError → 500.
    expect((caught as { statusCode?: number }).statusCode).toBe(400);
    expect((caught as Error).message).toContain('arrivedTo');
  });
});
