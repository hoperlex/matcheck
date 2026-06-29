// PDF→PNG для накладных под OpenRouter. Vision-провайдер OpenRouter принимает
// только image/* (не application/pdf), поэтому PDF-вложения накладных нужно
// заранее отрендерить в PNG-страницы. Gemini читает PDF нативно — для него
// конвертация не нужна (вызывается только при openrouter, см. worker).
//
// Переиспользует pdfToPngsViaPoppler/computePdfRenderDpi из upd-vision.parser
// (тот же механизм, что у УПД vision-fallback) — никакой новой логики рендера.

import { pdfToPngsViaPoppler, PdfRenderError } from './upd-vision.parser.js';
import type { WaybillInputImage } from './waybill-batch.parser.js';

// Типовая ТН/ОС-2 — 2 страницы A4 (стр.1 шапка/стороны, стр.2 груз/подписи).
// Отдельная от УПД-шной MAX_PAGES_FOR_OPENROUTER=5: накладные короче, лишние
// страницы только раздувают base64-payload.
export const WAYBILL_MAX_PAGES_FOR_OPENROUTER = 2;

/**
 * Разворачивает PDF-вложения накладных в PNG-страницы (для OpenRouter).
 * Не-PDF (JPG/PNG/WEBP) проходят как есть, порядок файлов сохраняется.
 * Чистая функция (без БД) — юнит-тестируется на debug-фикстурах ТН.
 *
 * Бросает PdfRenderError/PdfRenderTimeoutError при сбое рендера — worker
 * ловит и помечает bundle parse_failed без бесполезного BullMQ-retry
 * (pdftoppm детерминирован), как в УПД vision-пути.
 */
export async function expandPdfAttachmentsForOpenRouter(
  files: WaybillInputImage[],
  maxPages: number = WAYBILL_MAX_PAGES_FOR_OPENROUTER,
): Promise<WaybillInputImage[]> {
  const out: WaybillInputImage[] = [];
  for (const f of files) {
    if (f.mimeType.toLowerCase() === 'application/pdf') {
      const pngs = await pdfToPngsViaPoppler(f.buffer, maxPages);
      if (pngs.length === 0) {
        throw new PdfRenderError(`pdftoppm не вернул ни одной страницы для ${f.filename}`);
      }
      pngs.forEach((png, i) => {
        out.push({ buffer: png, mimeType: 'image/png', filename: `${f.filename}#p${i + 1}.png` });
      });
    } else {
      out.push(f);
    }
  }
  return out;
}
