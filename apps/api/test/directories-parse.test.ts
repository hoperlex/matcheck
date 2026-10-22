import { describe, expect, it } from 'vitest';
import {
  parseBillhubSupplierRows,
  parseMoscowDateTime,
  parseOneCContractorRows,
} from '../src/domain/directories/parse.js';

const HEADER = [
  'Наименование',
  'ИНН',
  'Альтернативные наименования',
  'Статус СБ',
  'Комментарий по учредительным документам',
  'Создан (МСК)',
  'ID',
];
const ID1 = 'b9eb96fa-d5fe-4e32-b44a-69ae3631a2af';
const ID2 = '60a78f8a-58f5-4715-8173-b9cb6021594c';

describe('parseBillhubSupplierRows', () => {
  it('колонки ищутся по заголовкам, статусы и время по Москве', () => {
    const { suppliers, issues } = parseBillhubSupplierRows([
      ['Лишняя', ...HEADER],
      [
        'x',
        ' ООО "КРОВЛЯ И ИЗОЛЯЦИЯ"',
        '7721844518',
        '',
        'Согласован',
        'почта: a@b.ru\r\nполный',
        '2026-08-31 13:13',
        ID1,
      ],
      [
        'x',
        'ООО «ЭЛЕКТРОМОНТАЖ» ',
        '5027296594',
        'ООО ЭМ; Электромонтаж',
        'Отклонен',
        '',
        '2026-03-17 18:27',
        ID2.toUpperCase(),
      ],
      ['', '', '', '', '', '', '', ''],
    ]);
    expect(issues).toEqual([]);
    expect(suppliers).toHaveLength(2);
    expect(suppliers[0]).toMatchObject({
      rowNo: 2,
      id: ID1,
      name: 'ООО "КРОВЛЯ И ИЗОЛЯЦИЯ"',
      innRaw: '7721844518',
      aliases: [],
      securityStatus: 'approved',
      comment: 'почта: a@b.ru\nполный',
    });
    expect(suppliers[0]!.createdAt.toISOString()).toBe('2026-08-31T10:13:00.000Z');
    expect(suppliers[1]).toMatchObject({
      id: ID2,
      aliases: ['ООО ЭМ', 'Электромонтаж'],
      securityStatus: 'rejected',
      comment: null,
    });
  });

  it('нет нужной колонки — фатально', () => {
    const { issues } = parseBillhubSupplierRows([HEADER.filter((h) => h !== 'Статус СБ')]);
    expect(issues.some((i) => i.fatal && i.code === 'missing_column')).toBe(true);
  });

  it('кривой UUID, повтор ID, неизвестный статус, кривая дата — фатально', () => {
    const { issues } = parseBillhubSupplierRows([
      HEADER,
      ['А', '1', '', '', '', '2026-01-01 10:00', 'не-uuid'],
      ['Б', '2', '', '', '', '2026-01-01 10:00', ID1],
      ['В', '3', '', '', '', '2026-01-01 10:00', ID1],
      ['Г', '4', '', 'На проверке', '', '2026-01-01 10:00', ID2],
      ['Д', '5', '', '', '', '01.01.2026', 'c5322245-4cbd-4a5e-83d0-ad63b85931d5'],
    ]);
    expect(issues.filter((i) => i.fatal).map((i) => i.code)).toEqual([
      'bad_id',
      'duplicate_id',
      'bad_status',
      'bad_created_at',
    ]);
  });

  it('повтор ИНН — замечание, не фатально', () => {
    const { suppliers, issues } = parseBillhubSupplierRows([
      HEADER,
      ['А', '7722466153,', '', '', '', '2026-01-01 10:00', ID1],
      ['Б', '7722466153', '', '', '', '2026-01-01 10:00', ID2],
    ]);
    expect(suppliers).toHaveLength(2);
    expect(issues).toMatchObject([{ fatal: false, code: 'duplicate_inn', rowNo: 3 }]);
  });

  it('parseMoscowDateTime: секунды необязательны, мусор — null', () => {
    expect(parseMoscowDateTime('2026-03-17 18:27:40')!.toISOString()).toBe(
      '2026-03-17T15:27:40.000Z',
    );
    expect(parseMoscowDateTime('вчера')).toBeNull();
  });
});

describe('parseOneCContractorRows', () => {
  it('подрядчики схлопываются по имени, ИНН из скобок, ячейки-ошибки не мешают', () => {
    const { contractors, issues } = parseOneCContractorRows([
      [
        'ПроектРодитель',
        'Контрагент',
        'КоличествоДокументовРеализация',
        'СуммаДокументовРеализаций',
      ],
      ['ЖК PRIMAVERA', 'ФОРТЭКС ООО', '#VALUE!', ''],
      ['ЖК «ДОМ 56»', 'ФОРТЭКС  ООО', '51', '79470451.57'],
      ['ЖК «ЗИЛАРТ»', 'АЛЬЯНС ООО (7716967786)', '', ''],
      ['ЖК «ЗИЛАРТ»', 'ЮТАРА ООО (9704043738)', '', ''],
      ['ЖК «ЗИЛАРТ»', '   ', '', ''],
    ]);
    expect(contractors.map((c) => [c.raw, c.inn, c.rowNos, c.projects])).toEqual([
      ['ФОРТЭКС ООО', null, [2, 3], ['ЖК PRIMAVERA', 'ЖК «ДОМ 56»']],
      ['АЛЬЯНС ООО (7716967786)', '7716967786', [4], ['ЖК «ЗИЛАРТ»']],
      ['ЮТАРА ООО (9704043738)', null, [5], ['ЖК «ЗИЛАРТ»']],
    ]);
    expect(issues.map((i) => [i.code, i.fatal])).toEqual([
      ['bad_bracket_inn', false],
      ['empty_name', false],
    ]);
  });

  it('нет колонки «Контрагент» — фатально', () => {
    const { issues } = parseOneCContractorRows([['ПроектРодитель', 'Сумма']]);
    expect(issues[0]).toMatchObject({ fatal: true, code: 'missing_column' });
  });
});
