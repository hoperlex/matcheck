import * as XLSX from 'xlsx';

/**
 * Конвертирует buffer старого .xls (BIFF / OLE2 Compound Document,
 * сигнатура D0 CF 11 E0) в in-memory buffer .xlsx (OOXML zip).
 *
 * Зачем: ExcelJS (используемый в parseUpdXlsx) умеет читать только
 * OOXML и падает на BIFF c "invalid signature: 0xe011cfd0". 1С и
 * некоторые ERP экспортируют УПД именно в .xls. Чтобы не дублировать
 * сложный парсер УПД-таблицы, дешевле прогнать .xls через SheetJS
 * (умеет BIFF) → получить .xlsx-буфер → парсить уже существующим
 * ExcelJS-парсером.
 *
 * Что делает:
 *  - XLSX.read(buffer, { type: 'buffer' }) — SheetJS определяет формат
 *    по магическим байтам автоматически, поддерживает BIFF2/5/8, SLK,
 *    CSV, ODS и др. Если файл повреждён — кидает Error.
 *  - XLSX.write({ bookType: 'xlsx' }) — сериализует в OOXML. Cell-
 *    стили/формулы/merge'ы могут не сохраниться 1:1, но парсер УПД
 *    использует только текстовые значения ячеек, поэтому это
 *    некритично.
 *
 * Не делает: ничего в файловой системе, никаких внешних бинарей
 * (поэтому не нужен LibreOffice в Docker-образе). Полностью in-memory.
 *
 * Бросает:
 *  - XlsConvertError — если SheetJS не смог прочитать файл (битый
 *    OLE2, неизвестная разновидность BIFF, файл пустой).
 *
 * @throws {XlsConvertError}
 */
export function convertXlsToXlsxBuffer(xlsBuffer: Buffer): Buffer {
  let workbook;
  try {
    workbook = XLSX.read(xlsBuffer, { type: 'buffer' });
  } catch (err) {
    throw new XlsConvertError(
      `Не удалось прочитать .xls: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new XlsConvertError('Файл .xls пустой — нет ни одного листа.');
  }
  // bookSST=true слегка уменьшает размер; type:'buffer' возвращает
  // Node Buffer на Node, Uint8Array на других платформах.
  const out = XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx',
    bookSST: true,
  });
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

/**
 * Ошибка конвертации .xls → .xlsx. Worker ловит её и переводит
 * в parse_failed с понятным reason='xls_convert_failed', не пуская
 * необработанное исключение наверх (иначе BullMQ будет ретраить
 * на том же payload впустую).
 */
export class XlsConvertError extends Error {
  // ES2022 standardized `cause?: unknown` в Error — TS4115 заставляет
  // явно объявить override, чтобы не затенить базовое поле случайно
  // другим типом. Передаём cause наверх через стандартный конструктор.
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'XlsConvertError';
    this.cause = cause;
  }
}
