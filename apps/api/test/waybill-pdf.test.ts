import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { pdfToPngsViaPoppler } from '../src/domain/edo/upd-vision.parser.js';
import {
  expandPdfAttachmentsForOpenRouter,
  WAYBILL_MAX_PAGES_FOR_OPENROUTER,
} from '../src/domain/edo/waybill-pdf.js';
import type { WaybillInputImage } from '../src/domain/edo/waybill-batch.parser.js';

/**
 * Этап 2 — накладные PDF→PNG для OpenRouter. Детерминированное ядро (рендер
 * pdftoppm + разворот вложений), офлайн, без БД/LLM. Требует poppler-utils
 * (как и upd-vision-multipage.test.ts).
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'upd-debug');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // \x89PNG

describe('waybill PDF→PNG для OpenRouter', () => {
  it('pdfToPngsViaPoppler на ТН-PDF → валидные PNG-страницы (≤2)', async () => {
    const buf = readFileSync(join(fixturesDir, 'tn-0006281148.pdf'));
    const pngs = await pdfToPngsViaPoppler(buf, WAYBILL_MAX_PAGES_FOR_OPENROUTER);
    expect(pngs.length).toBeGreaterThanOrEqual(1);
    expect(pngs.length).toBeLessThanOrEqual(2);
    for (const png of pngs) {
      expect(png.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    }
  });

  it('expandPdfAttachmentsForOpenRouter: PDF → PNG-страницы #p1/#p2', async () => {
    const pdf = readFileSync(join(fixturesDir, 'tn-0006281148.pdf'));
    const files: WaybillInputImage[] = [
      { buffer: pdf, mimeType: 'application/pdf', filename: 'tn.pdf' },
    ];
    const out = await expandPdfAttachmentsForOpenRouter(files);
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.every((f) => f.mimeType === 'image/png')).toBe(true);
    expect(out[0]!.filename).toBe('tn.pdf#p1.png');
    expect(out.every((f) => f.buffer.subarray(0, 4).equals(PNG_MAGIC))).toBe(true);
  });

  it('не-PDF (JPG) проходит как есть, порядок сохраняется', async () => {
    const pdf = readFileSync(join(fixturesDir, 'tn-0006281148.pdf'));
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]); // фейковый JPEG-заголовок
    const files: WaybillInputImage[] = [
      { buffer: jpg, mimeType: 'image/jpeg', filename: 'photo.jpg' },
      { buffer: pdf, mimeType: 'application/pdf', filename: 'tn.pdf' },
    ];
    const out = await expandPdfAttachmentsForOpenRouter(files);
    // первым идёт нетронутый JPG, затем PNG-страницы PDF
    expect(out[0]).toEqual(files[0]);
    expect(out.slice(1).every((f) => f.mimeType === 'image/png')).toBe(true);
    expect(out.slice(1).every((f) => f.filename.startsWith('tn.pdf#p'))).toBe(true);
  });
});
