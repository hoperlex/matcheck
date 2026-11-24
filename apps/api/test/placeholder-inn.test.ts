/**
 * ИНН-заглушка «0000…» не должна выглядеть ИНН ни для одного нормализатора.
 *
 * Хвост заглушки — 8 hex. После «оставить только цифры» каждая четвёртая
 * заглушка давала 10 или 12 цифр: «0000ab123456» → «0000123456». На бою так
 * строка подрядчика 00007108c2a9 «ЭЛЕВАТОР КОНСТРАКШН» считалась ИНН 0000710829
 * в договорах 1С и сверке с EstiMat. Нормализаторы отсекают заглушку по
 * префиксу до очистки — см. domain/directories/placeholder-inn.ts.
 */
import { describe, expect, it } from 'vitest';
import { isPlaceholderInn } from '@matcheck/contracts';
import { generatePlaceholderInn } from '../src/domain/directories/placeholder-inn.js';
import { innDigits as directoryInnDigits } from '../src/domain/directories/names.js';
import { filterInn } from '../src/domain/directories/supplier-filter-groups.js';
import { innDigits as estimatInnDigits } from '../src/domain/estimat/estimat.types.js';
import { normalizeInn } from '../src/domain/sourceDocuments/resolve-contractor.js';

const normalizers = {
  'estimat innDigits': estimatInnDigits,
  'names innDigits': directoryInnDigits,
  normalizeInn,
  filterInn,
} as const;

// Две буквы → 10 цифр; живая заглушка с бою; одни цифры → 12 цифр.
const PLACEHOLDERS = ['0000ab123456', '00007108c2a9', '000012345678'];

describe('ИНН-заглушка не проходит нормализацию', () => {
  for (const [name, fn] of Object.entries(normalizers)) {
    for (const p of PLACEHOLDERS) {
      it(`${name}(${p}) → null`, () => {
        expect(fn(p)).toBeNull();
        expect(fn(` ${p} `)).toBeNull();
      });
    }
  }

  it('настоящий ИНН проходит, как раньше', () => {
    for (const inn of ['7707083893', '500100732259']) {
      expect(estimatInnDigits(inn)).toBe(inn);
      expect(directoryInnDigits(inn)).toBe(inn);
      expect(normalizeInn(inn)).toBe(inn);
      expect(filterInn(inn)).toBe(inn);
    }
  });
});

describe('generatePlaceholderInn', () => {
  it('всегда заглушка из 12 символов, которую нормализаторы отбрасывают', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const p = generatePlaceholderInn();
      seen.add(p);
      expect(p).toMatch(/^0000[0-9a-f]{8}$/);
      expect(isPlaceholderInn(p)).toBe(true);
      for (const fn of Object.values(normalizers)) expect(fn(p)).toBeNull();
    }
    expect(seen.size).toBeGreaterThan(990);
  });
});
