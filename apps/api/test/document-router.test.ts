import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { classifyFile } from '../src/domain/edo/document-router.js';

/**
 * Детерминированный классификатор единого входа — офлайн, без LLM.
 * Замораживает маршрутизацию на реальных debug-файлах: Excel→УПД,
 * текстовый multi-UPD→bundle, одиночный УПД→parseUpdPdf, ТН→накладные,
 * скан/фото→needsVision (доклассификация vision на Этапе 4).
 */

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'upd-debug');
const load = (f: string) => readFileSync(join(dir, f));

describe('document-router classifyFile — детерминированная маршрутизация', () => {
  it('Excel (.xls) → УПД, structural, без vision', async () => {
    const c = await classifyFile(load('upd-1877.xls'), 'application/vnd.ms-excel', 'upd-1877.xls');
    expect(c.detectedKind).toBe('upd');
    expect(c.needsVision).toBe(false);
    expect(c.parserUsed).toBe('parseUpdXlsx');
    expect(c.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('текстовый multi-UPD (зиларт) → УПД, tryParseTextUpdBundle, ≥2 счёт-фактур', async () => {
    const c = await classifyFile(load('zilart.pdf'), 'application/pdf', 'zilart.pdf');
    expect(c.detectedKind).toBe('upd');
    expect(c.needsVision).toBe(false);
    expect(c.parserUsed).toBe('tryParseTextUpdBundle');
    expect(c.updInvoiceCount).toBe(4);
  });

  it('одиночный текстовый УПД (1221312) → parseUpdPdf, 1 счёт-фактура', async () => {
    const c = await classifyFile(load('single-1221312.pdf'), 'application/pdf', 'single-1221312.pdf');
    expect(c.detectedKind).toBe('upd');
    expect(c.parserUsed).toBe('parseUpdPdf');
    expect(c.updInvoiceCount).toBe(1);
  });

  it('транспортная накладная (ТН-PDF) → transport_waybill', async () => {
    const c = await classifyFile(load('tn-0006281148.pdf'), 'application/pdf', 'tn-0006281148.pdf');
    expect(c.detectedKind).toBe('transport_waybill');
    expect(c.needsVision).toBe(false);
    expect(c.parserUsed).toBe('parseWaybillBatch');
  });

  it('скан без текста (scanlite3) → needsVision (доклассификация Этап 4)', async () => {
    const c = await classifyFile(load('scanlite3.pdf'), 'application/pdf', 'scanlite3.pdf');
    expect(c.needsVision).toBe(true);
    expect(c.signals.some((s) => s.startsWith('pdf:scan'))).toBe(true);
  });

  it('фото (jpg) → needsVision', async () => {
    const c = await classifyFile(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg', 'photo.jpg');
    expect(c.needsVision).toBe(true);
    expect(c.detectedKind).toBe('unknown');
  });
});
