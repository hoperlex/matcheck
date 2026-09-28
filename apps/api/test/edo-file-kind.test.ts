/**
 * Что за файл пришёл из Диадока.
 *
 * Повод: любое вложение сохранялось как `.xml` с типом application/xml — и
 * PDF, и скан. Такой файл потом нельзя ни распознать, ни открыть, а тип в
 * хранилище уверенно врёт. Тип определяется по содержимому; имя — запасной
 * источник, его задаёт отправитель.
 */
import { describe, it, expect } from 'vitest';
import { detectEdoFile } from '../src/domain/edo/edo-file-kind.js';

const cp1251Root = Buffer.from([0x3c, 0xd4, 0xe0, 0xe9, 0xeb, 0x3e]); // «<Файл>» в windows-1251

describe('тип вложения из Диадока', () => {
  it('PDF узнаётся по содержимому, даже если имя обещает XML', () => {
    expect(detectEdoFile(Buffer.from('%PDF-1.7\n...'), 'upd.xml')).toEqual({
      mimeType: 'application/pdf',
      ext: 'pdf',
    });
  });

  it('титул УПД — XML: с декларацией, с BOM и без декларации в windows-1251', () => {
    const xml = { mimeType: 'application/xml', ext: 'xml' };
    expect(detectEdoFile(Buffer.from('<?xml version="1.0" encoding="windows-1251"?><Файл/>'), null)).toEqual(xml);
    expect(detectEdoFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<?xml?>')]), null)).toEqual(xml);
    expect(detectEdoFile(cp1251Root, null)).toEqual(xml);
  });

  it('HTML за XML не считается', () => {
    expect(detectEdoFile(Buffer.from('<!DOCTYPE html><html></html>'), null).mimeType).not.toBe(
      'application/xml',
    );
    expect(detectEdoFile(Buffer.from('<html><body/></html>'), 'письмо.htm').mimeType).not.toBe(
      'application/xml',
    );
  });

  it('картинки узнаются по сигнатуре', () => {
    expect(detectEdoFile(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'скан').ext).toBe('jpg');
    expect(
      detectEdoFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), null).ext,
    ).toBe('png');
  });

  it('ZIP-контейнер различается по имени: архив и docx не выдаются за xlsx', () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(detectEdoFile(zip, 'документы.zip')).toEqual({ mimeType: 'application/zip', ext: 'zip' });
    expect(detectEdoFile(zip, 'письмо.docx').ext).toBe('docx');
    expect(detectEdoFile(zip, 'реестр.xlsx').ext).toBe('xlsx');
  });

  it('неопознанное содержимое — по имени, иначе честный octet-stream', () => {
    const unknown = Buffer.from('просто текст без сигнатуры');
    expect(detectEdoFile(unknown, 'скан.PDF')).toEqual({ mimeType: 'application/pdf', ext: 'pdf' });
    expect(detectEdoFile(unknown, 'файл.dat')).toEqual({
      mimeType: 'application/octet-stream',
      ext: 'bin',
    });
    expect(detectEdoFile(Buffer.alloc(0), null)).toEqual({
      mimeType: 'application/octet-stream',
      ext: 'bin',
    });
  });
});
