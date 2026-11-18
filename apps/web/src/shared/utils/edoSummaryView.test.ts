import { describe, expect, it } from 'vitest';
import type { EdoSummary } from '@matcheck/contracts';
import {
  deliveriesAccusative,
  edoHeaderSumHint,
  edoListHint,
  edoListSourceLabel,
  listSums,
  sharedEdoText,
} from './edoSummaryView';

const base: EdoSummary = {
  documents: [],
  unpairedLinkedDocumentIds: [],
  ambiguous: false,
  sharedMax: 1,
  header: { total: 2323906.09, known: 1, count: 1, source: 'edo', comparison: null },
  list: {
    exVat: 1904840.56,
    vat: 419065.53,
    source: 'edo',
    edoExVat: 1904840.56,
    edoVat: 419065.53,
    factExVat: null,
    factVat: null,
    edoMissing: 0,
  },
};
const FACT = { exVat: 156335.4, vat: null };
/** Intl ставит узкие неразрывные пробелы — сравниваем текст с обычными. */
const plain = (text: string) => text.replace(/\s/g, ' ');

describe('edoSummaryView', () => {
  it('без ЭДО суммы списка — факт, метки нет', () => {
    expect(listSums(undefined, FACT)).toEqual(FACT);
    expect(edoListSourceLabel(undefined)).toBeNull();
  });

  it('с ЭДО суммы списка — по ЭДО, метка «ЭДО», факт в подсказке (25331)', () => {
    expect(listSums(base, FACT)).toEqual({ exVat: 1904840.56, vat: 419065.53 });
    expect(edoListSourceLabel(base)).toBe('ЭДО');
    expect(plain(edoListHint(base, FACT))).toContain('Факт приёмки: без НДС 156 335,40');
  });

  it('УПД не заменила факт (нет НДС) — список на факте', () => {
    const fact: EdoSummary = { ...base, list: { ...base.list, source: 'fact', edoMissing: 1 } };
    expect(listSums(fact, FACT)).toEqual(FACT);
    expect(edoListSourceLabel(fact)).toBeNull();
  });

  it('смешанная сумма — «ЭДО + факт» с разложением', () => {
    const mixed: EdoSummary = {
      ...base,
      list: { ...base.list, source: 'mixed', exVat: 1100, edoExVat: 1000, factExVat: 100 },
    };
    expect(edoListSourceLabel(mixed)).toBe('ЭДО + факт');
    expect(plain(edoListHint(mixed, FACT))).toMatch(
      /ЭДО: без НДС 1 000,00.*факт строк вне УПД: без НДС 100,00/,
    );
  });

  it('общая УПД и несопоставленные документы — в подсказке шапки', () => {
    const s: EdoSummary = { ...base, sharedMax: 6, ambiguous: true };
    expect(sharedEdoText(s)).toBe('УПД на 6 приёмок');
    expect(edoHeaderSumHint(s)).toMatch(
      /УПД на 6 приёмок.*один документ мог попасть в сумму дважды/,
    );
    expect(sharedEdoText(base)).toBeNull();
  });

  it('склонение «приёмок»', () => {
    expect([1, 2, 5, 11, 21, 22].map(deliveriesAccusative)).toEqual([
      'приёмку',
      'приёмки',
      'приёмок',
      'приёмок',
      'приёмку',
      'приёмки',
    ]);
  });
});
