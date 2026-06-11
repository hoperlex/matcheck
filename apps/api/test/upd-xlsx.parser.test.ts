import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseUpdXlsx } from '../src/domain/edo/upd-xlsx.parser.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'upd-xlsx');

function load(name: string): Buffer {
  return readFileSync(join(fixturesDir, name));
}

describe('parseUpdXlsx — шапка УПД из xlsx (Шаг 2a)', () => {
  it('УПД ЭИ00-0041581 (1С/Элевел, новая форма 1137 2026) — извлекает шапку', async () => {
    const r = await parseUpdXlsx(load('upd-elevel-0041581.xlsx'));
    expect(r.docNumber).toBe('ЭИ00-0041581');
    expect(r.docDate).toBe('2026-05-29');
    expect(r.supplier?.inn).toBe('5001112612');
    expect(r.supplier?.kpp).toBe('772801001');
    expect(r.supplier?.name).toContain('Элевел Инженер');
    expect(r.recipient?.inn).toBe('7736255508');
    expect(r.recipient?.kpp).toBe('774550001');
    expect(r.recipient?.name).toContain('СУ-10');
    expect(r.items).toEqual([]);
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('УПД ЭИ00-0041610 (1С/Элевел) — отличается только номером', async () => {
    const r = await parseUpdXlsx(load('upd-elevel-0041610.xlsx'));
    expect(r.docNumber).toBe('ЭИ00-0041610');
    expect(r.docDate).toBe('2026-05-29');
    expect(r.supplier?.inn).toBe('5001112612');
    expect(r.recipient?.inn).toBe('7736255508');
    expect(r.items).toEqual([]);
  });

  it('УПД №10045 «Асфальтобетон» (1С 2021, старая форма с шапкой в 2 столбца) — извлекает шапку', async () => {
    const r = await parseUpdXlsx(load('upd-asfb-10045.xlsx'));
    expect(r.docNumber).toBe('10045');
    expect(r.docDate).toBe('2023-04-10');
    expect(r.supplier?.inn).toBe('7704400689');
    expect(r.supplier?.kpp).toBe('770401001');
    expect(r.supplier?.name).toContain('АСФАЛЬТОБЕТОН');
    expect(r.recipient?.inn).toBe('7736255508');
    expect(r.recipient?.kpp).toBe('773601001');
    expect(r.recipient?.name).toContain('СУ-10');
    expect(r.items).toEqual([]);
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });
});
