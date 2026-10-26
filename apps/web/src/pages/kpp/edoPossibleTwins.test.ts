import { describe, expect, it } from 'vitest';
import { possibleTwins, type TwinCandidate } from './edoPossibleTwins';

const row = (over: Partial<TwinCandidate> & Pick<TwinCandidate, 'id'>): TwinCandidate => ({
  source: 'export',
  operator: 'diadoc',
  docNumber: '671',
  docDate: '2026-08-31',
  supplierInn: '5047000000',
  totalSum: '8378000.00',
  ...over,
});

describe('possibleTwins — одна шапка у разных операторов', () => {
  it('Диадок и СБИС с одной шапкой — подсказка обеим строкам с другим оператором', () => {
    const twins = possibleTwins([row({ id: 'd' }), row({ id: 's', operator: 'sbis', totalSum: '8378000' })]);
    expect(twins.get('export:d')).toEqual(['sbis']);
    expect(twins.get('export:s')).toEqual(['diadoc']);
  });

  it('один оператор — не пара: повторы внутри Диадока подсказкой не помечаются', () => {
    expect(possibleTwins([row({ id: 'a' }), row({ id: 'b' })]).size).toBe(0);
  });

  it('другая сумма, дата, ИНН или номер — не та же шапка', () => {
    for (const over of [
      { totalSum: '3558000.00' },
      { docDate: '2026-09-01' },
      { supplierInn: '5047000001' },
      { docNumber: '672' },
    ]) {
      expect(possibleTwins([row({ id: 'd' }), row({ id: 's', operator: 'sbis', ...over })]).size).toBe(0);
    }
  });

  it('пробелы и регистр в номере не мешают; без номера, даты, ИНН, суммы или оператора — молчим', () => {
    expect(possibleTwins([row({ id: 'd', docNumber: 'ут 45' }), row({ id: 's', operator: 'sbis', docNumber: 'УТ45' })]).size).toBe(2);
    for (const over of [{ docNumber: null }, { docDate: null }, { supplierInn: null }, { totalSum: null }, { operator: undefined }]) {
      expect(possibleTwins([row({ id: 'd', ...over }), row({ id: 's', operator: 'sbis', ...over })]).size).toBe(0);
    }
  });
});
