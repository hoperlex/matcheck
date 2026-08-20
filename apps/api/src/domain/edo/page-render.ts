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
import { computePdfRenderDpi, PDF_RENDER_CONSTANTS } from './pdf-render-dpi.js';

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
/**
 * Формат картинки по СИГНАТУРЕ файла, а не по имени и не по mime.
 *
 * И то, и другое приходит недостоверным: почта отдаёт вложения с
 * `application/octet-stream`, публичная форма — с тем mime, который назвал
 * браузер, а телефоны переименовывают файлы как угодно. Единственный надёжный
 * источник — первые байты.
 *
 * Возвращает 'jimp' для всего, что Jimp читает сам (JPEG, PNG, BMP, TIFF, GIF).
 */
export function sniffImageKind(buf: Buffer): 'webp' | 'heic' | 'jimp' {
  // RIFF....WEBP — контейнер RIFF с типом WEBP на 8-м байте.
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  // ....ftyp<бренд> — ISO-BMFF. Тот же список брендов, что у почтового
  // фильтра вложений (attachment-filter.ts): держать два разных набора значило
  // бы принимать файл на входе и не понимать его при разборе.
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12).toLowerCase();
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1', 'hevx'].includes(brand)) {
      return 'heic';
    }
  }
  return 'jimp';
}

/**
 * HEIC ли это — по сигнатуре.
 *
 * Нужен одиночному vision-пути: модель HEIC не принимает, и файл приводится к
 * PNG до проверки формата. Отдельная функция, а не сравнение с результатом
 * sniffImageKind у вызывающего, — чтобы список брендов жил в одном месте.
 */
export function isHeicBuffer(buf: Buffer): boolean {
  return sniffImageKind(buf) === 'heic';
}

/** Сколько ждём внешний декодер картинки. Секунды на файл — с запасом. */
const IMAGE_DECODE_TIMEOUT_MS = 30_000;

/**
 * Потолок на выход декодера.
 *
 * Картинка на 20000×20000 пикселей весит в PNG сотни мегабайт и кладёт воркер
 * на memcpy раньше, чем дойдёт до модели. Ограничение проверяется ПОСЛЕ
 * декодирования, потому что до него размер в пикселях неизвестен: сжатый webp
 * на пару мегабайт разворачивается во что угодно.
 */
const MAX_DECODED_PIXELS = 50_000_000;

/**
 * Декодирование системным конвертером — тем же способом, что renderPdf зовёт
 * pdftoppm: spawn без shell, временный каталог с гарантированной уборкой,
 * таймаут с SIGKILL и обрезанный stderr.
 */
async function decodeViaTool(
  buf: Buffer,
  tool: 'dwebp' | 'heif-convert',
  inExt: string,
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'img-decode-'));
  try {
    const inPath = join(dir, `in.${inExt}`);
    const outPath = join(dir, 'out.png');
    await writeFile(inPath, buf);

    // Порядок аргументов у конвертеров разный: dwebp принимает -o, heif-convert
    // ждёт выходной файл позиционно.
    const args = tool === 'dwebp' ? [inPath, '-o', outPath] : [inPath, outPath];

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(tool, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`${tool}: таймаут декодирования`));
      }, IMAGE_DECODE_TIMEOUT_MS);
      proc.stderr.on('data', (c: Buffer) => {
        // Ограничиваем: у битого файла конвертер сыплет мегабайтами предупреждений.
        if (stderr.length < 4096) stderr += c.toString('utf8');
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        // ENOENT здесь — не «файл плохой», а «в образе нет пакета». Разница
        // важна: первое чинит пользователь, второе — Dockerfile.
        const hint =
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? `требуется ${tool} (пакет ${tool === 'dwebp' ? 'libwebp-tools' : 'libheif-tools'})`
            : err.message;
        reject(new Error(`${tool} не запустился: ${hint}`));
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`${tool} exit=${code}: ${stderr.slice(0, 200)}`));
        else resolve();
      });
    });

    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Картинка → PNG.
 *
 * WebP и HEIC декодируются внешним конвертером: Jimp их не читает вовсе и
 * падает с «Mime type image/webp does not support decoding». В сборке машины
 * это ронял весь комплект — одна фотография в webp разворачивала пакет обратно
 * в «файл = документ» и разрушала группировку.
 *
 * Всё остальное по-прежнему идёт через Jimp, включая применение EXIF
 * Orientation при декодировании JPEG.
 */
export async function imageToPng(buf: Buffer): Promise<Buffer> {
  const img = await decodeImage(buf);
  return (await img.getBuffer('image/png')) as Buffer;
}

/**
 * Страница для vision — то же, что imageToPng, но с потолком разрешения.
 *
 * Фотография с телефона это 12 Мп, и в PNG она разворачивается в 10-25 МБ:
 * base64 такой страницы не влезает в тело запроса, OpenRouter отвечает
 * 413 Request Entity Too Large, а документ навсегда остаётся «в очереди».
 * Ровно от этого уже защищён PDF-путь — computePdfRenderDpi подбирает DPI под
 * TARGET_LONG_EDGE_PX; здесь тот же потолок и то же число, чтобы два пути не
 * разъезжались.
 *
 * Кадры мельче потолка не трогаются вовсе: всё, что распознаётся сегодня,
 * доходит до модели в прежнем виде.
 */
export async function imageToVisionPage(buf: Buffer): Promise<Buffer> {
  const img = await decodeImage(buf);
  const longEdge = Math.max(img.bitmap.width, img.bitmap.height);
  if (longEdge > PDF_RENDER_CONSTANTS.TARGET_LONG_EDGE_PX) {
    // Пропорции считает сам Jimp: задаём только ту сторону, что длиннее.
    img.resize(
      img.bitmap.width >= img.bitmap.height
        ? { w: PDF_RENDER_CONSTANTS.TARGET_LONG_EDGE_PX }
        : { h: PDF_RENDER_CONSTANTS.TARGET_LONG_EDGE_PX },
    );
  }
  return (await img.getBuffer('image/png')) as Buffer;
}

/**
 * Перекодирование готовой страницы в JPEG — последняя ступень подгонки тела
 * запроса к vision-провайдеру.
 *
 * Применяется только когда кадр уже ужат до потолка разрешения, а тело всё
 * равно не влезает: PNG у фотографии сжимается плохо, и JPEG той же страницы
 * меньше в разы. Качество и масштаб задаёт вызывающий — он же знает, сколько
 * ещё надо срезать.
 */
export async function recodePageToJpeg(
  page: Buffer,
  opts: { quality: number; scale?: number },
): Promise<Buffer> {
  const img = await Jimp.read(page);
  const scale = opts.scale ?? 1;
  if (scale < 1) {
    img.resize({ w: Math.max(1, Math.round(img.bitmap.width * scale)) });
  }
  return (await img.getBuffer('image/jpeg', { quality: opts.quality })) as Buffer;
}

/**
 * Общий декод для обеих функций выше: внешний конвертер для webp/heic,
 * Jimp для остального, проверка предела пикселей.
 */
async function decodeImage(buf: Buffer) {
  const kind = sniffImageKind(buf);
  // Внешний конвертер отдаёт готовый PNG, но прогон через Jimp обязателен:
  // он нормализует результат так же, как для остальных форматов, и заодно
  // даёт размеры для проверки лимита.
  const decoded = kind === 'jimp' ? buf : await decodeViaTool(buf, kind === 'webp' ? 'dwebp' : 'heif-convert', kind);

  const img = await Jimp.read(decoded);
  const pixels = img.bitmap.width * img.bitmap.height;
  if (pixels > MAX_DECODED_PIXELS) {
    throw new Error(
      `картинка ${img.bitmap.width}×${img.bitmap.height} превышает предел ${MAX_DECODED_PIXELS} пикселей`,
    );
  }
  return img;
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

