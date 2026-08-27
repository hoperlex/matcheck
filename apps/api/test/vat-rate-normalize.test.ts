/**
 * Тесты на приведение построчного НДС к ставке документа.
 *
 * Числа боевые. Счёт № 223379 (ООО «САТУРН ЦЕНТР», 25.08.2026): итог 57 809,97,
 * в том числе НДС 10 424,75 — это ровно 22 % от базы 47 385,22. Построчного НДС
 * в бланке нет вовсе, и модель насчитала его сама по ставке 20 %: по первой
 * строке 5 301,90 − 5 301,90 / 1,2 = 883,65. Сумма таких строк дала 9 634,99 —
 * на 790 ₽ меньше, чем напечатано в шапке.
 */
import { describe, it, expect } from 'vitest';
import type { UpdPdfParsed } from '@matcheck/contracts';
import {
  headerVatRate,
  normalizeLineVatAgainstHeader,
} from '../src/domain/edo/vat-rate-normalize.js';

/** Строки счёта № 223379: [сумма с налогом, НДС по 20 % от модели]. */
const ROWS_223379: Array<[number, number]> = [
  [5301.9, 883.65],
  [10541, 1756.83],
  [32520.9, 5420.15],
  [4015.95, 669.33],
  [222.88, 37.15],
  [435.5, 72.58],
  [634.32, 105.72],
  [517.52, 86.25],
  [3620, 603.33],
];

function doc(over: Partial<UpdPdfParsed> = {}): UpdPdfParsed {
  return {
    docNumber: '223379',
    docDate: '2026-08-25',
    totalSum: 57809.97,
    vatSum: 10424.75,
    itemsCount: 9,
    confidence: 0.9,
    supplier: { inn: '9717052425', kpp: '771501001', name: 'ООО «САТУРН ЦЕНТР»' },
    recipient: { inn: '7725294304', kpp: null, name: 'ООО «СК ЛОЯЛ»' },
    consignee: null,
    items: ROWS_223379.map(([sum, vatSum], idx) => ({
      rowNo: idx + 1,
      nameRaw: `позиция ${idx + 1}`,
      qty: 1,
      unit: 'шт',
      price: sum,
      sum,
      vatRate: 20,
      vatSum,
      volumeM3: null,
      massKg: null,
      volumeConfidence: null,
      groupName: null,
    })),
    ...over,
  } as UpdPdfParsed;
}

describe('headerVatRate — ставка документа по шапке', () => {
  it('узнаёт 22 % на боевом счёте № 223379', () => {
    expect(headerVatRate(57809.97, 10424.75)).toBe(22);
  });

  it('узнаёт 20 % на документе прошлых лет', () => {
    // 120 000 с налогом при ставке 20: база 100 000, налог 20 000.
    expect(headerVatRate(120000, 20000)).toBe(20);
  });

  it('не выдумывает ставку из испорченной шапки', () => {
    // 15,3 % не бывает — значит шапка прочитана неверно, и опираться на неё
    // нельзя: приведение строк к выдуманной ставке хуже, чем бездействие.
    expect(headerVatRate(115300, 15300)).toBeNull();
    expect(headerVatRate(100, 500)).toBeNull();
    expect(headerVatRate(100, 100)).toBeNull();
  });

  it('без НДС и без шапки ставки нет', () => {
    expect(headerVatRate(1000, 0)).toBeNull();
    expect(headerVatRate(null, 200)).toBeNull();
    expect(headerVatRate(1000, null)).toBeNull();
  });
});

describe('normalizeLineVatAgainstHeader — построчный НДС против шапки', () => {
  it('БОЕВОЙ СЛУЧАЙ: ставка 20 у строк против 22 в шапке — строки пересчитаны', () => {
    const before = doc();
    const lineVatBefore = before.items.reduce((a, i) => a + (i.vatSum ?? 0), 0);
    // Исходно построчный налог не сходится с шапкой на ~790 ₽.
    expect(Math.abs(lineVatBefore - 10424.75)).toBeGreaterThan(700);

    const after = normalizeLineVatAgainstHeader(before);

    expect(after.items.every((i) => i.vatRate === 22)).toBe(true);
    // 5301,90 / 1,22 = 4345,82 — база строки; налог 5301,90 − 4345,82 = 956,08.
    expect(after.items[0]!.vatSum).toBe(956.08);
    // И теперь сумма построчного налога сходится с шапкой.
    const lineVatAfter = after.items.reduce((a, i) => a + (i.vatSum ?? 0), 0);
    expect(Math.abs(lineVatAfter - 10424.75)).toBeLessThan(1);
  });

  it('вход не мутируется', () => {
    // Правка идёт по копии: исходный разбор используется дальше в отчётах и
    // сравнениях, и тихая мутация ломала бы их незаметно.
    const before = doc();
    normalizeLineVatAgainstHeader(before);
    expect(before.items[0]!.vatRate).toBe(20);
    expect(before.items[0]!.vatSum).toBe(883.65);
  });

  it('ставка строк совпадает с шапкой — документ не трогаем', () => {
    const ok = doc({
      items: doc().items.map((i) => ({ ...i, vatRate: 22, vatSum: round2((i.sum ?? 0) / 6.1) })),
    });
    expect(normalizeLineVatAgainstHeader(ok)).toBe(ok);
  });

  it('СМЕШАННЫЕ ставки не трогаем: там расхождение с шапкой законно', () => {
    // Документ с частью строк по 22 % и частью по 10 % даёт эффективную ставку
    // шапки где-то посередине, и приведение всех строк к ней исказило бы налог.
    const mixed = doc();
    mixed.items[0]!.vatRate = 10;
    expect(normalizeLineVatAgainstHeader(mixed)).toBe(mixed);
  });

  it('пустая ставка хотя бы у одной строки — не трогаем', () => {
    // Возможно, там «Без НДС»: приводить такую строку к ставке шапки нельзя.
    const partial = doc();
    partial.items[3]!.vatRate = null;
    expect(normalizeLineVatAgainstHeader(partial)).toBe(partial);
  });

  it('суммы налога сходятся с шапкой — расхождение только в записи ставки', () => {
    // Строки помечены ставкой 20, но сам налог посчитан верно по 22 %. Трогать
    // суммы нельзя: они уже правильные, а спор о числе в графе 7 того не стоит.
    const sane = doc({
      items: doc().items.map((i) => ({
        ...i,
        vatRate: 20,
        vatSum: round2((i.sum ?? 0) - (i.sum ?? 0) / 1.22),
      })),
    });
    expect(normalizeLineVatAgainstHeader(sane)).toBe(sane);
  });

  it('шапка без НДС — правило спит', () => {
    expect(normalizeLineVatAgainstHeader(doc({ vatSum: 0 }))).toEqual(doc({ vatSum: 0 }));
    expect(normalizeLineVatAgainstHeader(doc({ vatSum: null }))).toEqual(doc({ vatSum: null }));
  });

  it('документ без позиций возвращается как есть', () => {
    const empty = doc({ items: [] });
    expect(normalizeLineVatAgainstHeader(empty)).toBe(empty);
  });

  it('строка без суммы — документ не сходится с итогом, правило спит', () => {
    // Потерянная сумма означает, что разбор неполон. Чему верить — шапке или
    // строкам — неизвестно, и выравнивать такой документ эвристикой нельзя.
    const noSum = doc();
    noSum.items[2] = { ...noSum.items[2]!, sum: null };
    expect(normalizeLineVatAgainstHeader(noSum)).toBe(noSum);
  });

  it('ШАПКА НИЖЕ СТРОК — не трогаем: чиним только занижение', () => {
    // Боевой № 852: шапка дала 20,47 %, строки 22 %. Здесь неверна как раз
    // шапка, и приведение строк к ней испортило бы правильные данные.
    // 122 000 при ставке 20,47 % → налог ≈ 20 726.
    const inverted = doc({
      totalSum: 122000,
      vatSum: 20726,
      items: doc().items.map((i, idx) => ({
        ...i,
        vatRate: 22,
        sum: idx === 0 ? 122000 : 0,
        vatSum: idx === 0 ? 22000 : 0,
      })),
    });
    expect(normalizeLineVatAgainstHeader(inverted)).toBe(inverted);
  });

  it('ЛЬГОТНАЯ ставка из битой шапки не принимается', () => {
    // Боевой № 45: шапка дала 5,53 %, строки 22 %. Ставка 5 % существует (УСН),
    // и без запрета правило приклеило бы шапку к ней, занизив налог вчетверо.
    const broken = doc({
      totalSum: 100000,
      vatSum: 5240, // 5240 / 94760 = 5,53 %
      items: doc().items.map((i, idx) => ({
        ...i,
        vatRate: 22,
        sum: idx === 0 ? 100000 : 0,
        vatSum: idx === 0 ? 18033 : 0,
      })),
    });
    expect(normalizeLineVatAgainstHeader(broken)).toBe(broken);
  });

  it('суммы строк не сходятся с итогом — документ разбирает человек', () => {
    // Разбор неполон целиком: неизвестно, чему верить.
    const torn = doc({ totalSum: 99999.99 });
    expect(normalizeLineVatAgainstHeader(torn)).toBe(torn);
  });
});

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
