import { describe, it, expect, vi } from 'vitest';

// Отдельный файл ради vi.mock: он поднимается на весь модуль, а в основном
// наборе классификатора нужен НАСТОЯЩИЙ парсер книги.
vi.mock('../src/domain/edo/upd-xlsx.parser.js', () => ({
  parseUpdXlsx: () => {
    throw new Error('boom');
  },
}));

const { classifyFile } = await import('../src/domain/edo/document-router.js');

describe('document-router: сбой структурной проверки Excel', () => {
  it('исключение парсера оставляет прежнее поведение — upd', async () => {
    // Структурная проверка книги нужна, чтобы спецификация не превращалась в
    // пустой УПД. Но если упал сам парсер, потерять распознаваемое хуже, чем
    // принять лишний файл: решение остаётся тем же, что и до проверки.
    const c = await classifyFile(
      Buffer.from('xlsx'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'upd.xlsx',
    );
    expect(c.detectedKind).toBe('upd');
    expect(c.parserUsed).toBe('parseUpdXlsx');
    expect(c.signals).toContain('excel:probe-failed');
  });
});
