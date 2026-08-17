/**
 * Определение формата картинки по сигнатуре.
 *
 * Зачем по байтам, а не по mime и не по имени. Публичная форма присылает тот
 * mime, который назвал браузер, почта — сплошь `application/octet-stream`, а
 * телефоны переименовывают файлы как угодно. Ошибиться здесь дорого: WebP и
 * HEIC уходят внешнему декодеру, всё остальное — в Jimp, и промах означает
 * либо падение разбора, либо лишний процесс на каждой странице.
 *
 * История: WebP-фотография в комплекте роняла сборку целиком — Jimp падал с
 * «Mime type image/webp does not support decoding», и машина разворачивалась
 * обратно в «файл = документ».
 */
import { describe, expect, it } from 'vitest';
import { isHeicBuffer, sniffImageKind } from '../src/domain/edo/page-render.js';

/** RIFF-контейнер с типом WEBP — ровно так начинается любой .webp. */
function webp(): Buffer {
  return Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP'),
    Buffer.alloc(32, 0x00),
  ]);
}

/** ISO-BMFF: длина бокса, 'ftyp', бренд. */
function heic(brand = 'heic'): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftyp'),
    Buffer.from(brand),
    Buffer.alloc(32, 0x00),
  ]);
}

describe('формат картинки определяется по сигнатуре', () => {
  it('WebP узнаётся по RIFF….WEBP', () => {
    expect(sniffImageKind(webp())).toBe('webp');
  });

  it('HEIC узнаётся по ftyp и бренду — во всех вариантах, что шлют телефоны', () => {
    for (const brand of ['heic', 'heix', 'hevc', 'heim', 'mif1', 'msf1']) {
      expect(sniffImageKind(heic(brand))).toBe('heic');
      expect(isHeicBuffer(heic(brand))).toBe(true);
    }
  });

  it('JPEG и PNG идут прежним путём — через Jimp', () => {
    // Регрессия здесь дороже самой фичи: этими форматами приходит почти всё.
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 0x00)]);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32, 0x00),
    ]);

    expect(sniffImageKind(jpeg)).toBe('jimp');
    expect(sniffImageKind(png)).toBe('jimp');
    expect(isHeicBuffer(jpeg)).toBe(false);
  });

  it('RIFF без WEBP — не webp: так выглядит, например, wav', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE'),
      Buffer.alloc(32, 0x00),
    ]);

    expect(sniffImageKind(wav)).toBe('jimp');
  });

  it('ftyp с чужим брендом — не heic: mp4 начинается так же', () => {
    expect(sniffImageKind(heic('isom'))).toBe('jimp');
    expect(sniffImageKind(heic('mp42'))).toBe('jimp');
  });

  it('мусор и обрезки не роняют определение', () => {
    for (const buf of [Buffer.alloc(0), Buffer.from('RIFF'), Buffer.from([0x00, 0x01]), Buffer.alloc(11, 0x41)]) {
      expect(sniffImageKind(buf)).toBe('jimp');
      expect(isHeicBuffer(buf)).toBe(false);
    }
  });
});
