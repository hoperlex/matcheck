// Классификатор документов для единого входа «Загрузить документы».
// Скучный и наблюдаемый: дешёвый ДЕТЕРМИНИРОВАННЫЙ разбор (расширение + проба
// текстового слоя), без LLM. Возвращает решение + confidence + сигналы для
// журнала (bundle_import_items). Файлы, которые детерминированно не
// классифицируются (сканы/фото/неясный текст), помечаются needsVision=true —
// их доклассифицирует vision-слой (Этап 4) через prefilterUpdPages.
//
// Принцип: НЕ парсим здесь документ целиком и НЕ пишем данные — только решаем,
// КУДА его маршрутизировать. Реальный парсинг — существующими парсерами в
// worker. Тип наугад не назначаем: при сомнении → unknown + needsVision.

import { PDFParse } from 'pdf-parse';
import { countUniqueUpdInvoices } from './upd-text-bundle.parser.js';

export type DocClass = 'upd' | 'transport_waybill' | 'os2_transfer' | 'm15' | 'unknown';

export type FileClassification = {
  detectedKind: DocClass;
  confidence: number; // 0..1
  // true — детерминированно не определили (скан/фото/неясный текст): нужен
  // vision-слой (Этап 4). false — решение принято по тексту/расширению.
  needsVision: boolean;
  // предполагаемый парсер (для журнала parserUsed); 'none' — не парсим
  parserUsed: 'parseUpdXlsx' | 'parseUpdPdf' | 'tryParseTextUpdBundle' | 'parseWaybillBatch' | 'none';
  signals: string[];
  // для текстовых УПД — сколько уникальных счёт-фактур (≥2 → multi-UPD bundle)
  updInvoiceCount?: number;
};

const IMAGE_RE = /\.(jpe?g|png|webp|heic|heif)$/i;
const EXCEL_RE = /\.(xlsx|xls)$/i;
const PDF_RE = /\.pdf$/i;
const MIN_TEXT = 200;

async function extractPdfText(
  buffer: Buffer,
): Promise<{ pages: { num: number; text: string }[]; full: string }> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const r = await parser.getText();
    const pages = (r.pages ?? []).map((p) => ({
      num: typeof p.num === 'number' ? p.num : 0,
      text: p.text ?? '',
    }));
    const full = (r.text ?? '').replace(/\s+/g, ' ').trim();
    return { pages, full };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/**
 * Детерминированная классификация одного файла. Без LLM, без записи данных.
 * Excel → УПД (structural); PDF с текстом → по маркерам формы; скан/фото/
 * неясный текст → needsVision (доклассификация в Этапе 4).
 */
export async function classifyFile(
  buffer: Buffer,
  mime: string,
  filename: string,
): Promise<FileClassification> {
  const lower = filename.toLowerCase();
  const m = (mime || '').toLowerCase();

  // ── Excel: у нас это всегда УПД/реализация, structural-парсер детерминирован ──
  if (/spreadsheetml|ms-excel/.test(m) || EXCEL_RE.test(lower)) {
    return {
      detectedKind: 'upd',
      confidence: 0.99,
      needsVision: false,
      parserUsed: 'parseUpdXlsx',
      signals: ['ext:excel'],
    };
  }

  // ── Изображения: текстового слоя нет → vision (Этап 4) ──
  if (IMAGE_RE.test(lower) || /^image\//.test(m)) {
    return {
      detectedKind: 'unknown',
      confidence: 0,
      needsVision: true,
      parserUsed: 'none',
      signals: ['image'],
    };
  }

  // ── PDF: пробуем текстовый слой ──
  if (/pdf/.test(m) || PDF_RE.test(lower)) {
    const { pages, full } = await extractPdfText(buffer);
    if (full.length < MIN_TEXT) {
      // скан без текста — vision
      return {
        detectedKind: 'unknown',
        confidence: 0,
        needsVision: true,
        parserUsed: 'none',
        signals: ['pdf:scan', `textLen:${full.length}`],
      };
    }
    // УПД имеет ПРИОРИТЕТ: «Счёт-фактура»/«Универсальный передаточный» — даже
    // если в теле упоминается транспортная накладная (раздел «Данные о
    // транспортировке»). Иначе УПД-пачки ложно ушли бы в накладные.
    const hasUpd = /сч[её]т-фактур|универсальный передаточн/i.test(full);
    if (hasUpd) {
      const uniq = countUniqueUpdInvoices(pages);
      return {
        detectedKind: 'upd',
        confidence: 0.95,
        needsVision: false,
        parserUsed: uniq >= 2 ? 'tryParseTextUpdBundle' : 'parseUpdPdf',
        signals: ['text:upd', `invoices:${uniq}`],
        updInvoiceCount: uniq,
      };
    }
    // М-15 — нет надёжного парсера → честно помечаем, в worker уйдёт в review.
    if (/типовая\s+межотраслевая\s+форма\s+№?\s*м-?15|на отпуск материалов на сторону/i.test(full)) {
      return {
        detectedKind: 'm15',
        confidence: 0.7,
        needsVision: false,
        parserUsed: 'none',
        signals: ['text:m15'],
      };
    }
    if (/внутреннее перемещение объектов основных средств|унифицированн\w*\s+форм\w*\s+№?\s*ос-?2/i.test(full)) {
      return {
        detectedKind: 'os2_transfer',
        confidence: 0.8,
        needsVision: false,
        parserUsed: 'parseWaybillBatch',
        signals: ['text:os2'],
      };
    }
    if (/транспортная\s+накладная|грузоотправитель/i.test(full)) {
      return {
        detectedKind: 'transport_waybill',
        confidence: 0.8,
        needsVision: false,
        parserUsed: 'parseWaybillBatch',
        signals: ['text:tn'],
      };
    }
    // текст есть, но тип неясен — пусть vision доклассифицирует (Этап 4)
    return {
      detectedKind: 'unknown',
      confidence: 0.3,
      needsVision: true,
      parserUsed: 'none',
      signals: ['text:ambiguous'],
    };
  }

  // ── неизвестный mime/расширение ──
  return {
    detectedKind: 'unknown',
    confidence: 0,
    needsVision: true,
    parserUsed: 'none',
    signals: [`mime:${m || 'unknown'}`],
  };
}
