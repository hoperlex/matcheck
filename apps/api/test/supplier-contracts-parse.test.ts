import { describe, expect, it } from 'vitest';
import { parseContractDate, parseContractRows } from '../src/domain/supplier-contracts/parse.js';

const HEADER = [
  'Кли',
  'КлиИНН',
  'Кли_аid_all',
  'Дог',
  'Дог_id_all',
  'Номер',
  'Дата',
  'ВидДоговора',
  'ОбъектВыполнения',
  'Дог_НаименованиеПолное',
  'НаименованиеДляПечатныхФорм',
];

const row = (patch: Partial<Record<string, string>> = {}) => {
  const base: Record<string, string> = {
    Кли: 'РУТЕК ООО',
    КлиИНН: '7716951747',
    Кли_аid_all: '22fc33d1-55f2-11ed-8012-005056be257f',
    Дог: 'Волоколамское ш., вл.93-97 этап 2, ДГ №СУ-СБ2/25-54 от 26.08.25',
    Дог_id_all: '7d15f47e-75a8-4b85-80c2-9a0ffc938459',
    Номер: 'СУ-СБ2/25-54',
    Дата: '26.08.2025',
    ВидДоговора: 'С поставщиком',
    ОбъектВыполнения: '',
    Дог_НаименованиеПолное: '',
    НаименованиеДляПечатныхФорм: '',
    ...patch,
  };
  return HEADER.map((h) => base[h] ?? '');
};

describe('дата договора', () => {
  it('дд.мм.гггг → ISO', () => {
    expect(parseContractDate('26.08.2025')).toBe('2025-08-26');
    expect(parseContractDate('')).toBeNull();
  });
  it('битые даты из 1С и несуществующие по календарю — undefined', () => {
    expect(parseContractDate('05.07.0223')).toBeUndefined();
    expect(parseContractDate('31.02.2026')).toBeUndefined();
    expect(parseContractDate('29.02.2025')).toBeUndefined();
    expect(parseContractDate('29.02.2024')).toBe('2024-02-29');
    expect(parseContractDate('2025-08-26')).toBeUndefined();
  });
});

describe('разбор выгрузки', () => {
  it('нормальная строка', () => {
    const { contracts, issues } = parseContractRows([HEADER, row()]);
    expect(issues).toEqual([]);
    expect(contracts).toEqual([
      {
        rowNo: 2,
        onecId: '7d15f47e-75a8-4b85-80c2-9a0ffc938459',
        counterpartyOnecId: '22fc33d1-55f2-11ed-8012-005056be257f',
        counterpartyName: 'РУТЕК ООО',
        counterpartyInn: '7716951747',
        name: 'Волоколамское ш., вл.93-97 этап 2, ДГ №СУ-СБ2/25-54 от 26.08.25',
        number: 'СУ-СБ2/25-54',
        contractDate: '2025-08-26',
        kind: 'supplier',
        objectText: null,
      },
    ]);
  });

  it('виды договора и неизвестный вид → «прочее» с замечанием', () => {
    const { contracts, issues } = parseContractRows([
      HEADER,
      row({ ВидДоговора: 'С покупателем', Дог_id_all: '00000000-0000-4000-8000-000000000001' }),
      row({ ВидДоговора: 'Прочее', Дог_id_all: '00000000-0000-4000-8000-000000000002' }),
      row({ ВидДоговора: 'Комиссия', Дог_id_all: '00000000-0000-4000-8000-000000000003' }),
    ]);
    expect(contracts.map((c) => c.kind)).toEqual(['buyer', 'other', 'other']);
    expect(issues).toEqual([expect.objectContaining({ rowNo: 4, code: 'unknown_kind', fatal: false })]);
  });

  it('битая дата → null и замечание, не фатально', () => {
    const { contracts, issues } = parseContractRows([HEADER, row({ Дата: '05.07.0223' })]);
    expect(contracts[0]!.contractDate).toBeNull();
    expect(issues).toEqual([expect.objectContaining({ code: 'bad_date', fatal: false, value: '05.07.0223' })]);
  });

  it('повтор GUID договора, кривой GUID и ИНН — фатально', () => {
    const { issues } = parseContractRows([
      HEADER,
      row(),
      row(),
      row({ Дог_id_all: 'не-гуид' }),
      row({ Дог_id_all: '00000000-0000-4000-8000-000000000009', КлиИНН: '7,72E+11' }),
    ]);
    expect(issues.map((i) => [i.rowNo, i.code, i.fatal])).toEqual([
      [3, 'duplicate_id', true],
      [4, 'bad_id', true],
      [5, 'bad_inn', true],
    ]);
  });

  it('нет обязательной колонки — фатально', () => {
    const { contracts, issues } = parseContractRows([HEADER.filter((h) => h !== 'Дог_id_all'), row()]);
    expect(contracts).toEqual([]);
    expect(issues).toEqual([expect.objectContaining({ code: 'missing_column', fatal: true, value: 'дог_id_all' })]);
  });

  it('пустые строки в конце листа пропускаются', () => {
    const { contracts, issues } = parseContractRows([HEADER, row(), HEADER.map(() => '')]);
    expect(contracts).toHaveLength(1);
    expect(issues).toEqual([]);
  });
});
