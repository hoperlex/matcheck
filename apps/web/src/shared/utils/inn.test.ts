import { describe, expect, it } from 'vitest';
import { isValidInnChecksum, normalizeInn } from './inn';

describe('normalizeInn', () => {
  it.each([
    ['7736255508', '7736255508'], // АО «СУ-10»
    ['7714679380', '7714679380'], // СК «ЭСТ» — в справочнике заказчика её нет
    ['500100732259', '500100732259'], // 12 знаков, ИП
    // Справочник хранит ИНН свободным текстом: пробелы, дефисы, подпись.
    ['77 36-255508', '7736255508'],
    ['ИНН 7736255508', '7736255508'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeInn(raw)).toBe(expected);
  });

  it.each([
    // Контрольная цифра 9, а не 7: так его прочитало распознавание в 30 УПД.
    '7736255087',
    // Перестановка цифр на скане — та, ради которой проверка и нужна.
    '7736255088',
    // Мусорный «ИНН» из операционного справочника.
    '127018',
    // 11 знаков — ни организация, ни ИП.
    '77362555080',
    '',
  ])('%s → null', (raw) => {
    expect(normalizeInn(raw)).toBeNull();
  });

  it('null и undefined — нет ИНН', () => {
    expect(normalizeInn(null)).toBeNull();
    expect(normalizeInn(undefined)).toBeNull();
  });
});

describe('isValidInnChecksum', () => {
  it('нецифровая строка не проходит', () => {
    expect(isValidInnChecksum('77362555O8')).toBe(false);
  });
});
