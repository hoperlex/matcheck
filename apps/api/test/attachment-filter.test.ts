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

/**
 * Файл, на котором держится смысл теста, берётся по ТОЧНОМУ имени и с проверкой
 * размера: «первый подходящий по расширению» однажды сменится, и тест тихо
 * потеряет смысл, оставаясь зелёным.
 */
function readExact(name: string, expectedBytes: number): Buffer {
  const buf = read(name);
  if (buf.length !== expectedBytes) {
    throw new Error(`${name}: ожидалось ${expectedBytes} Б, получено ${buf.length} Б`);
  }
  return buf;
}

const REAL_PDF = read('зиларт.pdf');
const REAL_JPEG = readExact('5303397567129394215.jpg', 139_301);
const REAL_XLSX = readFirstByExt('.xlsx');
const REAL_XLS = readFirstByExt('.xls');
/** Самый лёгкий настоящий документ корпуса — легче порога подписи. */
const SMALL_XLSX = readExact('Т56532_20260622112337_Подтверждение_отгрузки.XLSX', 10_077);

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

describe('мелкие картинки — подпись, а не документ', () => {
  const small = png(8 * 1024);
  const classify = (over: { filename?: string; buffer?: Buffer; mime?: string } = {}) =>
    classifyAttachment({
      filename: over.filename ?? 'скан.png',
      declaredMime: over.mime ?? 'image/png',
      buffer: over.buffer ?? small,
    });

  it('иконка из multipart/mixed без Content-ID помечается', () => {
    // Ровно тот случай, что ушёл в прод: прежнее условие требовало признаков
    // MIME-структуры, а Outlook кладёт иконки подписи без Content-ID — и 43
    // картинки от 121 байта уехали в распознавание как документы.
    const v = classifyAttachment({
      filename: 'image003.png',
      declaredMime: 'image/png',
      buffer: png(6 * 1024),
    });
    expect(v).toMatchObject({ state: 'suspected_signature', reason: 'small_image' });
  });

  it('граница порога: на байт меньше — подпись, ровно порог — документ', () => {
    const limit = DEFAULT_ATTACHMENT_LIMITS.signatureMaxBytes;
    expect(classify({ buffer: png(limit - 1) }).state).toBe('suspected_signature');
    expect(classify({ buffer: png(limit) }).state).toBe('kept');
  });

  it('порог берётся из лимитов, а не зашит в код', () => {
    const v = classifyAttachment(
      { filename: 'скан.jpg', declaredMime: 'image/jpeg', buffer: REAL_JPEG },
      { ...DEFAULT_ATTACHMENT_LIMITS, signatureMaxBytes: 200 * 1024 },
    );
    expect(v.state).toBe('suspected_signature');
  });

  it('реальный скан УПД остаётся документом', () => {
    expect(classify({ filename: 'скан.jpg', mime: 'image/jpeg', buffer: REAL_JPEG }).state).toBe(
      'kept',
    );
  });

  it('реальный xlsx на 10 КБ остаётся документом', () => {
    // Порог применяется ТОЛЬКО к картинкам: самое лёгкое подтверждение отгрузки
    // весит меньше иконки подписи, и потерять его нельзя.
    expect(SMALL_XLSX.length).toBeLessThan(DEFAULT_ATTACHMENT_LIMITS.signatureMaxBytes);
    const v = classifyAttachment({
      filename: 'Подтверждение_отгрузки.XLSX',
      declaredMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: SMALL_XLSX,
    });
    expect(v.state).toBe('kept');
  });

  it('мелкий PDF остаётся документом', () => {
    const tinyPdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1024, 0x20)]);
    expect(classify({ filename: 'счёт.pdf', mime: 'application/pdf', buffer: tinyPdf }).state).toBe(
      'kept',
    );
  });

  it('штамп почтового клиента — подпись независимо от размера', () => {
    // На проде такие «эмодзи» весят 174 КБ и приходят по восемь штук на письмо.
    const v = classify({
      filename: 'OutlookEmoji-1756819099770fa910edb.jpg',
      mime: 'image/jpeg',
      buffer: REAL_JPEG,
    });
    expect(v).toMatchObject({ state: 'suspected_signature', reason: 'mail_client_stamp' });
    expect(classify({ filename: 'mailrusigimg_4821.png', buffer: png(200 * 1024) }).state).toBe(
      'suspected_signature',
    );
  });

  it('имя image00N само по себе документ не отбрасывает', () => {
    // Outlook даёт такое имя и вставленному в тело скану: в проде есть
    // image008.jpg на 82 КБ, и это может быть фотография документа.
    expect(classify({ filename: 'image002.png', buffer: png(200 * 1024) }).state).toBe('kept');
  });

  it('обычное имя того же размера — документ', () => {
    // Ловит неякорную регулярку: «скан-outlookemoji» подписью быть не должен.
    expect(
      classify({ filename: 'скан-outlookemoji.jpg', mime: 'image/jpeg', buffer: REAL_JPEG }).state,
    ).toBe('kept');
  });

  it('непригодный тип остаётся отброшенным, а не подписью', () => {
    // Порядок проверок: тип решается раньше подписи.
    const exe = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(2048, 0)]);
    expect(classifyAttachment({ filename: 'a.png', declaredMime: 'image/png', buffer: exe })).toMatchObject(
      { state: 'skipped', reason: 'unsupported_type' },
    );
  });

  it('пустое вложение — отброшено, а не подпись', () => {
    expect(
      classifyAttachment({ filename: 'empty.png', declaredMime: 'image/png', buffer: Buffer.alloc(0) }),
    ).toMatchObject({ state: 'skipped', reason: 'empty' });
  });
});
