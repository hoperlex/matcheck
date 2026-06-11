import { describe, it, expect } from 'vitest';
import {
  normalizeSupplierName,
  levenshteinDistance,
  nameSimilarity,
} from '../src/domain/sourceDocuments/supplierMatcher.js';

describe('supplierMatcher — нормализация имени', () => {
  it('toLowerCase + ё→е', () => {
    expect(normalizeSupplierName('ООО «Ёлка»')).toBe('ооо елка');
  });

  it('сворачивает все виды кавычек', () => {
    expect(normalizeSupplierName('ООО "ТД "ТУЛА-СТАЛЬ"')).toBe('ооо тд тула сталь');
    expect(normalizeSupplierName('АО «Северсталь»')).toBe('ао северсталь');
    expect(normalizeSupplierName('ООО “Стройдеталь”')).toBe('ооо стройдеталь');
  });

  it('сворачивает дефисы / точки / запятые / нижние подчёркивания', () => {
    expect(normalizeSupplierName('ООО НПО.ПУЛЬС-Завод_1')).toBe('ооо нпо пульс завод 1');
  });

  it('не удаляет организационно-правовую форму (ООО vs АО — разные)', () => {
    const a = normalizeSupplierName('ООО "Стройдеталь"');
    const b = normalizeSupplierName('АО "Стройдеталь"');
    expect(a).not.toBe(b);
  });

  it('идемпотентна', () => {
    const once = normalizeSupplierName('  ООО «АСФАЛЬТОБЕТОН»   ');
    expect(normalizeSupplierName(once)).toBe(once);
  });
});

describe('supplierMatcher — Левенштейн', () => {
  it('расстояние 0 для одинаковых строк', () => {
    expect(levenshteinDistance('abc', 'abc')).toBe(0);
  });

  it('расстояние = длине при пустой одной из строк', () => {
    expect(levenshteinDistance('', 'abcd')).toBe(4);
    expect(levenshteinDistance('abcd', '')).toBe(4);
  });

  it('базовые правки', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
    expect(levenshteinDistance('abc', 'abd')).toBe(1);
  });
});

describe('supplierMatcher — сходство имён', () => {
  it('1.0 после нормализации одинаковые', () => {
    expect(nameSimilarity('ООО "Ромашка"', 'ООО Ромашка')).toBe(1);
  });

  it('≥ 0.9 — пропавший пробел (юзкейс из ТЗ)', () => {
    const s = nameSimilarity('ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "СУ-10"', 'ОБЩЕСТВО С ОГРАНИЧЕННОЙОТВЕТСТВЕННОСТЬЮ СУ10');
    expect(s).toBeGreaterThanOrEqual(0.9);
  });

  it('≥ 0.9 — разные кавычки и пробелы', () => {
    const s = nameSimilarity('ООО «ТД «ТУЛА-СТАЛЬ»', 'ООО "ТД ТУЛА СТАЛЬ"');
    expect(s).toBe(1);
  });

  it('< 0.9 — разные компании с похожим словом', () => {
    const s = nameSimilarity('ООО "Стройдеталь"', 'АО "Стройдеталь"');
    expect(s).toBeLessThan(0.9);
  });

  it('0 если одна пустая', () => {
    expect(nameSimilarity('', 'что-то')).toBe(0);
    expect(nameSimilarity('что-то', '')).toBe(0);
  });
});
