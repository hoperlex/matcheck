import { describe, expect, it } from 'vitest';
import { contractorFilterOptions } from './contractorFilterOptions';

describe('contractorFilterOptions', () => {
  it('тёзкам дописывает ИНН, остальным оставляет имя', () => {
    const options = contractorFilterOptions([
      { id: 'a', name: 'ООО "МАСТЕР"', inn: '7708203762' },
      { id: 'b', name: 'ООО "МАСТЕР" ', inn: '5017084167' },
      { id: 'c', name: 'МАСТЕР', inn: '' },
      { id: 'd', name: 'ООО "СМУ-9"', inn: '7722486939' },
    ]);
    expect(options).toEqual([
      { value: 'a', label: 'ООО "МАСТЕР" (ИНН 7708203762)' },
      { value: 'b', label: 'ООО "МАСТЕР" (ИНН 5017084167)' },
      { value: 'c', label: 'МАСТЕР (без ИНН)' },
      { value: 'd', label: 'ООО "СМУ-9"' },
    ]);
  });

  it('кавычки, регистр и «ё» тёзок не разводят', () => {
    const options = contractorFilterOptions([
      { id: 'a', name: 'ООО «Стройресурс»', inn: '9728155310' },
      { id: 'b', name: 'ООО "СТРОЙРЕСУРС"', inn: '7726469250' },
    ]);
    expect(options.map((o) => o.label)).toEqual([
      'ООО «Стройресурс» (ИНН 9728155310)',
      'ООО "СТРОЙРЕСУРС" (ИНН 7726469250)',
    ]);
  });
});
