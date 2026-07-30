/**
 * Фильтр вложений письма.
 *
 * Письма приходят от любого отправителя, поэтому вложения — недоверенный вход.
 * Здесь проверяется главное: тип определяется содержимым (переименованный скан
 * не теряется), zip-бомба не проходит, а настоящий документ не отбрасывается
 * из-за похожести на подпись.
 *
 * PDF, JPEG и XLSX берутся РЕАЛЬНЫЕ из docs/debug-upd — на синтетике легко
 * получить фильтр, который «работает» только на своих же заглушках.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyAttachment,
  inspectZip,
  sniffMime,
  DEFAULT_ATTACHMENT_LIMITS,
} from '../src/domain/mail/attachment-filter.js';

const CORPUS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/debug-upd');
const read = (name: string) => readFileSync(path.join(CORPUS, name));

/**
 * Файлы корпуса берём по расширению, а не по точному имени: там встречаются
 * пробелы и юникод-нюансы, а состав каталога со временем меняется.
 */
function readFirstByExt(ext: string): Buffer {
  const name = readdirSync(CORPUS)
    .filter((f) => f.toLowerCase().endsWith(ext))
    .sort((a, b) => a.localeCompare(b, 'en'))[0];
  if (!name) throw new Error(`в docs/debug-upd нет файла ${ext}`);
  return read(name);
}

const REAL_PDF = read('зиларт.pdf');
const REAL_JPEG = read('5303397567129394215.jpg');
const REAL_XLSX = readFirstByExt('.xlsx');
const REAL_XLS = readFirstByExt('.xls');

/** Минимальный PNG (8-байтовая сигнатура + добивка до нужного размера). */
function png(size: number): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0x11)]);
}

/**
 * Собирает ZIP с заданными размерами в central directory. Данные внутри
 * неважны: фильтр смотрит объявленные размеры, не распаковывая архив, — именно
 * так zip-бомба и обнаруживается до расхода памяти.
 */
function makeZip(entries: { compressed: number; uncompressed: number }[]): Buffer {
  const parts: Buffer[] = [];
  const cd: Buffer[] = [];
  let offset = 0;

  entries.forEach((e, i) => {
    const name = Buffer.from(`e${i}.xml`);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(name.length, 26);
    const payload = Buffer.alloc(Math.min(e.compressed, 64), 0x41);
    parts.push(local, name, payload);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt32LE(e.compressed, 20);
    entry.writeUInt32LE(e.uncompressed, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    cd.push(entry, name);

    offset += local.length + name.length + payload.length;
  });

  const body = Buffer.concat(parts);
  const dir = Buffer.concat(cd);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, dir, eocd]);
}

describe('определение типа по содержимому', () => {
  it('реальные документы корпуса', () => {
    expect(sniffMime(REAL_PDF)).toBe('application/pdf');
    expect(sniffMime(REAL_JPEG)).toBe('image/jpeg');
    expect(sniffMime(REAL_XLSX)).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(sniffMime(REAL_XLS)).toBe('application/vnd.ms-excel');
    expect(sniffMime(png(64))).toBe('image/png');
  });

  it('неопознанное содержимое → null', () => {
    expect(sniffMime(Buffer.from('просто текст письма'))).toBeNull();
    expect(sniffMime(Buffer.alloc(2))).toBeNull();
  });
});

describe('содержимое важнее расширения', () => {
  it('JPEG под именем .pdf принимается как изображение', () => {
    // Подрядчики переименовывают файлы — это норма, терять такое нельзя.
    const v = classifyAttachment({
      filename: 'скан упд.pdf',
      declaredMime: 'application/pdf',
      buffer: REAL_JPEG,
    });
    expect(v).toMatchObject({ state: 'kept', sniffedMime: 'image/jpeg' });
  });

  it('исполняемый файл под именем .pdf отбрасывается', () => {
    const exe = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(2048)]);
    const v = classifyAttachment({
      filename: 'накладная.pdf',
      declaredMime: 'application/pdf',
      buffer: exe,
    });
    expect(v).toMatchObject({ state: 'skipped', reason: 'unsupported_type' });
  });

  it('пустое вложение отбрасывается', () => {
    const v = classifyAttachment({ filename: 'a.pdf', declaredMime: null, buffer: Buffer.alloc(0) });
    expect(v).toMatchObject({ state: 'skipped', reason: 'empty' });
  });

  it('слишком большое вложение отбрасывается по размеру', () => {
    const v = classifyAttachment(
      { filename: 'big.pdf', declaredMime: null, buffer: REAL_PDF },
      { ...DEFAULT_ATTACHMENT_LIMITS, maxBytes: 1024 },
    );
    expect(v).toMatchObject({ state: 'skipped', reason: 'too_large' });
  });
});

describe('xlsx как ZIP-контейнер', () => {
  it('реальный xlsx проходит проверки', () => {
    const v = classifyAttachment({
      filename: 'упд.xlsx',
      declaredMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: REAL_XLSX,
    });
    expect(v.state).toBe('kept');
  });

  it('реальный xlsx: размеры читаются без распаковки', () => {
    const z = inspectZip(REAL_XLSX);
    expect(z.ok).toBe(true);
    if (z.ok) {
      expect(z.entries).toBeGreaterThan(0);
      expect(z.inflated).toBeGreaterThan(z.compressed);
      expect(z.ratio).toBeLessThan(DEFAULT_ATTACHMENT_LIMITS.xlsxMaxRatio);
    }
  });

  it('zip-бомба ловится по ratio, даже когда влезает в лимит объёма', () => {
    // 1 КБ → 50 МБ: абсолютный объём внутри лимита (100 МБ), то есть проверка
    // объёма такую бомбу пропустит — её берёт именно степень сжатия.
    const bomb = makeZip([{ compressed: 1024, uncompressed: 50 * 1024 * 1024 }]);
    const v = classifyAttachment({ filename: 'упд.xlsx', declaredMime: null, buffer: bomb });
    expect(v).toMatchObject({ state: 'skipped', reason: 'xlsx_ratio_suspicious' });
  });

  it('гигабайтная бомба отбрасывается по объёму', () => {
    const bomb = makeZip([{ compressed: 40 * 1024, uncompressed: 1024 * 1024 * 1024 }]);
    const v = classifyAttachment({ filename: 'упд.xlsx', declaredMime: null, buffer: bomb });
    expect(v).toMatchObject({ state: 'skipped', reason: 'xlsx_inflated_too_large' });
  });

  it('распакованный объём выше лимита → отбрасывается', () => {
    // Ratio в норме, ловит именно лимит объёма.
    const big = makeZip([{ compressed: 60 * 1024 * 1024, uncompressed: 120 * 1024 * 1024 }]);
    const v = classifyAttachment({ filename: 'упд.xlsx', declaredMime: null, buffer: big });
    expect(v).toMatchObject({ state: 'skipped', reason: 'xlsx_inflated_too_large' });
  });

  it('слишком много элементов внутри → отбрасывается', () => {
    const many = makeZip(
      Array.from({ length: 600 }, () => ({ compressed: 10, uncompressed: 20 })),
    );
    const v = classifyAttachment({ filename: 'упд.xlsx', declaredMime: null, buffer: many });
    expect(v).toMatchObject({ state: 'skipped', reason: 'xlsx_too_many_entries' });
  });

  it('битый контейнер без central directory', () => {
    const broken = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(500, 7)]);
    expect(inspectZip(broken).ok).toBe(false);
    const v = classifyAttachment({ filename: 'упд.xlsx', declaredMime: null, buffer: broken });
    expect(v.state).toBe('skipped');
  });
});

describe('подписи отсеиваются только по совокупности признаков', () => {
  const small = png(8 * 1024);

  it('мелкая картинка + related + ссылка из html → подозрение на подпись', () => {
    const v = classifyAttachment({
      filename: 'image001.png',
      declaredMime: 'image/png',
      buffer: small,
      isRelated: true,
      cidReferenced: true,
    });
    expect(v).toMatchObject({ state: 'suspected_signature' });
  });

  it('мелкая картинка без ссылки из html остаётся документом', () => {
    // Настоящий скан бывает мелким — одного размера недостаточно.
    const v = classifyAttachment({
      filename: 'скан.png',
      declaredMime: 'image/png',
      buffer: small,
      isRelated: true,
      cidReferenced: false,
    });
    expect(v.state).toBe('kept');
  });

  it('мелкая картинка вне multipart/related остаётся документом', () => {
    const v = classifyAttachment({
      filename: 'скан.png',
      declaredMime: 'image/png',
      buffer: small,
      isRelated: false,
      cidReferenced: true,
    });
    expect(v.state).toBe('kept');
  });

  it('крупная картинка из вёрстки остаётся документом', () => {
    const v = classifyAttachment({
      filename: 'image002.png',
      declaredMime: 'image/png',
      buffer: png(200 * 1024),
      isRelated: true,
      cidReferenced: true,
    });
    expect(v.state).toBe('kept');
  });

  it('реальный скан УПД не путается с подписью', () => {
    const v = classifyAttachment({
      filename: 'скан.jpg',
      declaredMime: 'image/jpeg',
      buffer: REAL_JPEG,
      isRelated: true,
      cidReferenced: true,
    });
    expect(v.state).toBe('kept');
  });
});
