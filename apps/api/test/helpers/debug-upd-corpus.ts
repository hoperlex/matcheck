/**
 * Общий доступ к корпусу docs/debug-upd для тестов локальных парсеров.
 *
 * Живёт отдельно, потому что корпус читают двое: характеризационный baseline
 * (upd-text-parsers-characterization.test.ts) и эталон графы 4
 * (upd-consignee-expected.test.ts). Если бы каждый извлекал текст по-своему,
 * они могли бы разойтись во входных данных — и «поле изменилось» перестало бы
 * что-либо значить.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFParse } from 'pdf-parse';
import {
  countUniqueUpdInvoices,
  segmentUpdText,
} from '../../src/domain/edo/upd-text-bundle.parser.js';

export const CORPUS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/debug-upd',
);

/** Минимальная длина текстового слоя — как в parseUpdPdfLocal. */
export const MIN_TEXT_LENGTH = 200;

export type PdfPage = { num: number; text: string };

/** Тот же clean, что в parseUpdPdfLocal: тесты должны видеть вход прода. */
export function cleanPdfText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export async function pdfPages(buffer: Buffer): Promise<PdfPage[]> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return (result.pages ?? []).map((p) => ({
      num: typeof p.num === 'number' ? p.num : 0,
      text: p.text ?? '',
    }));
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/** Файлы корпуса с нужными расширениями, в фиксированном порядке. */
export async function corpusFiles(exts: readonly string[]): Promise<string[]> {
  const entries = await readdir(CORPUS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => exts.includes(path.extname(n).toLowerCase()))
    // Порядок фиксирован, иначе снимок «дрожит» между машинами.
    .sort((a, b) => a.localeCompare(b, 'en'));
}

export type PdfTextResult =
  | { kind: 'error'; error: string }
  | { kind: 'no_text'; textLength: number }
  | { kind: 'text_pdf'; text: string }
  | { kind: 'multi_upd'; segments: { segmentIndex: number; docNumber: string; pages: number[]; text: string }[] };

/**
 * Достаёт из PDF ровно то, что получил бы прод: либо цельный текст, либо
 * посегментный (пакет из нескольких УПД — тем же segmentUpdText, которым
 * пользуется tryParseTextUpdBundle).
 */
export async function readPdfForParsers(name: string): Promise<PdfTextResult> {
  const buffer = await readFile(path.join(CORPUS_DIR, name));
  let pages: PdfPage[];
  try {
    pages = await pdfPages(buffer);
  } catch (err) {
    return { kind: 'error', error: (err as Error).constructor.name };
  }

  if (countUniqueUpdInvoices(pages) >= 2) {
    return {
      kind: 'multi_upd',
      segments: segmentUpdText(pages).map((seg) => ({
        segmentIndex: seg.segmentIndex,
        docNumber: seg.docNumber,
        pages: seg.pages,
        text: cleanPdfText(seg.text),
      })),
    };
  }

  const text = cleanPdfText(pages.map((p) => p.text).join('\n'));
  if (text.length < MIN_TEXT_LENGTH) return { kind: 'no_text', textLength: text.length };
  return { kind: 'text_pdf', text };
}
