import { describe, expect, it } from 'vitest';
import { readJpegSize } from '../src/domain/photos/jpeg-size.js';

/** Сегмент вида FF <marker> <len:2> <payload>. */
function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** Тело SOF: precision, height, width, компоненты. */
function sofPayload(w: number, h: number): Buffer {
  const body = Buffer.alloc(6);
  body[0] = 8; // precision
  body.writeUInt16BE(h, 1);
  body.writeUInt16BE(w, 3);
  body[5] = 3; // число компонент
  return Buffer.concat([body, Buffer.alloc(9)]);
}

const SOI = Buffer.from([0xff, 0xd8]);
const SOS = segment(0xda, Buffer.alloc(10));
const APP0 = segment(0xe0, Buffer.concat([Buffer.from('JFIF\0'), Buffer.alloc(9)]));

describe('readJpegSize', () => {
  it('читает baseline SOF0', () => {
    const jpeg = Buffer.concat([SOI, APP0, segment(0xc0, sofPayload(2048, 1536)), SOS]);
    expect(readJpegSize(jpeg)).toEqual({ w: 2048, h: 1536 });
  });

  it('читает progressive SOF2', () => {
    const jpeg = Buffer.concat([SOI, APP0, segment(0xc2, sofPayload(800, 600)), SOS]);
    expect(readJpegSize(jpeg)).toEqual({ w: 800, h: 600 });
  });

  it('не путает EXIF-thumbnail внутри APP1 с основным кадром', () => {
    // Внутри APP1 лежит целый маленький JPEG со своим SOI и SOF0 160x120.
    const thumbnail = Buffer.concat([SOI, segment(0xc0, sofPayload(160, 120)), SOS]);
    const app1 = segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), thumbnail]));
    const jpeg = Buffer.concat([SOI, app1, segment(0xc0, sofPayload(4000, 3000)), SOS]);
    expect(readJpegSize(jpeg)).toEqual({ w: 4000, h: 3000 });
  });

  it('сообщает truncated, когда SOF не поместился в прочитанный кусок', () => {
    const bigApp1 = segment(0xe1, Buffer.alloc(4096));
    const jpeg = Buffer.concat([SOI, bigApp1, segment(0xc0, sofPayload(2048, 1536))]);
    expect(readJpegSize(jpeg.subarray(0, 1024))).toBe('truncated');
  });

  it('сообщает truncated на оборванном теле SOF', () => {
    const jpeg = Buffer.concat([SOI, APP0, segment(0xc0, sofPayload(2048, 1536))]);
    expect(readJpegSize(jpeg.subarray(0, jpeg.length - 12))).toBe('truncated');
  });

  it('сообщает not-jpeg на PNG', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    expect(readJpegSize(png)).toBe('not-jpeg');
  });

  it('сообщает not-jpeg, когда сжатые данные начались раньше SOF', () => {
    expect(readJpegSize(Buffer.concat([SOI, APP0, SOS]))).toBe('not-jpeg');
  });

  it('сообщает not-jpeg на нулевых габаритах', () => {
    const jpeg = Buffer.concat([SOI, segment(0xc0, sofPayload(0, 0)), SOS]);
    expect(readJpegSize(jpeg)).toBe('not-jpeg');
  });

  it('переживает fill-байты FF между сегментами', () => {
    const jpeg = Buffer.concat([
      SOI,
      APP0,
      Buffer.from([0xff, 0xff]),
      segment(0xc0, sofPayload(1024, 768)),
      SOS,
    ]);
    expect(readJpegSize(jpeg)).toEqual({ w: 1024, h: 768 });
  });
});
