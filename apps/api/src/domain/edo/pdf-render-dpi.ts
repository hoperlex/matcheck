import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Адаптивный расчёт DPI для рендера PDF→PNG через pdftoppm.
 *
 * Раньше: hardcoded PDF_RENDER_DPI = 150. Для типовой А4 (595×842 pt
 * = 8.27×11.69 inch) это даёт ~1240×1754 px и ~200-400 КБ PNG —
 * норма. Но 1С/macOS Quartz иногда экспортирует сканы как
 * нестандартно большие страницы (например scanlite3.pdf — 2530×3364
 * pt = ~35×47 inch). На таких страницах 150 DPI даёт 5271×7009 px
 * и ~9 МБ PNG. Vision LLM глотает payload минутами или вообще не
 * принимает, document «висит распознаётся».
 *
 * Решение: подстраиваем DPI так, чтобы длинная сторона итогового PNG
 * не превышала {@link TARGET_LONG_EDGE_PX}. Для А4 формула даёт DPI
 * >150 → clamp'имся к MAX_DPI=150, поведение НЕ меняется (никакой
 * регрессии для рабочих кейсов). Для огромных страниц scanlite3 —
 * формула даёт ~51 DPI, итоговый PNG ~2383×1793 ≈ 2 МБ.
 *
 * MIN_DPI намеренно НЕ ставим: на аномально больших страницах
 * (специально-увеличенный «холст», на котором содержимое уже крупное)
 * клампить нижний предел заставило бы рендер всё равно > 2400 px,
 * ради сохранения «читаемости» которой по факту не теряем (содержимое
 * страницы становится мельче на холсте — но в Vision LLM оно
 * процессится тем же визуальным разрешением).
 */

// Целевой лимит длинной стороны итогового PNG в пикселях.
// Gemini-3-flash-preview обрабатывает изображения до ~3000 px без потерь;
// 2400 — безопасный запас на JPEG-decoding + transport overhead.
const TARGET_LONG_EDGE_PX = 2400;

// Верхний предел DPI — то же значение, что было в hardcoded-варианте.
// Для типовых страниц до A4 формула даёт > 150 — клампим, поведение НЕ меняется.
const MAX_DPI = 150;

// Минимально-разумный DPI: ниже этого порога pdftoppm может выдать
// нечитаемый шум на маленьком тексте. Активен только для аномально
// больших страниц, где формула возвращает что-то совсем низкое.
const MIN_DPI = 36;

const PDFINFO_TIMEOUT_MS = 5_000;

/**
 * Вычисляет оптимальный DPI для рендера PDF→PNG.
 * Под капотом: вызывает `pdfinfo`, парсит размер первой страницы,
 * считает DPI = TARGET_LONG_EDGE_PX / max(w_inch, h_inch), клампит.
 *
 * При любой ошибке pdfinfo (повреждённый PDF, нет poppler, таймаут) —
 * возвращает {@link MAX_DPI} как безопасный fallback (поведение
 * идентичное hardcoded-варианту до этой правки, нулевая регрессия).
 */
export async function computePdfRenderDpi(pdfBuffer: Buffer): Promise<number> {
  try {
    const info = await runPdfinfo(pdfBuffer);
    const size = parsePageSize(info);
    if (!size) return MAX_DPI;
    const longestPts = Math.max(size.widthPts, size.heightPts);
    const longestInch = longestPts / 72; // pdf points = 1/72 inch
    if (longestInch <= 0) return MAX_DPI;
    const computed = Math.floor(TARGET_LONG_EDGE_PX / longestInch);
    if (!Number.isFinite(computed)) return MAX_DPI;
    return Math.min(MAX_DPI, Math.max(MIN_DPI, computed));
  } catch {
    return MAX_DPI;
  }
}

async function runPdfinfo(pdfBuffer: Buffer): Promise<string> {
  // pdfinfo читает PDF только из файла (или stdin при `-`); кладём в tmp.
  const dir = await mkdtemp(join(tmpdir(), 'pdfinfo-'));
  const path = join(dir, 'in.pdf');
  try {
    await writeFile(path, pdfBuffer);
    return await new Promise<string>((resolve, reject) => {
      const proc = spawn('pdfinfo', [path], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('pdfinfo timeout'));
      }, PDFINFO_TIMEOUT_MS);
      let out = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`pdfinfo exit=${code}`));
        else resolve(out);
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function parsePageSize(info: string): { widthPts: number; heightPts: number } | null {
  // Pdfinfo печатает строку вида:
  //   Page size:       595.2 x 841.92 pts (A4)
  //   Page size:       2530 x 3364 pts
  // Берём первые два числа после "Page size:".
  const m = /Page size:\s+([\d.]+)\s*x\s*([\d.]+)\s*pts/i.exec(info);
  if (!m || !m[1] || !m[2]) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { widthPts: w, heightPts: h };
}

/**
 * Экспорт констант для тестов и нижестоящих модулей,
 * чтобы захардкоженные числа не разъезжались.
 */
export const PDF_RENDER_CONSTANTS = {
  TARGET_LONG_EDGE_PX,
  MAX_DPI,
  MIN_DPI,
} as const;
