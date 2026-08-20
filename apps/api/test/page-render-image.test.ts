// Нормализация фотографий перед vision: EXIF-поворот и перекодирование в PNG.
//
// Проверяется на настоящих байтах, а не на моках: телефон пишет ориентацию
// тегом, пиксели при этом лежат «боком», и ошибка здесь означает, что модель
// получит повёрнутую страницу — распознавание таблицы позиций после этого
// разваливается.
import { describe, expect, it } from 'vitest';
import { Jimp } from 'jimp';
import {
  imageToPng,
  imageToVisionPage,
  readJpegOrientation,
  recodePageToJpeg,
  toClassifyThumb,
} from '../src/domain/edo/page-render.js';
import { PDF_RENDER_CONSTANTS } from '../src/domain/edo/pdf-render-dpi.js';

/** JPEG заданного размера. Без EXIF — jimp его не пишет. */
async function makeJpeg(width: number, height: number): Promise<Buffer> {
  const img = new Jimp({ width, height, color: 0xff0000ff });
  return (await img.getBuffer('image/jpeg')) as Buffer;
}

/**
 * Вставляет APP1-сегмент с EXIF Orientation в готовый JPEG.
 *
 * Собирается вручную: тестовых фикстур с нужной ориентацией в репозитории нет,
 * а зависеть от внешнего файла ради двух байт незачем.
 */
function withOrientation(jpeg: Buffer, orientation: number): Buffer {
  // TIFF-заголовок (8 байт) + число записей IFD0 (2 байта); дальше сразу идёт
  // сама запись — смещение IFD0 указывает на её счётчик.
  const tiff = Buffer.alloc(10);
  tiff.write('II', 0, 'ascii'); // little-endian
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // offset IFD0
  tiff.writeUInt16LE(1, 8); // одна запись
  const entry = Buffer.alloc(12);
  entry.writeUInt16LE(0x0112, 0); // тег Orientation
  entry.writeUInt16LE(3, 2); // SHORT
  entry.writeUInt32LE(1, 4); // count
  entry.writeUInt16LE(orientation, 8);
  const ifd = Buffer.concat([tiff, entry, Buffer.alloc(4)]);

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), ifd]);
  const app1 = Buffer.alloc(4);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);
  // SOI остаётся первым, APP1 вставляется сразу за ним.
  return Buffer.concat([jpeg.subarray(0, 2), app1, payload, jpeg.subarray(2)]);
}

describe('readJpegOrientation', () => {
  it('читает ориентацию из APP1', async () => {
    const jpeg = withOrientation(await makeJpeg(20, 10), 6);
    expect(readJpegOrientation(jpeg)).toBe(6);
  });

  it('без тега возвращает 0', async () => {
    expect(readJpegOrientation(await makeJpeg(20, 10))).toBe(0);
  });

  it('не-JPEG не разбирает', async () => {
    const png = (await new Jimp({ width: 4, height: 4, color: 0x00ff00ff }).getBuffer(
      'image/png',
    )) as Buffer;
    expect(readJpegOrientation(png)).toBe(0);
  });
});

describe('imageToPng', () => {
  it('перекодирует JPEG в PNG', async () => {
    const out = await imageToPng(await makeJpeg(20, 10));
    // Сигнатура PNG: vision-хелперы объявляют буфер как image/png, и отдать
    // туда JPEG значит соврать про MIME.
    expect(out.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('снимок «боком» (Orientation=6) выпрямляется ровно один раз', async () => {
    // Ключевой инвариант: поворот делает jimp при декодировании. Если добавить
    // свой поверх, страница ляжет набок — и таблица позиций перестанет
    // читаться. 20×10 с ориентацией 6 обязано стать 10×20, а не вернуться к
    // 20×10 после двойного разворота.
    const jpeg = withOrientation(await makeJpeg(20, 10), 6);
    const img = await Jimp.read(await imageToPng(jpeg));
    expect([img.bitmap.width, img.bitmap.height]).toEqual([10, 20]);
  });

  it('ориентация 1 оставляет кадр как есть', async () => {
    const jpeg = withOrientation(await makeJpeg(20, 10), 1);
    const img = await Jimp.read(await imageToPng(jpeg));
    expect([img.bitmap.width, img.bitmap.height]).toEqual([20, 10]);
  });

  it('снимок без EXIF проходит без изменения размеров', async () => {
    const img = await Jimp.read(await imageToPng(await makeJpeg(20, 10)));
    expect([img.bitmap.width, img.bitmap.height]).toEqual([20, 10]);
  });
});

describe('imageToVisionPage', () => {
  const CAP = PDF_RENDER_CONSTANTS.TARGET_LONG_EDGE_PX;

  it('кадр меньше потолка не трогается вовсе', async () => {
    // Гарантия отсутствия регрессии: всё, что распознаётся сегодня, доезжает
    // до модели тем же кадром, что и раньше. Сравниваем не только размеры, но
    // и байты с imageToPng — путь подготовки страницы обязан совпасть.
    const jpeg = await makeJpeg(1200, 800);
    const capped = await imageToVisionPage(jpeg);
    expect(capped.equals(await imageToPng(jpeg))).toBe(true);

    const img = await Jimp.read(capped);
    expect([img.bitmap.width, img.bitmap.height]).toEqual([1200, 800]);
  });

  it('портретный кадр выше потолка ужимается по высоте с сохранением пропорций', async () => {
    const tall = (await new Jimp({ width: 1500, height: 3000, color: 0xff0000ff }).getBuffer(
      'image/png',
    )) as Buffer;
    const img = await Jimp.read(await imageToVisionPage(tall));
    expect(img.bitmap.height).toBe(CAP);
    expect(img.bitmap.width).toBe(CAP / 2);
  });

  it('альбомный кадр выше потолка ужимается по ширине с сохранением пропорций', async () => {
    const wide = (await new Jimp({ width: 4000, height: 2000, color: 0xff0000ff }).getBuffer(
      'image/png',
    )) as Buffer;
    const img = await Jimp.read(await imageToVisionPage(wide));
    expect(img.bitmap.width).toBe(CAP);
    expect(img.bitmap.height).toBe(CAP / 2);
  });

  it('отдаёт PNG и выпрямляет снимок «боком»', async () => {
    const jpeg = withOrientation(await makeJpeg(20, 10), 6);
    const out = await imageToVisionPage(jpeg);
    expect(out.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const img = await Jimp.read(out);
    expect([img.bitmap.width, img.bitmap.height]).toEqual([10, 20]);
  });
});

describe('recodePageToJpeg', () => {
  it('отдаёт JPEG и уменьшает кадр по scale', async () => {
    const png = (await new Jimp({ width: 800, height: 400, color: 0x00ff00ff }).getBuffer(
      'image/png',
    )) as Buffer;
    const out = await recodePageToJpeg(png, { quality: 85, scale: 0.5 });
    expect(out.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    const img = await Jimp.read(out);
    expect([img.bitmap.width, img.bitmap.height]).toEqual([400, 200]);
  });

  it('без scale размер кадра не меняется', async () => {
    const png = (await new Jimp({ width: 300, height: 200, color: 0x00ff00ff }).getBuffer(
      'image/png',
    )) as Buffer;
    const img = await Jimp.read(await recodePageToJpeg(png, { quality: 90 }));
    expect([img.bitmap.width, img.bitmap.height]).toEqual([300, 200]);
  });
});

describe('toClassifyThumb', () => {
  it('сжимает широкий кадр и оставляет узкий', async () => {
    const wide = (await new Jimp({ width: 2000, height: 1000, color: 0xff0000ff }).getBuffer(
      'image/png',
    )) as Buffer;
    const thumb = await Jimp.read(await toClassifyThumb(wide));
    expect(thumb.bitmap.width).toBe(700);

    const narrow = (await new Jimp({ width: 300, height: 200, color: 0xff0000ff }).getBuffer(
      'image/png',
    )) as Buffer;
    const kept = await Jimp.read(await toClassifyThumb(narrow));
    expect(kept.bitmap.width).toBe(300);
  });
});
