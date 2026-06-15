import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseUpdXlsx } from '../src/domain/edo/upd-xlsx.parser.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'upd-xlsx');

function load(name: string): Buffer {
  return readFileSync(join(fixturesDir, name));
}

describe('parseUpdXlsx — шапка УПД из xlsx', () => {
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
  });

  it('УПД ЭИ00-0041610 (1С/Элевел) — отличается только номером', async () => {
    const r = await parseUpdXlsx(load('upd-elevel-0041610.xlsx'));
    expect(r.docNumber).toBe('ЭИ00-0041610');
    expect(r.docDate).toBe('2026-05-29');
    expect(r.supplier?.inn).toBe('5001112612');
    expect(r.recipient?.inn).toBe('7736255508');
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
  });
});

describe('parseUpdXlsx — табличная часть (items + totals)', () => {
  it('Элевел 0041610 — 2 позиции, корректные qty/price/sum/vatRate', async () => {
    const r = await parseUpdXlsx(load('upd-elevel-0041610.xlsx'));
    expect(r.items).toHaveLength(2);
    expect(r.itemsCount).toBe(2);

    const [a, b] = r.items;
    expect(a!.nameRaw).toContain('Розетка RJ 45');
    expect(a!.qty).toBe(4);
    expect(a!.unit).toBe('шт');
    expect(a!.price).toBeCloseTo(432.89, 2);
    expect(a!.sum).toBeCloseTo(2112.48, 2);
    expect(a!.vatRate).toBe(22);
    expect(a!.vatSum).toBeCloseTo(380.94, 2);

    expect(b!.nameRaw).toContain('Розетка электрическая');
    expect(b!.qty).toBe(10);
    expect(b!.sum).toBeCloseTo(3550.7, 2);

    // Итоги: «Всего к оплате» по графе 9 = 5663.18, графа 8 = 1021.23.
    expect(r.totalSum).toBeCloseTo(5663.18, 2);
    expect(r.vatSum).toBeCloseTo(1021.23, 2);
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('Элевел 0041581 — одна позиция «Напольный люк», корректные суммы', async () => {
    const r = await parseUpdXlsx(load('upd-elevel-0041581.xlsx'));
    expect(r.items).toHaveLength(1);
    expect(r.itemsCount).toBe(1);

    const [a] = r.items;
    expect(a!.nameRaw).toContain('Напольный люк');
    expect(a!.qty).toBe(2);
    expect(a!.unit).toBe('шт');
    expect(a!.price).toBeCloseTo(21050.32, 2);
    expect(a!.sum).toBeCloseTo(51362.78, 2);
    expect(a!.vatRate).toBe(22);
    expect(a!.vatSum).toBeCloseTo(9262.14, 2);

    expect(r.totalSum).toBeCloseTo(51362.78, 2);
    expect(r.vatSum).toBeCloseTo(9262.14, 2);
  });

  it('Асфальтобетон 10045 — 3 позиции (Бетон, Бетон, Доставка), м3 и НДС 20%', async () => {
    const r = await parseUpdXlsx(load('upd-asfb-10045.xlsx'));
    expect(r.items).toHaveLength(3);
    expect(r.itemsCount).toBe(3);

    const [b1, b2, dlv] = r.items;
    expect(b1!.nameRaw).toContain('Бетон БСТ В40П4F(I)200W12');
    expect(b1!.qty).toBe(49);
    expect(b1!.unit).toBe('м3');
    expect(b1!.price).toBeCloseTo(5416.67, 2);
    expect(b1!.sum).toBe(318500);
    expect(b1!.vatRate).toBe(20);
    expect(b1!.vatSum).toBeCloseTo(53083.33, 2);

    expect(b2!.qty).toBe(26);
    expect(b2!.sum).toBe(162370);

    expect(dlv!.nameRaw).toContain('Доставка');
    expect(dlv!.qty).toBe(75);
    expect(dlv!.sum).toBe(43500);

    // Итог по графе 9 = 524 370 ₽.
    expect(r.totalSum).toBe(524370);
    expect(r.vatSum).toBe(87395);
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });
});
