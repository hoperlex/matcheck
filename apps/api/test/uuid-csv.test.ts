/**
 * Разбор csv-списков id: что именно считается идентификатором.
 *
 * Прежняя маска в выгрузке Excel проверяла только длину и набор символов —
 * строка из 36 дефисов проходила её насквозь и доезжала до Postgres. Список
 * документов не проверял вовсе ничего.
 */
import { describe, expect, it } from 'vitest';
import { parseUuidCsv } from '../src/lib/uuid-csv.js';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

describe('parseUuidCsv', () => {
  it('пустой ввод даёт пустой список', () => {
    expect(parseUuidCsv(undefined)).toEqual([]);
    expect(parseUuidCsv(null)).toEqual([]);
    expect(parseUuidCsv('')).toEqual([]);
    expect(parseUuidCsv(' , ,')).toEqual([]);
  });

  it('отбрасывает мусор', () => {
    expect(parseUuidCsv('abc')).toEqual([]);
    // 36 символов, но не UUID — прежняя маска пропускала.
    expect(parseUuidCsv('-'.repeat(36))).toEqual([]);
    expect(parseUuidCsv('1111111111111111111111111111111111111')).toEqual([]);
    expect(parseUuidCsv(`${A}extra`)).toEqual([]);
  });

  it('оставляет валидные и терпит пробелы', () => {
    expect(parseUuidCsv(`${A}, ${B}`)).toEqual([A, B]);
    expect(parseUuidCsv(A.toUpperCase())).toEqual([A.toUpperCase()]);
  });

  it('из смешанного списка берёт только валидные', () => {
    expect(parseUuidCsv(`${A},abc,${'-'.repeat(36)},${B}`)).toEqual([A, B]);
  });
});
