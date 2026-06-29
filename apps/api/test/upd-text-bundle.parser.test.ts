import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFParse } from 'pdf-parse';
import { describe, it, expect } from 'vitest';
import {
  countUniqueUpdInvoices,
  segmentUpdText,
  tryParseTextUpdBundle,
} from '../src/domain/edo/upd-text-bundle.parser.js';

/**
 * Text multi-UPD bundle — детерминированное ядро (сегментация по номерам
 * счёт-фактур), офлайн, без LLM. Замораживает поведение на реальных пачках
 * из docs/debug-upd:
 *  - считаем УНИКАЛЬНЫЕ номера, не вхождения «СЧЕТ-ФАКТУРА» (один УПД часто
 *    печатается в 2 экземпляра);
 *  - 1221312 = 1 уникальный → precheck режет в null ДО любого LLM-вызова
 *    (must-pass: одиночные УПД не должны попадать в bundle-путь).
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'upd-debug');

async function extractPages(file: string): Promise<{ num: number; text: string }[]> {
  const buf = readFileSync(join(fixturesDir, file));
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const r = await parser.getText();
    return (r.pages ?? []).map((p) => ({
      num: typeof p.num === 'number' ? p.num : 0,
      text: p.text ?? '',
    }));
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

describe('text multi-UPD bundle — сегментация по номерам счёт-фактур', () => {
  it('zilart.pdf — 4 уникальных УПД, копии слиты по номеру', async () => {
    const pages = await extractPages('zilart.pdf');
    expect(countUniqueUpdInvoices(pages)).toBe(4);
    const segs = segmentUpdText(pages);
    expect(segs.map((s) => s.docNumber)).toEqual([
      '201/21126389',
      '201/21126387-1',
      '201/21126372',
      '201/21126371',
    ]);
    // Каждый УПД напечатан в 2 экземпляра; страницы-«продолжения» (без своего
    // заголовка) приклеиваются к текущему сегменту, копии — мёрджатся по номеру.
    expect(segs.map((s) => s.pages)).toEqual([
      [1, 2],
      [3, 4, 5, 6],
      [7, 8],
      [9, 10],
    ]);
  });

  it('printer2.pdf — 5 уникальных УПД', async () => {
    const pages = await extractPages('printer2.pdf');
    expect(countUniqueUpdInvoices(pages)).toBe(5);
    const segs = segmentUpdText(pages);
    expect(segs.map((s) => s.docNumber)).toEqual([
      '201/2112636922',
      '201/21126387-1',
      '201/21126372',
      '201/21126371',
      '201/21126389',
    ]);
  });

  it('aliya.pdf — 15 уникальных УПД (включая многостраничные)', async () => {
    const pages = await extractPages('aliya.pdf');
    expect(countUniqueUpdInvoices(pages)).toBe(15);
    expect(segmentUpdText(pages)).toHaveLength(15);
  });

  it('single-1221312.pdf — 1 УПД в 2 экземпляра → НЕ bundle (precheck null, без LLM)', async () => {
    const pages = await extractPages('single-1221312.pdf');
    expect(countUniqueUpdInvoices(pages)).toBe(1);
    // tryParseTextUpdBundle режет на precheck ДО любого extractUpdFromText —
    // значит безопасно вызывать без сети, результат null (обычный одиночный путь).
    const buf = readFileSync(join(fixturesDir, 'single-1221312.pdf'));
    const r = await tryParseTextUpdBundle(buf, { sourceDocumentId: null });
    expect(r).toBeNull();
  });
});
