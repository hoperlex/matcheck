/**
 * Пересчёт количества по графам ТОРГ-12.
 *
 * Правило эвристическое ровно настолько, насколько это допустимо: оно
 * срабатывает только там, где количество либо не напечатано, либо равно массе
 * нетто при невесовой единице. Всё остальное — включая обычные УПД, где новых
 * полей вовсе нет, — обязано пройти мимо, иначе правка молча испортит
 * количество в приёмке.
 */
import { describe, expect, it } from 'vitest';
import type { UpdPdfParsed } from '@matcheck/contracts';
import {
  applyTorg12Qty,
  buildTorg12QtyTrace,
  detectTorg12Qty,
  torg12QtyAllowed,
  type Torg12QtyApplyContext,
} from '../src/domain/edo/torg12-qty.js';
import { QTY_REPAIR_PARSE_MODES, type ParseMode } from '../src/domain/edo/parse-mode.js';

type Item = UpdPdfParsed['items'][number];

const doc = (items: Array<Partial<Item>>): UpdPdfParsed =>
  ({
    docNumber: '1002004449',
    docDate: '2026-09-21',
    totalSum: null,
    vatSum: null,
    supplier: null,
    recipient: null,
    confidence: 0.9,
    items: items.map((i, idx) => ({
      nameRaw: i.nameRaw ?? `позиция ${idx + 1}`,
      unit: i.unit ?? 'шт',
      qty: i.qty ?? null,
      price: i.price ?? null,
      sum: i.sum ?? null,
      vatRate: i.vatRate ?? null,
      vatSum: i.vatSum ?? null,
      ...i,
    })),
  }) as unknown as UpdPdfParsed;

describe('detectTorg12Qty', () => {
  it('боевой случай: 13 мест по 60 м², в количестве стоит масса нетто', () => {
    const parsed = doc([
      {
        nameRaw: 'ВЕНТИ БАТТС Н 1000х600х100',
        unit: 'м2',
        qty: 2886,
        qtyPerPlace: 60,
        places: 13,
        massNetKg: 2886,
      },
    ]);
    const [candidate, ...rest] = detectTorg12Qty(parsed);
    expect(rest).toEqual([]);
    expect(candidate).toMatchObject({ kind: 'mass_as_qty', qtyFrom: 2886, qtyTo: 780 });

    const { parsed: next, applied } = applyTorg12Qty(parsed, [candidate!]);
    expect(applied).toHaveLength(1);
    expect(next.items[0]!.qty).toBe(780);
    // Исходный разбор не мутирован — на него ссылается след.
    expect(parsed.items[0]!.qty).toBe(2886);
  });

  it('строка адресуется индексом, а не номером из графы 1', () => {
    // Модель повторила номер 1 у второй строки: по rowNo правка попала бы в
    // первую строку, а откат в воркере (по индексу) — во вторую.
    const parsed = doc([
      { nameRaw: 'Без правки', unit: 'м2', qty: 100, rowNo: 1 },
      {
        nameRaw: 'ВЕНТИ БАТТС',
        unit: 'м2',
        qty: 2886,
        qtyPerPlace: 60,
        places: 13,
        massNetKg: 2886,
        rowNo: 1,
      },
    ]);
    const candidates = detectTorg12Qty(parsed);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.row).toBe(2);
    const { parsed: next } = applyTorg12Qty(parsed, candidates);
    expect(next.items.map((i) => i.qty)).toEqual([100, 780]);
  });

  it('количество не напечатано вовсе — считаем по графам', () => {
    const parsed = doc([{ unit: 'м2', qty: null, qtyPerPlace: 60, places: 13 }]);
    expect(detectTorg12Qty(parsed)[0]).toMatchObject({ kind: 'qty_missing', qtyTo: 780 });
  });

  it('единица весовая — графа 10 и есть количество, не трогаем', () => {
    for (const unit of ['кг', 'КГ', 'т']) {
      const parsed = doc([{ unit, qty: 2886, qtyPerPlace: 60, places: 13, massNetKg: 2886 }]);
      expect(detectTorg12Qty(parsed)).toEqual([]);
    }
  });

  it('количество напечатано и массе не равно — строка не кандидат', () => {
    const parsed = doc([
      { unit: 'м2', qty: 500, qtyPerPlace: 60, places: 13, massNetKg: 2886 },
    ]);
    expect(detectTorg12Qty(parsed)).toEqual([]);
  });

  it('количество уже совпадает с произведением граф — правки нет', () => {
    const parsed = doc([{ unit: 'м2', qty: 780, qtyPerPlace: 60, places: 13, massNetKg: 2886 }]);
    expect(detectTorg12Qty(parsed)).toEqual([]);
  });

  it('обычная УПД без граф ТОРГ-12 правилом не затрагивается', () => {
    const parsed = doc([
      { nameRaw: 'Труба', unit: 'м', qty: 18, price: 100, sum: 2196 },
      { nameRaw: 'Доставка', unit: 'шт', qty: null, price: null, sum: 1000 },
    ]);
    expect(detectTorg12Qty(parsed)).toEqual([]);
    expect(applyTorg12Qty(parsed, []).parsed).toBe(parsed);
  });

  it('нулевые и отрицательные графы игнорируются', () => {
    expect(detectTorg12Qty(doc([{ qty: null, qtyPerPlace: 0, places: 13 }]))).toEqual([]);
    expect(detectTorg12Qty(doc([{ qty: null, qtyPerPlace: 60, places: -1 }]))).toEqual([]);
  });

  it('правится только своя строка: остальные позиции неизменны', () => {
    const parsed = doc([
      { nameRaw: 'Плита', unit: 'м2', qty: 2886, qtyPerPlace: 60, places: 13, massNetKg: 2886 },
      { nameRaw: 'Крепёж', unit: 'шт', qty: 400, price: 12, sum: 4800 },
    ]);
    const candidates = detectTorg12Qty(parsed);
    const { parsed: next } = applyTorg12Qty(parsed, candidates);
    expect(next.items[0]!.qty).toBe(780);
    expect(next.items[1]).toEqual(parsed.items[1]);
  });
});

describe('след правила', () => {
  it('в shadow все кандидаты — наблюдение', () => {
    const parsed = doc([{ unit: 'м2', qty: 2886, qtyPerPlace: 60, places: 13, massNetKg: 2886 }]);
    const candidates = detectTorg12Qty(parsed);
    const trace = buildTorg12QtyTrace({
      mode: 'shadow',
      candidates,
      appliedRows: new Set(),
      generation: 0,
      docVersion: 1,
    });
    expect(trace).toMatchObject({ mode: 'shadow', ruleVersion: 1 });
    expect(trace!.entries[0]).toMatchObject({ state: 'observed', qtyFrom: 2886, qtyTo: 780 });
  });

  it('без кандидатов следа нет вовсе', () => {
    expect(
      buildTorg12QtyTrace({
        mode: 'on',
        candidates: [],
        appliedRows: new Set(),
        generation: null,
        docVersion: null,
      }),
    ).toBeNull();
  });
});

describe('torg12QtyAllowed — когда воркер сохраняет пересчёт', () => {
  // Первичная загрузка фото: единственный случай, где правка разрешена.
  const firstUpload: Torg12QtyApplyContext = {
    mode: 'on',
    parseMode: 'image_vision',
    secondPassJob: false,
    segmentRepairJob: false,
    wantSecondPass: false,
    wantSegmentRepair: false,
    jobGeneration: 0,
  };

  it('первичный разбор картинки при on — сохраняет', () => {
    expect(torg12QtyAllowed(firstUpload)).toBe(true);
    expect(torg12QtyAllowed({ ...firstUpload, parseMode: 'vision_pdf' })).toBe(true);
  });

  it('shadow и off — только наблюдение', () => {
    expect(torg12QtyAllowed({ ...firstUpload, mode: 'shadow' })).toBe(false);
    expect(torg12QtyAllowed({ ...firstUpload, mode: 'off' })).toBe(false);
  });

  it('текстовый путь и Excel закрыты: числа взяты из самого файла', () => {
    for (const parseMode of ['text', 'text_bundle', 'excel_structural', 'excel_vision'] as ParseMode[]) {
      expect(torg12QtyAllowed({ ...firstUpload, parseMode })).toBe(false);
    }
  });

  it('второй проход картинкой закрыт, хотя это vision', () => {
    // second_pass_vision не входит в режимы правок: повтор выбирает лучший
    // результат сравнением с базой, и подменённое количество его исказило бы.
    expect(QTY_REPAIR_PARSE_MODES.has('second_pass_vision')).toBe(false);
    expect(torg12QtyAllowed({ ...firstUpload, parseMode: 'second_pass_vision' })).toBe(false);
  });

  it('ручной повтор (поколение > 0) не правит: накопленные документы так не чинятся', () => {
    expect(torg12QtyAllowed({ ...firstUpload, jobGeneration: 1 })).toBe(false);
  });

  it('ни в роли повтора, ни когда разбор его ставит', () => {
    expect(torg12QtyAllowed({ ...firstUpload, secondPassJob: true })).toBe(false);
    expect(torg12QtyAllowed({ ...firstUpload, segmentRepairJob: true })).toBe(false);
    expect(torg12QtyAllowed({ ...firstUpload, wantSecondPass: true })).toBe(false);
    expect(torg12QtyAllowed({ ...firstUpload, wantSegmentRepair: true })).toBe(false);
  });
});
