import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  computePdfRenderDpi,
  PDF_RENDER_CONSTANTS,
} from '../src/domain/edo/pdf-render-dpi.js';

/**
 * Тесты адаптивного DPI:
 *  - Типовая A4 → 150 DPI (как раньше — нулевая регрессия).
 *  - Аномально большая страница (scanlite3.pdf — 2530×3364 pt =
 *    35×47 inch) → DPI снижен, итоговый PNG ≤ 2400 px по длинной стороне.
 *  - Битый/пустой PDF → fallback на MAX_DPI=150 (не падаем).
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('computePdfRenderDpi — адаптивный DPI для pdftoppm', () => {
  it('А4 (1697.pdf, 595×842 pt) → MAX_DPI=150 (поведение без регрессий)', async () => {
    const buf = readFileSync(join(fixturesDir, 'upd-debug', '1697.pdf'));
    const dpi = await computePdfRenderDpi(buf);
    expect(dpi).toBe(150);
  });

  it('Аномально большая страница (scanlite3.pdf, 2530×3364 pt) → DPI снижен', async () => {
    const buf = readFileSync(join(fixturesDir, 'upd-debug', 'scanlite3.pdf'));
    const dpi = await computePdfRenderDpi(buf);
    // 2400 px / (3364/72) inch ≈ 51 DPI. Floor → 51.
    expect(dpi).toBeLessThan(150);
    expect(dpi).toBeGreaterThanOrEqual(PDF_RENDER_CONSTANTS.MIN_DPI);
    // Проверка лимита: long edge при computed DPI должна быть ≤ TARGET.
    const longEdgePts = 3364;
    const longEdgePx = (longEdgePts / 72) * dpi;
    expect(longEdgePx).toBeLessThanOrEqual(
      PDF_RENDER_CONSTANTS.TARGET_LONG_EDGE_PX,
    );
  });

  it('Полностью пустой буфер → MAX_DPI fallback, не throw', async () => {
    const dpi = await computePdfRenderDpi(Buffer.alloc(0));
    expect(dpi).toBe(PDF_RENDER_CONSTANTS.MAX_DPI);
  });

  it('Произвольный мусор-буфер → MAX_DPI fallback, не throw', async () => {
    const dpi = await computePdfRenderDpi(
      Buffer.from('not a pdf at all just some random bytes', 'utf-8'),
    );
    expect(dpi).toBe(PDF_RENDER_CONSTANTS.MAX_DPI);
  });

  it('Константы экспортированы и согласованы', () => {
    expect(PDF_RENDER_CONSTANTS.TARGET_LONG_EDGE_PX).toBe(2400);
    expect(PDF_RENDER_CONSTANTS.MAX_DPI).toBe(150);
    expect(PDF_RENDER_CONSTANTS.MIN_DPI).toBeGreaterThan(0);
    expect(PDF_RENDER_CONSTANTS.MIN_DPI).toBeLessThan(
      PDF_RENDER_CONSTANTS.MAX_DPI,
    );
  });
});
