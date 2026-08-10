/**
 * Разбор имени файла из Content-Disposition.
 *
 * Сервер отдаёт две формы: xlsx-экспорты — `filename="…"`, прокси оригиналов и
 * доп. документов — `filename*=UTF-8''…` (кириллица в именах файлов поставщика
 * обычное дело). Наивная регулярка по `filename` возвращала у второй формы
 * `*=UTF-8''cert.pdf` — непустую строку, из-за чего fallback вызывающего не
 * срабатывал и файл сохранялся с этим именем.
 */
import { describe, expect, it } from 'vitest';
import { parseContentDispositionFilename } from './api';

describe('parseContentDispositionFilename', () => {
  it('читает RFC 5987 filename*', () => {
    expect(parseContentDispositionFilename("attachment; filename*=UTF-8''cert.pdf")).toBe(
      'cert.pdf',
    );
  });

  it('декодирует кириллицу', () => {
    expect(
      parseContentDispositionFilename(
        "attachment; filename*=UTF-8''%D0%A1%D0%B5%D1%80%D1%82%D0%B8%D1%84%D0%B8%D0%BA%D0%B0%D1%82.pdf",
      ),
    ).toBe('Сертификат.pdf');
  });

  it('декодирует пробелы', () => {
    expect(
      parseContentDispositionFilename(
        "attachment; filename*=UTF-8''%D0%9F%D0%B0%D1%81%D0%BF%D0%BE%D1%80%D1%82%20%D0%BA%D0%B0%D1%87%D0%B5%D1%81%D1%82%D0%B2%D0%B0.pdf",
      ),
    ).toBe('Паспорт качества.pdf');
  });

  it('понимает старую форму filename= в кавычках — xlsx-экспорты не ломаются', () => {
    expect(
      parseContentDispositionFilename(
        'attachment; filename="documents-inbound-2026-06-02.xlsx"',
      ),
    ).toBe('documents-inbound-2026-06-02.xlsx');
  });

  it('понимает filename= без кавычек', () => {
    expect(parseContentDispositionFilename('attachment; filename=cert.pdf')).toBe('cert.pdf');
  });

  it('при обеих формах побеждает filename*', () => {
    expect(
      parseContentDispositionFilename(
        `attachment; filename="cert.pdf"; filename*=UTF-8''%D0%A1.pdf`,
      ),
    ).toBe('С.pdf');
  });

  it('битый процент-эскейп откатывается на filename=', () => {
    expect(
      parseContentDispositionFilename(`attachment; filename*=UTF-8''%ZZ; filename="cert.pdf"`),
    ).toBe('cert.pdf');
  });

  it('без имени и на пустом заголовке возвращает пустую строку', () => {
    expect(parseContentDispositionFilename('attachment')).toBe('');
    expect(parseContentDispositionFilename('')).toBe('');
  });
});
