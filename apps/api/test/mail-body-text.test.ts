/**
 * Текст письма для распознавания и показа.
 *
 * Главное свойство: у html-письма без текстовой части текст всё равно
 * получается. Разбор идёт настоящим mailparser'ом, а не заглушкой, — именно
 * его поведение и было причиной дефекта: `parsed.text` заполняется только для
 * голого `text/html` в корне либо когда рядом есть text/plain, а Outlook и
 * mail.ru кладут html внутрь multipart, и тело для матчера исчезало.
 */
import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';
import { extractPlainText } from '../src/domain/mail/body-text.js';

const CRLF = '\r\n';

function eml(lines: string[]): Buffer {
  return Buffer.from(lines.join(CRLF), 'utf8');
}

/** html внутри multipart/alternative и БЕЗ text/plain — самая частая форма. */
const HTML_ONLY_ALTERNATIVE = eml([
  'From: snab@podryad.ru',
  'Subject: UPD',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><body><p>Объект - Волоколамское ш., вл. 93-97</p></body></html>',
  '--b1--',
  '',
]);

describe('текст письма', () => {
  it('html без текстовой части: mailparser текст не даёт, а мы даём', async () => {
    const parsed = await simpleParser(HTML_ONLY_ALTERNATIVE);

    // Фиксируем причину дефекта: не будь этой строки, тест ниже выглядел бы
    // проверкой очевидного и однажды был бы «упрощён».
    expect(parsed.text ?? '').toBe('');
    expect(extractPlainText(parsed)).toContain('Волоколамское ш., вл. 93-97');
  });

  it('html внутри multipart/mixed рядом с вложением — тоже даёт текст', async () => {
    const parsed = await simpleParser(
      eml([
        'From: snab@podryad.ru',
        'Subject: UPD',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="m1"',
        '',
        '--m1',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<div>Объект: ЗИЛ33</div>',
        '--m1',
        'Content-Type: application/pdf',
        'Content-Disposition: attachment; filename="upd.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('%PDF-1.4 fake').toString('base64'),
        '--m1--',
        '',
      ]),
    );

    expect(extractPlainText(parsed)).toContain('Объект: ЗИЛ33');
  });

  it('обычное text/plain письмо не меняется', async () => {
    const parsed = await simpleParser(
      eml([
        'From: snab@podryad.ru',
        'Subject: UPD',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Объект: ЗИЛ33',
        'Дата поставки: 05.08.2026',
        '',
      ]),
    );

    const text = extractPlainText(parsed);
    expect(text).toContain('Объект: ЗИЛ33');
    expect(text).toContain('Дата поставки: 05.08.2026');
  });

  it('кириллица в windows-1251 не превращается в мусор', async () => {
    // Подрядчики шлют письма из 1С и старых клиентов — там до сих пор 1251.
    const body = Buffer.from(
      '<p>Объект: Сити Бэй-2</p>'
        .split('')
        .map((c) => {
          const code = c.charCodeAt(0);
          // А-я → 0xC0..0xFF в windows-1251.
          return code >= 0x410 && code <= 0x44f ? code - 0x410 + 0xc0 : code;
        })
        .map((c) => String.fromCharCode(c))
        .join(''),
      'latin1',
    );
    const parsed = await simpleParser(
      Buffer.concat([
        Buffer.from(
          [
            'From: snab@podryad.ru',
            'Subject: UPD',
            'MIME-Version: 1.0',
            'Content-Type: multipart/alternative; boundary="c1"',
            '',
            '--c1',
            'Content-Type: text/html; charset=windows-1251',
            '',
            '',
          ].join(CRLF),
          'utf8',
        ),
        body,
        Buffer.from(`${CRLF}--c1--${CRLF}`, 'utf8'),
      ]),
    );

    expect(extractPlainText(parsed)).toContain('Объект: Сити Бэй-2');
  });

  it('письмо совсем без текстовых частей — пустая строка, а не падение', async () => {
    const parsed = await simpleParser(
      eml([
        'From: snab@podryad.ru',
        'Subject: UPD',
        'MIME-Version: 1.0',
        'Content-Type: application/pdf',
        'Content-Disposition: attachment; filename="upd.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('%PDF-1.4 fake').toString('base64'),
        '',
      ]),
    );

    expect(extractPlainText(parsed)).toBe('');
  });

  it('разметка не просачивается: на выходе текст, а не теги', async () => {
    const parsed = await simpleParser(HTML_ONLY_ALTERNATIVE);

    const text = extractPlainText(parsed);
    expect(text).not.toContain('<p>');
    expect(text).not.toContain('<html>');
  });
});
