import { describe, it, expect } from 'vitest';
import {
  ExcelConvertError,
  ExcelConvertTimeoutError,
  LibreOfficeNotAvailableError,
} from '../src/domain/edo/excel-to-png.js';

// Юнит-тесты на классы ошибок Excel→PNG конвертера. Полноценный
// интеграционный тест (с реальным soffice + pdftoppm) требовал бы:
//   1) Установленного LibreOffice в CI.
//   2) Реального .xls/.xlsx файла для конвертации.
// Это слишком тяжёлая зависимость для unit-теста, поэтому ограничиваемся
// проверкой контрактов классов ошибок — worker полагается на них через
// instanceof для разделения «нет фичи» vs «фича упала».
describe('excel-to-png error classes', () => {
  it('LibreOfficeNotAvailableError имеет имя и message с подсказкой', () => {
    const err = new LibreOfficeNotAvailableError();
    expect(err.name).toBe('LibreOfficeNotAvailableError');
    // Message содержит подсказку об установке — это покажется админу в логах.
    expect(err.message).toMatch(/soffice|LibreOffice/);
    expect(err.message).toMatch(/Dockerfile|apk add/);
    // Должен быть Error instance для catch-by-class в worker.
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LibreOfficeNotAvailableError);
  });

  it('ExcelConvertError несёт message и имеет правильный name', () => {
    const err = new ExcelConvertError('soffice exit=1: broken file');
    expect(err.name).toBe('ExcelConvertError');
    expect(err.message).toContain('broken file');
    expect(err).toBeInstanceOf(Error);
  });

  it('ExcelConvertTimeoutError несёт elapsedMs', () => {
    const err = new ExcelConvertTimeoutError(95_000);
    expect(err.name).toBe('ExcelConvertTimeoutError');
    expect(err.elapsedMs).toBe(95_000);
    expect(err.message).toMatch(/95000|таймаут/);
    expect(err).toBeInstanceOf(Error);
  });

  it('classes разделимы через instanceof (worker полагается на это)', () => {
    const noLO = new LibreOfficeNotAvailableError();
    const failed = new ExcelConvertError('exit=1');
    const timeout = new ExcelConvertTimeoutError(60_000);

    expect(noLO instanceof LibreOfficeNotAvailableError).toBe(true);
    expect(noLO instanceof ExcelConvertError).toBe(false);
    expect(noLO instanceof ExcelConvertTimeoutError).toBe(false);

    expect(failed instanceof ExcelConvertError).toBe(true);
    expect(failed instanceof LibreOfficeNotAvailableError).toBe(false);
    expect(failed instanceof ExcelConvertTimeoutError).toBe(false);

    expect(timeout instanceof ExcelConvertTimeoutError).toBe(true);
    expect(timeout instanceof ExcelConvertError).toBe(false);
    expect(timeout instanceof LibreOfficeNotAvailableError).toBe(false);
  });
});
