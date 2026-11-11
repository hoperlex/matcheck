/**
 * Десятичная арифметика выгрузки в 1С: округление half-up от нуля (как ROUND в
 * Postgres), без float на любых масштабах.
 */
import { describe, expect, it } from 'vitest';
import { add, format, mul, parseDec, round, shift } from '../src/domain/onec/money.js';
import { vatMismatch, vatRateKind } from '../src/domain/onec/vat.js';

const d = (s: string) => parseDec(s)!;

describe('parseDec', () => {
  it('разбирает numeric-строки Postgres и отвергает мусор', () => {
    expect(parseDec('123.4500')).toEqual({ v: 1234500n, s: 4 });
    expect(parseDec('-0.5')).toEqual({ v: -5n, s: 1 });
    expect(parseDec('7')).toEqual({ v: 7n, s: 0 });
    expect(parseDec(null)).toBeNull();
    expect(parseDec('')).toBeNull();
    expect(parseDec('1e5')).toBeNull();
    expect(parseDec('12,5')).toBeNull();
  });
});

describe('round / format', () => {
  it('half-up от нуля, как ROUND(numeric) в Postgres', () => {
    expect(format(d('0.125'), 2)).toBe('0.13');
    expect(format(d('0.124999'), 2)).toBe('0.12');
    expect(format(d('-0.125'), 2)).toBe('-0.13');
    expect(format(d('2.5'), 0)).toBe('3');
    expect(format(d('5'), 2)).toBe('5.00');
    expect(format(d('0.004'), 2)).toBe('0.00');
  });

  it('qty × price на восьми знаках не теряет копейку (float тут ошибается)', () => {
    // 1.005 × 1 в float = 1.00499999… → toFixed(2) даёт 1.00; Postgres — 1.01.
    expect(format(round(mul(d('1.0050'), d('1.0000')), 2), 2)).toBe('1.01');
    expect(format(round(mul(d('3.3330'), d('3.0000')), 2), 2)).toBe('10.00');
    expect(format(round(mul(d('1234567.1234'), d('98765.4321')), 2), 2)).toBe('121932555399.06');
  });

  it('цена с НДС: price × (100 + ставка) / 100 до 4 знаков', () => {
    const p = shift(mul(d('65.4918'), add({ v: 100n, s: 0 }, d('20.00'))), 2);
    expect(format(p, 4)).toBe('78.5902');
  });
});

describe('vatRateKind', () => {
  it('ноль — «0% или Без НДС», пусто — «неизвестно», отрицательное — мусор', () => {
    expect(vatRateKind('20.00')).toBe('percent');
    expect(vatRateKind('0.00')).toBe('zero_or_exempt');
    expect(vatRateKind(null)).toBe('unknown');
    expect(vatRateKind('-20')).toBe('unknown');
  });
});

describe('vatMismatch — допуск max(1 ₽, 0,1% суммы), как у построчной сверки портала', () => {
  it('копеечное расхождение от округления цены — не расхождение', () => {
    // 1000 × 65.49 = 65 490.00; НДС от неокруглённой цены 65.4918 — 13 098.36.
    expect(vatMismatch(d('65490.00'), d('20'), d('13098.36'))).toBe(false);
  });

  it('НДС по другой ставке — расхождение', () => {
    expect(vatMismatch(d('65490.00'), d('20'), d('6549.00'))).toBe(true);
  });

  it('на маленькой сумме допуск — рубль', () => {
    expect(vatMismatch(d('10.00'), d('20'), d('2.90'))).toBe(false);
    expect(vatMismatch(d('10.00'), d('20'), d('3.10'))).toBe(true);
  });
});
