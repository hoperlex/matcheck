import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Excel (.xls / .xlsx) → PNG через LibreOffice headless + pdftoppm.
 *
 * Зачем: parseUpdXlsx (ExcelJS) не всегда понимает шаблон УПД (особенно
 * нетипичные формы 1С / Элевел / самописные ERP). В таком случае fallback —
 * визуально отрендерить документ и отдать в Vision LLM (как для PDF-сканов).
 * Vision видит «картинку накладной», читает её и возвращает структурированные
 * позиции. Стоимость — те же ~$0.0005 за документ, что и для PDF-сканов.
 *
 * ──── ВАЖНО: opt-in pattern ────
 * Helper НЕ требует LibreOffice в Docker-образе по умолчанию. При первом
 * вызове проверяет наличие `soffice` в PATH:
 *  - если есть — конвертация работает;
 *  - если нет — бросает {@link LibreOfficeNotAvailableError}, worker
 *    делает graceful degradation (помечает partial_parse с понятной
 *    подсказкой, без BullMQ retry).
 *
 * Чтобы включить fallback на проде — добавить в apps/api/Dockerfile одну
 * строку: `apk add --no-cache libreoffice-base-core` (~150-200 МБ к
 * образу) — после чего этот helper начнёт работать без других правок.
 *
 * ──── Алгоритм ────
 *  1. mkdtemp временную директорию.
 *  2. Записать excel-буфер как `in.xls` или `in.xlsx`.
 *  3. soffice --headless --convert-to pdf → out.pdf.
 *  4. pdftoppm out.pdf → out-1.png (только первая страница: первый лист
 *     Excel практически всегда содержит шапку + табличку УПД).
 *  5. Прочитать PNG, удалить tempdir.
 *
 * Таймауты: LIBREOFFICE_CONVERT_TIMEOUT_MS = 90 с (LibreOffice
 * холодный старт ~3-5 с, конвертация типовой накладной 2-10 с).
 * Превышение → {@link ExcelConvertTimeoutError}.
 *
 * Возвращает: массив PNG-буферов. Сейчас всегда длиной 1 (первая
 * страница), но контракт под `Buffer[]` оставлен на случай будущей
 * поддержки многостраничных excel.
 */

// Таймаут на soffice — щедрый, потому что cold-start самого LO добавляет
// 3-5 с поверх типовой 2-10 с конвертации. Если документ реально требует
// больше — это аномалия (зависший soffice / гигантский файл / коррапт).
// При истечении убиваем процесс и кидаем ExcelConvertTimeoutError —
// worker помечает parse_failed без BullMQ retry, повтор той же команды
// на том же файле даст тот же результат.
const LIBREOFFICE_CONVERT_TIMEOUT_MS = 90_000;

// DPI для pdftoppm. То же значение, что в upd-vision.parser.ts —
// баланс между читаемостью текста (мелкие цифры в графах УПД)
// и размером PNG (большой PNG раздувает токены Vision и payload).
const PDF_RENDER_DPI = 150;
const PDF_RENDER_TIMEOUT_MS = 30_000;

const SOFFICE_BIN = 'soffice';

/**
 * Конвертирует Excel-буфер в массив PNG-страниц (сейчас всегда длиной 1).
 *
 * @param buffer  буфер Excel-файла (.xls BIFF / .xlsx OOXML — LibreOffice
 *                сам определит формат, расширение берётся из `ext` для
 *                подсказки конвертеру).
 * @param ext     'xls' | 'xlsx' — расширение файла для soffice (он
 *                использует его для выбора фильтра импорта).
 * @returns       массив PNG-буферов (одна или больше страниц первого
 *                листа после рендера в PDF).
 *
 * @throws {LibreOfficeNotAvailableError} — soffice не найден в PATH.
 *         Worker ловит и переводит в partial_parse с подсказкой.
 * @throws {ExcelConvertError}            — soffice/pdftoppm завершились
 *         с ошибкой (exit != 0, нет файлов на выходе и т.п.).
 * @throws {ExcelConvertTimeoutError}     — превышен лимит времени.
 */
export async function convertExcelToPng(
  buffer: Buffer,
  ext: 'xls' | 'xlsx',
): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), 'upd-excel-'));
  try {
    const inPath = join(dir, `in.${ext}`);
    await writeFile(inPath, buffer);

    await runLibreOfficeConvert(dir, inPath);

    // Имя выходного pdf — `in.pdf` (LibreOffice кладёт результат
    // в --outdir с тем же basename, расширение pdf).
    const pdfPath = join(dir, 'in.pdf');
    try {
      await readFile(pdfPath); // probe — exists?
    } catch {
      throw new ExcelConvertError(
        'LibreOffice завершился успешно, но не создал PDF-файл',
      );
    }

    return await pdfToPngs(dir, pdfPath);
  } finally {
    // best-effort cleanup. Если что-то не удалилось — это temp, ОС подметёт.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runLibreOfficeConvert(outDir: string, inPath: string): Promise<void> {
  // --headless: без GUI. --convert-to pdf: всегда пишет .pdf рядом.
  // --outdir фиксирует место — иначе LO может писать в CWD пользователя.
  const args = ['--headless', '--convert-to', 'pdf', '--outdir', outDir, inPath];
  const startMs = Date.now();
  await new Promise<void>((resolve, reject) => {
    let proc;
    try {
      proc = spawn(SOFFICE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      // Sync-throw (редко, но возможно на ENOENT на некоторых платформах).
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return reject(new LibreOfficeNotAvailableError());
      }
      return reject(new ExcelConvertError(`soffice spawn failed: ${e.message}`));
    }

    const timer = setTimeout(() => {
      proc!.kill('SIGKILL');
      reject(new ExcelConvertTimeoutError(Date.now() - startMs));
    }, LIBREOFFICE_CONVERT_TIMEOUT_MS);

    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return reject(new LibreOfficeNotAvailableError());
      }
      reject(new ExcelConvertError(`soffice не запустился: ${err.message}`));
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(
          new ExcelConvertError(
            `soffice exit=${code}: ${stderr.trim().slice(0, 300) || '(no stderr)'}`,
          ),
        );
      }
      resolve();
    });
  });
}

async function pdfToPngs(dir: string, pdfPath: string): Promise<Buffer[]> {
  // Рендерим только первую страницу (-l 1): первый лист Excel почти всегда
  // содержит шапку + табличную часть УПД целиком (или хотя бы первые позиции,
  // которых достаточно для распознавания). Если позиций больше — Vision
  // не увидит их, но это симметрично PDF-fallback'у (там тоже лимит).
  const outPrefix = join(dir, 'out');
  const args = ['-r', String(PDF_RENDER_DPI), '-png', '-f', '1', '-l', '1', pdfPath, outPrefix];

  const startMs = Date.now();
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('pdftoppm', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new ExcelConvertTimeoutError(Date.now() - startMs));
    }, PDF_RENDER_TIMEOUT_MS);

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      // ENOENT для pdftoppm — практически невозможно, потому что poppler
      // уже в Dockerfile (см. там RUN apk add poppler-utils). Но обрабатываем
      // на всякий.
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return reject(
          new ExcelConvertError(
            'pdftoppm не найден (poppler-utils отсутствует в окружении API)',
          ),
        );
      }
      reject(new ExcelConvertError(`pdftoppm не запустился: ${err.message}`));
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(
          new ExcelConvertError(
            `pdftoppm exit=${code}: ${stderr.trim().slice(0, 300) || '(no stderr)'}`,
          ),
        );
      }
      resolve();
    });
  });

  const files = (await readdir(dir))
    .filter((f) => /^out-\d+\.png$/.test(f))
    .sort((a, b) => {
      const ai = Number(a.match(/^out-(\d+)\.png$/)![1]);
      const bi = Number(b.match(/^out-(\d+)\.png$/)![1]);
      return ai - bi;
    });
  if (files.length === 0) {
    throw new ExcelConvertError('pdftoppm завершился успешно, но не создал PNG');
  }
  const pages: Buffer[] = [];
  for (const f of files) pages.push(await readFile(join(dir, f)));
  return pages;
}

/**
 * LibreOffice не установлен в окружении API (нет `soffice` в PATH).
 * Worker должен ловить эту ошибку отдельно и переводить документ в
 * partial_parse (а не parse_failed) — это не «ошибка», а «фича недоступна».
 */
export class LibreOfficeNotAvailableError extends Error {
  constructor() {
    super(
      'LibreOffice (soffice) не найден в окружении API. ' +
        'Для Excel→Vision fallback добавить в Dockerfile: ' +
        'apk add --no-cache libreoffice-base-core',
    );
    this.name = 'LibreOfficeNotAvailableError';
  }
}

/**
 * Ошибка конвертации Excel → PDF/PNG (soffice/pdftoppm вернули non-zero
 * или не создали ожидаемые файлы). Worker помечает parse_failed без retry.
 */
export class ExcelConvertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExcelConvertError';
  }
}

/**
 * Превышен таймаут конвертации (soffice или pdftoppm). Worker помечает
 * parse_failed без retry — повтор той же команды на том же файле
 * закончится тем же таймаутом.
 */
export class ExcelConvertTimeoutError extends Error {
  constructor(public readonly elapsedMs: number) {
    super(`Excel конвертация превысила таймаут (${elapsedMs} мс)`);
    this.name = 'ExcelConvertTimeoutError';
  }
}
