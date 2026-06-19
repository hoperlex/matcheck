import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { convertXlsToXlsxBuffer } from '../src/domain/edo/xls-to-xlsx.js';

// Юнит-тест без сетевых/диск-зависимостей: создаём BIFF-буфер
// SheetJS'ом, конвертируем, читаем обратно — должны увидеть
// исходное значение ячейки. Это покрывает основной happy-path,
// без необходимости иметь .xls-фикстуру в репо.
describe('convertXlsToXlsxBuffer', () => {
  it('конвертирует валидный BIFF8 (.xls) в .xlsx, данные сохраняются', () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Документ', 'УПД'],
      ['Номер', '12345'],
      ['Дата', '2026-06-18'],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Лист1');
    const xlsBuffer: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'biff8' });

    // Проверяем что это реально BIFF/OLE2 (сигнатура D0CF11E0).
    expect(xlsBuffer.subarray(0, 4).toString('hex').toUpperCase()).toBe('D0CF11E0');

    const xlsxBuffer = convertXlsToXlsxBuffer(xlsBuffer);

    // OOXML — ZIP, начинается с 'PK' (50 4B 03 04).
    expect(xlsxBuffer.subarray(0, 2).toString('hex').toUpperCase()).toBe('504B');

    // Прочитаем обратно и убедимся что данные совпадают.
    const wbRead = XLSX.read(xlsxBuffer, { type: 'buffer' });
    const sheetName = wbRead.SheetNames[0];
    expect(sheetName).toBeDefined();
    const sheet = sheetName ? wbRead.Sheets[sheetName] : undefined;
    expect(sheet).toBeDefined();
    if (!sheet) return;
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 });
    expect(rows[0]).toEqual(['Документ', 'УПД']);
    expect(rows[1]).toEqual(['Номер', '12345']);
    expect(rows[2]).toEqual(['Дата', '2026-06-18']);
  });

  // Negative-кейсы для XlsConvertError не делаем юнит-тестом:
  // SheetJS терпим к произвольному вводу (умеет CSV/SLK/HTML и др.),
  // поэтому надёжно «сломать» его в репродуцируемом виде без реального
  // битого .xls сложно. Класс ошибки покрыт интеграционно — в worker.ts
  // через `instanceof XlsConvertError` переводится в parse_failed
  // с reason='xls_convert_failed'.
});
