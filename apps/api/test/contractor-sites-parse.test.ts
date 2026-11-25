// Разбор выгрузки 1С «Списание по субподряду» для связей подрядчик × объект.
// Пустые числа в настоящей выгрузке — ячейки-ошибки (t='e'): строки 2 и 56
// файла 25.11 — именно такие.
import { describe, expect, it } from 'vitest';
import XLSX from 'xlsx';
import {
  parseContractorSiteRows,
  readContractorSitesSheet,
} from '../src/domain/contractor-sites/parse.js';

const HEADER = [
  'ПроектРодитель',
  'Контрагент',
  'КоличествоДокументовРеализация',
  'СуммаДокументовРеализаций',
  'КоличествоДокументовДавальческийАкт',
  'СуммаДОкументовДавальческийАкт',
];

/** Книга как из 1С; `errors` — адреса ячеек-ошибок (#N/A). */
function book(rows: unknown[][], errors: string[] = []): XLSX.WorkBook {
  const ws = XLSX.utils.aoa_to_sheet([HEADER, ...rows]);
  for (const addr of errors) ws[addr] = { t: 'e', v: 0x2a, w: '#N/A' };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'TDSheet');
  return wb;
}

function parse(wb: XLSX.WorkBook) {
  const sheet = readContractorSitesSheet(wb);
  expect(sheet).not.toBeNull();
  return parseContractorSiteRows(sheet!);
}

describe('parseContractorSiteRows', () => {
  it('ячейки-ошибки — нули и пустой объект, суммы — в копейках', () => {
    const r = parse(
      book(
        [
          [
            'ВОЛОКОЛАМСКОЕ Ш., ВЛ. 71/13, ЖК PRIMAVERA, К. 13',
            'ЭСКО ООО',
            null,
            null,
            1,
            2660840.73,
          ],
          [null, 'МСМ КОНСТРАКШН ООО', null, null, 2, 17010286.94],
          ['МОСФИЛЬМОВСКАЯ УЛ., ВЛ. 31А', 'ОРИС ПРОМ  ', 4, 241280, null, null],
        ],
        ['C2', 'D2', 'A3', 'C3', 'D3', 'E4', 'F4'],
      ),
    );
    expect(r.issues).toEqual([]);
    expect(r.rows).toEqual([
      {
        rowNo: 2,
        raw: 'ЭСКО ООО',
        objectText: 'ВОЛОКОЛАМСКОЕ Ш., ВЛ. 71/13, ЖК PRIMAVERA, К. 13',
        realizationDocs: 0,
        realizationKop: 0,
        tollingDocs: 1,
        tollingKop: 266084073,
      },
      {
        rowNo: 3,
        raw: 'МСМ КОНСТРАКШН ООО',
        objectText: '',
        realizationDocs: 0,
        realizationKop: 0,
        tollingDocs: 2,
        tollingKop: 1701028694,
      },
      {
        rowNo: 4,
        // Пробелы схлопнуты так же, как в разборе подрядчиков 21.10.
        raw: 'ОРИС ПРОМ',
        objectText: 'МОСФИЛЬМОВСКАЯ УЛ., ВЛ. 31А',
        realizationDocs: 4,
        realizationKop: 24128000,
        tollingDocs: 0,
        tollingKop: 0,
      },
    ]);
    expect(r.contractors.map((c) => c.raw)).toEqual([
      'ЭСКО ООО',
      'МСМ КОНСТРАКШН ООО',
      'ОРИС ПРОМ',
    ]);
  });

  it('нет колонки — фатально, строки не разбираются', () => {
    const ws = XLSX.utils.aoa_to_sheet([HEADER.slice(0, 5), ['X', 'ЭСКО ООО', 1, 1, 0]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'TDSheet');
    const r = parse(wb);
    expect(r.rows).toEqual([]);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ fatal: true, code: 'missing_column' });
  });

  it('текст или дробь в количестве, отрицательная сумма — фатально', () => {
    const r = parse(
      book([
        ['А', 'ПЕРВЫЙ ООО', 'много', 10, 0, 0],
        ['Б', 'ВТОРОЙ ООО', 1.5, 10, 0, 0],
        ['В', 'ТРЕТИЙ ООО', 1, -10, 0, 0],
      ]),
    );
    expect(r.rows).toEqual([]);
    expect(r.issues.map((i) => [i.rowNo, i.code, i.fatal])).toEqual([
      [2, 'bad_number', true],
      [3, 'bad_number', true],
      [4, 'bad_number', true],
    ]);
  });

  it('строка без документов пропускается, документы без суммы — замечание', () => {
    const r = parse(
      book([
        ['А', 'ПУСТОЙ ООО', 0, 0, 0, 0],
        ['Б', 'БЕЗ СУММЫ ООО', 3, 0, 0, 0],
        ['', '', '', '', '', ''],
      ]),
    );
    expect(r.rows.map((x) => x.raw)).toEqual(['БЕЗ СУММЫ ООО']);
    expect(r.issues.map((i) => [i.rowNo, i.code, i.fatal])).toEqual([
      [2, 'zero_row', false],
      [3, 'count_sum_mismatch', false],
    ]);
  });
});
