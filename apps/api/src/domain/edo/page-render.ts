// Подготовка страниц для vision-путей: PDF → PNG и нормализация фотографий.
//
// Модуль появился, когда страницы одной УПД стало нужно собирать из РАЗНЫХ
// файлов: рендер PDF раньше жил приватно в upd-page-prefilter, а сборка
// логических документов (worker: upd_assembly) нуждается ровно в том же
// коде — с теми же DPI и таймаутами. Копия неминуемо разошлась бы с
// оригиналом, поэтому рендер вынесен сюда, а prefilter импортирует его.
//
// Второе назначение — привести вход к тому виду, который ждут vision-хелперы.
// И classifyPages, и extractUpdFromPages объявляют переданные буферы как
// image/png; фотография с телефона приезжает JPEG'ом, к тому же снятой
// «боком» с флагом EXIF Orientation вместо реального поворота пикселей.
// Отдать её как есть — значит соврать про MIME и показать модели повёрнутую
// страницу.

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Jimp } from 'jimp';
import { computePdfRenderDpi } from './pdf-render-dpi.js';

// DPI для миниатюр под классификацию страниц. Низкий — классификатору
// (upd / сертификат / накладная) не нужно высокое разрешение, а токены и
// payload-size экономятся существенно.
export const CLASSIFY_DPI = 72;

// Ширина миниатюры для классификации фотографий. A4 при CLASSIFY_DPI — это
// ~595 px по короткой стороне, и сжимать снимок сильнее нет смысла: тип
// страницы («счёт-фактура» против «сертификат») читается по крупным блокам.
const CLASSIFY_THUMB_WIDTH = 700;

const PDFTOPPM_TIMEOUT_MS = 75_000;

export type RenderOpts = { dpi?: number; firstPage?: number; lastPage?: number };

/**
 * PDF→PNG через системный pdftoppm. Гибче, чем pdfToPngsViaPoppler в
 * upd-vision.parser: умеет произвольный диапазон страниц и явный DPI
 * (для миниатюр классификации). Без явного dpi — адаптивный
 * computePdfRenderDpi (как основной рендер). Бросает Error при сбое.
 */
export async function renderPdf(pdfBuffer: Buffer, ropts: RenderOpts): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), 'upd-prefilter-'));
  try {
    const inPath = join(dir, 'in.pdf');
    const outPrefix = join(dir, 'out');
    await writeFile(inPath, pdfBuffer);

    const dpi = ropts.dpi ?? (await computePdfRenderDpi(pdfBuffer));
    const args = ['-r', String(dpi), '-png'];
    if (ropts.firstPage) args.push('-f', String(ropts.firstPage));
    if (ropts.lastPage) args.push('-l', String(ropts.lastPage));
    args.push(inPath, outPrefix);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('pdftoppm', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('pdftoppm timeout (prefilter)'));
      }, PDFTOPPM_TIMEOUT_MS);
      proc.stderr.on('data', (c: Buffer) => {
        stderr += c.toString('utf8');
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`pdftoppm не запустился (prefilter): ${err.message}`));
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0)
          reject(new Error(`pdftoppm exit=${code} (prefilter): ${stderr.slice(0, 200)}`));
        else resolve();
      });
    });

    const files = (await readdir(dir))
      .filter((f) => /^out-\d+\.png$/.test(f))
      .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]));
    const pages: Buffer[] = [];
    for (const f of files) pages.push(await readFile(join(dir, f)));
    return pages;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * EXIF Orientation (тег 0x0112) из JPEG. 1 — «как есть», 0 — тега нет либо
 * файл не JPEG.
 *
 * Сам поворот отсюда НЕ делается: jimp применяет ориентацию при декодировании
 * (проверено тестом page-render-image), и второй поворот положил бы страницу
 * обратно набок. Функция оставлена для диагностики — по ней видно, была ли у
 * снимка ориентация вообще, когда распознавание жалуется на «лежачую» таблицу.
 *
 * Парсер намеренно минимальный и терпимый: любой неожиданный байт — возврат 0.
 */
export function readJpegOrientation(buf: Buffer): number {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return 0; // не JPEG
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) return 0; // рассинхронизация маркеров
    const marker = buf[offset + 1]!;
    // SOS/EOI — дальше идут сжатые данные, метаданных больше не будет.
    if (marker === 0xda || marker === 0xd9) return 0;
    const size = buf.readUInt16BE(offset + 2);
    if (size < 2 || offset + 2 + size > buf.length) return 0;
    if (marker === 0xe1 && buf.slice(offset + 4, offset + 10).toString('ascii') === 'Exif\0\0') {
      return readOrientationFromTiff(buf, offset + 10);
    }
    offset += 2 + size;
  }
  return 0;
}

/** Разбор TIFF-заголовка внутри APP1: IFD0 → тег 0x0112. */
function readOrientationFromTiff(buf: Buffer, tiffStart: number): number {
  if (tiffStart + 8 > buf.length) return 0;
  const le = buf.slice(tiffStart, tiffStart + 2).toString('ascii') === 'II';
  const u16 = (at: number): number => (le ? buf.readUInt16LE(at) : buf.readUInt16BE(at));
  const u32 = (at: number): number => (le ? buf.readUInt32LE(at) : buf.readUInt32BE(at));
  if (u16(tiffStart + 2) !== 42) return 0;

  const ifd0 = tiffStart + u32(tiffStart + 4);
  if (ifd0 + 2 > buf.length) return 0;
  const count = u16(ifd0);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > buf.length) return 0;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 0;
    }
  }
  return 0;
}

/**
 * Приводит изображение к PNG в правильной ориентации.
 *
 * Возвращает готовый к отправке в vision буфер: и classifyPages, и
 * extractUpdFromPages кодируют вход как `data:image/png`, поэтому JPEG/WebP
 * должен быть перекодирован, а не переименован.
 *
 * Поворот по EXIF делает сам jimp при декодировании — снимок с телефона,
 * лежащий «боком» с Orientation=6, читается уже развёрнутым. Добавлять свой
 * поворот сверху нельзя: получится двойной, и страница ляжет набок.
 */
export async function imageToPng(buf: Buffer): Promise<Buffer> {
  const img = await Jimp.read(buf);
  return (await img.getBuffer('image/png')) as Buffer;
}

/**
 * Миниатюра под классификацию: тот же кадр, но узкий.
 *
 * Классификация идёт одним запросом на весь пакет — десяток снимков в полном
 * разрешении раздул бы payload на десятки мегабайт и упёрся бы в лимиты
 * провайдера. Извлечение при этом получает НЕуменьшенную страницу: там от
 * разрешения зависит, прочитаются ли цифры в таблице.
 */
export async function toClassifyThumb(png: Buffer): Promise<Buffer> {
  const img = await Jimp.read(png);
  if (img.bitmap.width > CLASSIFY_THUMB_WIDTH) {
    img.resize({ w: CLASSIFY_THUMB_WIDTH });
  }
  return (await img.getBuffer('image/png')) as Buffer;
}

