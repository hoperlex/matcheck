import { describe, expect, it } from 'vitest';
import {
  documentNumberCore,
  normalizeSupplierName,
  rankEdoAgainstReferences,
  rankEdoDocument,
  validInns,
  type MatchDocument,
  type MatchReference,
} from '../src/domain/operations/edo-match.js';

// 5009091604 — настоящий ИНН «Терма Альянс» (контрольная цифра сходится);
// 5009016450 — он же, прочитанный с бумажной УПД приёмки 19134 с ошибкой.
const INN = '5009091604';
const BROKEN_INN = '5009016450';
const OTHER_INN = '7736255508';

const reference: MatchReference = {
  origin: 'paper',
  label: 'Т26-1315-11',
  numbers: ['Т26-1315-11'],
  date: '2026-10-09',
  inns: [INN],
  innUnreadable: false,
  names: ['Терма Альянс'],
  sums: ['127297.50'],
  arrivedDate: '2026-10-09',
};

const doc: MatchDocument = {
  docNumber: 'Т26-1315-11',
  docDate: '2026-10-09',
  supplierInn: INN,
  supplierName: 'ООО «Терма Альянс»',
  totalSum: '127297.50',
};

describe('нормализация', () => {
  it('ядро номера — цифры без ведущих нулей, не короче трёх', () => {
    expect(documentNumberCore('УТ-2214')).toBe('2214');
    expect(documentNumberCore('0000123')).toBe('123');
    expect(documentNumberCore('12')).toBe('');
  });

  it('название без формы собственности и кавычек', () => {
    expect(normalizeSupplierName('ООО «Терма Альянс»')).toBe(normalizeSupplierName('ТЕРМА АЛЬЯНС'));
    expect(
      normalizeSupplierName('Общество с ограниченной ответственностью "Терма Альянс"'),
    ).toBe('термаальянс');
  });

  it('битый ИНН не перекрывает верный из другого источника', () => {
    expect(validInns([BROKEN_INN, INN])).toEqual({ inns: [INN], unreadable: false });
    expect(validInns([BROKEN_INN, '500901604'])).toEqual({ inns: [], unreadable: true });
    expect(validInns([null, ''])).toEqual({ inns: [], unreadable: false });
  });
});

describe('уровень совпадения', () => {
  it('«сильное» — полный номер, проверенный ИНН и та же дата', () => {
    const result = rankEdoDocument(reference, doc);
    expect(result.level).toBe('high');
    expect(result.conflicts).toEqual([]);
  });

  it('похожие буквы и знаки в номере — тот же номер', () => {
    expect(rankEdoDocument(reference, { ...doc, docNumber: 'T26 1315/11' }).level).toBe('high');
  });

  it('совпадение по цифрам номера + ИНН + дата — только «проверьте»', () => {
    const result = rankEdoDocument(
      { ...reference, numbers: ['2214'], label: '2214' },
      { ...doc, docNumber: 'УТ-2214' },
    );
    expect(result.matches).toContain('номер совпал по цифрам');
    expect(result.level).toBe('possible');
  });

  it('полный номер и ИНН без даты — не «сильное»', () => {
    const result = rankEdoDocument({ ...reference, date: null }, doc);
    expect(result.missing).toContain('дата документа');
    expect(result.level).toBe('possible');
  });

  it('сумма с фото не поднимает уровень и неравенство не считается расхождением', () => {
    const photo: MatchReference = {
      ...reference,
      origin: 'photo',
      inns: [],
      names: [],
      sums: ['153016.48', '127297.50'],
    };
    const equal = rankEdoDocument(photo, doc);
    expect(equal.matches).toContain('сумма с фото совпала с итогом');
    expect(equal.level).toBe('possible');
    const different = rankEdoDocument({ ...photo, sums: ['153016.48'] }, doc);
    expect(different.conflicts).toEqual([]);
  });

  it('соседние номера одной серии — расхождение, а не совпадение', () => {
    for (const number of ['Т26-1315-1', 'Т26-1315-10']) {
      const result = rankEdoDocument(reference, { ...doc, docNumber: number });
      expect(result.conflicts).toContain('номер УПД отличается');
      expect(result.level).toBe('possible'); // совпал ИНН — показать, но проверять
    }
  });

  it('одинаковое ядро номера у другого поставщика — не «сильное»', () => {
    const result = rankEdoDocument(
      { ...reference, numbers: ['2214'] },
      { ...doc, docNumber: 'ЦБ-2214', supplierInn: OTHER_INN, supplierName: 'Другой' },
    );
    expect(result.conflicts).toContain('ИНН поставщика отличается');
    expect(result.level).not.toBe('high');
  });

  it('битый ИНН у приёмки — «нет данных», сверка по названию', () => {
    const checked = validInns([BROKEN_INN]);
    const result = rankEdoDocument(
      { ...reference, inns: checked.inns, innUnreadable: checked.unreadable },
      doc,
    );
    expect(result.conflicts).not.toContain('ИНН поставщика отличается');
    expect(result.missing).toContain('ИНН поставщика (в документе приёмки не проходит проверку)');
    expect(result.matches).toContain('название поставщика');
    expect(result.level).toBe('possible');
  });

  it('совпала только дата — «мало совпадений»', () => {
    const result = rankEdoDocument(reference, {
      docNumber: 'Иной номер',
      docDate: '2026-10-09',
      supplierInn: OTHER_INN,
      supplierName: 'Другой',
      totalSum: '500',
    });
    expect(result.level).toBe('weak');
  });

  it('близость даты считается только для УПД не позже приезда', () => {
    const noDate = { ...reference, date: null, numbers: [], inns: [], names: [], sums: [] };
    expect(rankEdoDocument(noDate, { ...doc, docDate: '2026-10-05' }).matches).toContain(
      'дата близка к приезду',
    );
    expect(rankEdoDocument(noDate, { ...doc, docDate: '2026-10-11' }).matches).not.toContain(
      'дата близка к приезду',
    );
  });
});

describe('приёмка с несколькими УПД', () => {
  it('сверяется с каждым эталоном отдельно и называет, с каким', () => {
    const result = rankEdoAgainstReferences(
      [
        reference,
        {
          ...reference,
          label: 'А-22',
          numbers: ['А-22'],
          sums: ['500.00'],
        },
      ],
      { ...doc, docNumber: 'A-22', totalSum: '500.00' },
    );
    expect(result.reference.label).toBe('А-22');
    expect(result.level).toBe('high');
  });
});
