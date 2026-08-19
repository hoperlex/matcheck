import { describe, it, expect } from 'vitest';
import { validateUpdTotals } from '../src/domain/edo/upd-validation.js';

describe('validateUpdTotals — сверка арифметики УПД', () => {
  it('row_qty_price: vatRate в строке null → берётся эффективная ставка из шапки', () => {
    // Типичный случай УПД ТД-42193: LLM не извлекла vatRate для
    // одной строки, но шапочные totalSum/vatSum позволяют вычислить
    // эффективную ставку (тут ≈ 22%). База без НДС считается через
    // неё. price = 70111.07 (графа 4), sum = 1300139.60 (графа 9):
    //   base = 1300139.60 × 100 / (100 + 22) ≈ 1065688.20;
    //   qty × price = 15.2 × 70111.07 = 1065688.26;
    //   diff ≈ 0.06 → внутри tolerance max(1, 0.1% от base).
    const r = validateUpdTotals({
      totalSum: 1300139.6,
      vatSum: 234451.4,
      items: [
        { qty: 15.2, price: 70111.07, sum: 1300139.6, vatRate: null, vatSum: null },
      ],
    });
    const row = r.checks.find((c) => c.name === 'row_qty_price');
    expect(row?.ok).toBe(true);
    expect(row?.expected).toBeCloseTo(1065688.2, 1);
    expect(row?.actual).toBeCloseTo(1065688.26, 1);
    expect(r.hasMismatch).toBe(false);
  });

  it('всё сходится: price из графы 4 (БЕЗ НДС), sum из графы 9 (С НДС) — промпт v7', () => {
    // После промпта v7 price = графа 4 (без НДС), sum = графа 9 (с НДС).
    // qty × price = 5.5 × 160 = 880 (база без НДС).
    // sum / (1 + 0.2) = 1056 / 1.2 = 880 — совпадает.
    // vatSum = sum × rate / (100 + rate) = 1056 × 20 / 120 = 176.
    const r = validateUpdTotals({
      totalSum: 1056,
      vatSum: 176,
      itemsCount: 1,
      items: [{ qty: 5.5, price: 160, sum: 1056, vatRate: 20, vatSum: 176 }],
    });
    expect(r.hasMismatch).toBe(false);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it('Σ items.sum vs totalSum: расхождение 0,02 ₽ при 2 строках укладывается в tolerance', () => {
    const r = validateUpdTotals({
      totalSum: 1000.04, // expected
      vatSum: null,
      items: [
        { qty: 1, price: 500, sum: 500.01, vatRate: null, vatSum: null },
        { qty: 1, price: 500, sum: 500.01, vatRate: null, vatSum: null },
      ],
    });
    const sumCheck = r.checks.find((c) => c.name === 'sum_total');
    expect(sumCheck?.ok).toBe(true);
    expect(sumCheck?.diff).toBeCloseTo(0.02, 2);
    expect(sumCheck?.tolerance).toBeCloseTo(0.02, 2);
  });

  it('Σ items.vatSum vs vatSum: копеечное расхождение укладывается в рублёвый допуск', () => {
    // Допуск НДС — max(1₽, 0.1%), как у qty × price. Поставщик считает налог от
    // неокруглённой базы, и на копейках проверка краснела бы на здоровых
    // документах; на бою из 1107 проверяемых строк копеечный допуск давал 27
    // несходящихся, рублёвый — 19, и это ровно реальные дефекты.
    const r = validateUpdTotals({
      totalSum: null,
      vatSum: 200.1, // против 200 по строкам
      items: [
        { qty: 1, price: 500, sum: 600, vatRate: 20, vatSum: 100 },
        { qty: 1, price: 500, sum: 600, vatRate: 20, vatSum: 100 },
      ],
    });
    const vatCheck = r.checks.find((c) => c.name === 'vat_total');
    expect(vatCheck?.ok).toBe(true);
    expect(vatCheck?.diff).toBeCloseTo(0.1, 2);
    expect(r.hasMismatch).toBe(false);
  });

  it('Σ items.vatSum vs vatSum: расхождение в рубли — по-прежнему mismatch', () => {
    const r = validateUpdTotals({
      totalSum: null,
      vatSum: 260, // против 200 по строкам
      items: [
        { qty: 1, price: 500, sum: 600, vatRate: 20, vatSum: 100 },
        { qty: 1, price: 500, sum: 600, vatRate: 20, vatSum: 100 },
      ],
    });
    const vatCheck = r.checks.find((c) => c.name === 'vat_total');
    expect(vatCheck?.ok).toBe(false);
    expect(vatCheck?.diff).toBeCloseTo(60, 2);
    expect(r.hasMismatch).toBe(true);
  });

  it('row_vat_rate: копейка проходит, значимое расхождение — нет', () => {
    const penny = validateUpdTotals({
      totalSum: null,
      vatSum: null,
      // База 1200 / 1.2 = 1000 = qty × price; ожидаемый налог 200, напечатано 200.30.
      items: [{ qty: 1, price: 1000, sum: 1200, vatRate: 20, vatSum: 200.3 }],
    });
    expect(penny.checks.find((c) => c.name === 'row_vat_rate')?.ok).toBe(true);
    expect(penny.hasMismatch).toBe(false);

    const real = validateUpdTotals({
      totalSum: null,
      vatSum: null,
      items: [{ qty: 1, price: 1000, sum: 1200, vatRate: 20, vatSum: 240 }],
    });
    expect(real.checks.find((c) => c.name === 'row_vat_rate')?.ok).toBe(false);
    expect(real.hasMismatch).toBe(true);
  });

  it('Без НДС в шапке: vat_total skip с skipReason=no_expected', () => {
    const r = validateUpdTotals({
      totalSum: 1000,
      vatSum: null,
      items: [{ qty: 1, price: 1000, sum: 1000, vatRate: null, vatSum: null }],
    });
    const vatCheck = r.checks.find((c) => c.name === 'vat_total');
    expect(vatCheck?.ok).toBe(true);
    expect(vatCheck?.skipReason).toBe('no_expected');
    expect(r.hasMismatch).toBe(false);
  });

  it('Построчно: qty=5,5 × price=200 = 1100; sum=1099,99 — diff 0,01 в пределах tolerance', () => {
    const r = validateUpdTotals({
      totalSum: null,
      vatSum: null,
      items: [{ qty: 5.5, price: 200, sum: 1099.99, vatRate: null, vatSum: null }],
    });
    const row = r.checks.find((c) => c.name === 'row_qty_price');
    expect(row?.ok).toBe(true);
    expect(row?.diff).toBeCloseTo(0.01, 2);
  });

  it('Построчно НДС: sum=1200 С НДС, ставка 20 → ожидает vatSum=200; 205 → mismatch', () => {
    // sum уже С НДС (промпт v6), поэтому ожидаемый НДС =
    // 1200 × 20 / 120 = 200. Парсер положил 205 → diff = 5 → mismatch.
    const r = validateUpdTotals({
      totalSum: null,
      vatSum: null,
      items: [{ qty: 1, price: 1200, sum: 1200, vatRate: 20, vatSum: 205 }],
    });
    const row = r.checks.find((c) => c.name === 'row_vat_rate');
    expect(row?.ok).toBe(false);
    expect(row?.diff).toBeCloseTo(5, 1);
    expect(r.hasMismatch).toBe(true);
  });

  it('itemsCount=12 vs items.length=11 → mismatch', () => {
    const items = Array.from({ length: 11 }, () => ({
      qty: 1,
      price: 100,
      sum: 100,
      vatRate: 20,
      vatSum: 20,
    }));
    const r = validateUpdTotals({ totalSum: null, vatSum: null, itemsCount: 12, items });
    const cnt = r.checks.find((c) => c.name === 'items_count');
    expect(cnt?.ok).toBe(false);
    expect(cnt?.expected).toBe(12);
    expect(cnt?.actual).toBe(11);
    expect(r.hasMismatch).toBe(true);
  });

  it('itemsCount=null (парсер не извлёк) → items_count skip, hasMismatch=false', () => {
    const r = validateUpdTotals({
      totalSum: 100,
      vatSum: null,
      itemsCount: null,
      items: [{ qty: 1, price: 100, sum: 100, vatRate: null, vatSum: null }],
    });
    const cnt = r.checks.find((c) => c.name === 'items_count');
    expect(cnt?.ok).toBe(true);
    expect(cnt?.skipReason).toBe('no_expected');
    expect(r.hasMismatch).toBe(false);
  });

  it('Частично заполненная строка (price=null) → построчные проверки skip, не мешают hasMismatch', () => {
    const r = validateUpdTotals({
      totalSum: 1000,
      vatSum: null,
      items: [{ qty: 5, price: null, sum: 1000, vatRate: null, vatSum: null }],
    });
    const rowQp = r.checks.find((c) => c.name === 'row_qty_price');
    const rowVat = r.checks.find((c) => c.name === 'row_vat_rate');
    expect(rowQp?.ok).toBe(true);
    expect(rowQp?.skipReason).toBe('no_actual');
    expect(rowVat?.ok).toBe(true);
    expect(r.hasMismatch).toBe(false);
  });

  // ──────────── Реальные кейсы из прод-лога llm_calls ────────────

  it('УПД 201/21125720: price из графы 4 (без НДС), sum из графы 9 (с НДС), vatRate в строке null → ok', () => {
    // Реальный документ из лога llm_calls. Под промпт v7:
    //   price = графа 4 «Цена без налога» (65.49 и т.д.);
    //   sum   = графа 9 «Стоимость с налогом — всего».
    // LLM не извлекла vatRate по позициям; эффективная ставка берётся
    // из шапки: 29332.28 / (162660.8 − 29332.28) × 100 ≈ 22%.
    // Σ items.sum = 47940 + 28364.5 + 10946.3 + 45980 + 29430 = 162660.80.
    // Каждая строка: base = sum / 1.22 ≈ qty × price с копеечной
    // погрешностью из-за округления цены поставщиком.
    const r = validateUpdTotals({
      totalSum: 162660.8,
      vatSum: 29332.28,
      items: [
        { qty: 600, price: 65.49, sum: 47940, vatRate: null, vatSum: null },
        { qty: 355, price: 65.49, sum: 28364.5, vatRate: null, vatSum: null },
        { qty: 137, price: 65.49, sum: 10946.3, vatRate: null, vatSum: null },
        { qty: 440, price: 85.66, sum: 45980, vatRate: null, vatSum: null },
        { qty: 180, price: 134.02, sum: 29430, vatRate: null, vatSum: null },
      ],
    });
    expect(r.hasMismatch).toBe(false);
    const sumCheck = r.checks.find((c) => c.name === 'sum_total');
    expect(sumCheck?.ok).toBe(true);
    expect(sumCheck?.expected).toBeCloseTo(162660.8, 2);
    expect(sumCheck?.actual).toBeCloseTo(162660.8, 2);
    const vatCheck = r.checks.find((c) => c.name === 'vat_total');
    expect(vatCheck?.ok).toBe(true);
    expect(vatCheck?.skipReason).toBe('no_actual');
  });

  it('vat_total skip when items.vatSum все пусты (PDF-флоу не извлекает vat по позициям)', () => {
    const r = validateUpdTotals({
      totalSum: 120,
      vatSum: 20,
      items: [
        { qty: 1, price: 100, sum: 100, vatRate: null, vatSum: null },
        { qty: 1, price: 100, sum: 100, vatRate: null, vatSum: null },
      ],
    });
    const vatCheck = r.checks.find((c) => c.name === 'vat_total');
    expect(vatCheck?.ok).toBe(true);
    expect(vatCheck?.skipReason).toBe('no_actual');
  });

  it('row_qty_price: расхождение 1.08₽ при sum=39295.08 укладывается в tolerance 0.1%', () => {
    const r = validateUpdTotals({
      totalSum: null,
      vatSum: null,
      items: [{ qty: 600, price: 65.49, sum: 39295.08, vatRate: null, vatSum: null }],
    });
    const row = r.checks.find((c) => c.name === 'row_qty_price');
    expect(row?.ok).toBe(true);
    expect(row?.diff).toBeCloseTo(1.08, 2);
    // max(1, 39295.08 * 0.001) ≈ 39.3 — спокойно покрывает 1.08₽.
    expect(row?.tolerance).toBeCloseTo(39.3, 1);
  });

  it('row_qty_price: настоящая ошибка (qty/price перепутаны) ловится несмотря на расширенный tolerance', () => {
    // Сюжет УПД 2493: код товара 796 распознан как qty, реальное qty 222.
    // 796 × 65.49 = 52130, реальный sum=14538, расхождение 37592₽. tolerance
    // max(1, 14.5₽) — далеко не покрывает.
    const r = validateUpdTotals({
      totalSum: null,
      vatSum: null,
      items: [{ qty: 796, price: 65.49, sum: 14538, vatRate: null, vatSum: null }],
    });
    const row = r.checks.find((c) => c.name === 'row_qty_price');
    expect(row?.ok).toBe(false);
    expect(r.hasMismatch).toBe(true);
  });

  it('scope построчных проверок содержит номер строки (1-based)', () => {
    const r = validateUpdTotals({
      totalSum: null,
      vatSum: null,
      items: [
        { qty: 1, price: 100, sum: 100, vatRate: 20, vatSum: 20 },
        { qty: 2, price: 50, sum: 100, vatRate: 20, vatSum: 20 },
      ],
    });
    const rows = r.checks.filter((c) => c.name === 'row_qty_price');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.scope).toEqual({ row: 1 });
    expect(rows[1]?.scope).toEqual({ row: 2 });
  });
});

describe('validateUpdTotals — подозрение на перестановку количества и цены', () => {
  // Боевой случай: УПД № 848, «66,294 м² × 8 114,75 ₽» распозналось наоборот.
  // Арифметика сходится в обе стороны — 66.294 × 8114.75 = 8114.75 × 66.294, —
  // поэтому обычные проверки молчат, и нужен отдельный сигнал.
  const swapped = {
    totalSum: 656310.6,
    vatSum: 118351.09,
    items: [{ qty: 8114.75, price: 66.294, sum: 656310.6, vatRate: 22, vatSum: 118351.09 }],
  };

  it('по умолчанию эвристика выключена: ни одного предупреждения', () => {
    const r = validateUpdTotals(swapped);
    expect(r.warnings).toBeUndefined();
  });

  it('с флагом — строка помечена, но исход документа не меняется', () => {
    const off = validateUpdTotals(swapped);
    const on = validateUpdTotals(swapped, { detectRecognitionWarnings: true });
    expect(on.warnings).toEqual([{ name: 'qty_price_swap', scope: { row: 1 } }]);
    // Ровно то, ради чего предупреждение вынесено из checks: hasMismatch и сами
    // проверки остаются прежними, значит parseErrorCode и второй проход не
    // трогаются.
    expect(on.hasMismatch).toBe(off.hasMismatch);
    expect(on.checks).toEqual(off.checks);
  });

  it('законная цена с четырьмя знаками предупреждения не даёт', () => {
    // Поставщик печатает цену 65.4918 (numeric(18,4) это позволяет), количество
    // целое — перестановкой тут и не пахнет.
    const r = validateUpdTotals(
      {
        totalSum: 7987.99,
        vatSum: 1438.79,
        items: [{ qty: 100, price: 65.4918, sum: 7987.99, vatRate: 22, vatSum: 1438.79 }],
      },
      { detectRecognitionWarnings: true },
    );
    expect(r.warnings).toBeUndefined();
  });

  it('дробное количество меньше цены — не подозрение (10,25 т × 65,4918)', () => {
    const r = validateUpdTotals(
      {
        totalSum: 819.19,
        vatSum: 147.45,
        items: [{ qty: 10.25, price: 65.4918, sum: 819.19, vatRate: 22, vatSum: 147.45 }],
      },
      { detectRecognitionWarnings: true },
    );
    expect(r.warnings).toBeUndefined();
  });

  it('правильно распознанная строка того же документа не помечается', () => {
    const r = validateUpdTotals(
      {
        totalSum: 656310.6,
        vatSum: 118351.09,
        items: [{ qty: 66.294, price: 8114.75, sum: 656310.6, vatRate: 22, vatSum: 118351.09 }],
      },
      { detectRecognitionWarnings: true },
    );
    expect(r.warnings).toBeUndefined();
  });

  it('законные qty = 3 и price = 4 предупреждения не дают', () => {
    const r = validateUpdTotals(
      { totalSum: 12, vatSum: null, items: [{ qty: 3, price: 4, sum: 12 }] },
      { detectRecognitionWarnings: true },
    );
    expect(r.warnings).toBeUndefined();
  });

  it('строка, где арифметика уже не сошлась, второго ярлыка не получает', () => {
    // qty × price = 2550, а sum = 30362 (боевой id 10776): расхождение уже
    // видно обычной проверкой, дублировать его подозрением незачем.
    const r = validateUpdTotals(
      {
        totalSum: 34842,
        vatSum: 6282.98,
        items: [{ qty: 3, price: 850, sum: 30362, vatRate: 22, vatSum: 5475.11 }],
      },
      { detectRecognitionWarnings: true },
    );
    expect(r.checks.find((c) => c.name === 'row_qty_price')?.ok).toBe(false);
    expect(r.warnings).toBeUndefined();
  });

  it('помечается только подозрительная строка, остальные — нет', () => {
    const r = validateUpdTotals(
      {
        totalSum: null,
        vatSum: null,
        items: [
          { qty: 200, price: 451.68, sum: 90336.07 },
          { qty: 8114.75, price: 66.294, sum: 537959.51 },
        ],
      },
      { detectRecognitionWarnings: true },
    );
    expect(r.warnings).toEqual([{ name: 'qty_price_swap', scope: { row: 2 } }]);
  });
});

describe('validateUpdTotals — целостность списка позиций (items_sequence)', () => {
  it('без номеров из бланка проверка пропускается', () => {
    const r = validateUpdTotals({
      totalSum: null,
      vatSum: null,
      items: [{ qty: 1, price: 100, sum: 100 }],
    });
    const seq = r.checks.find((c) => c.name === 'items_sequence');
    expect(seq?.ok).toBe(true);
    expect(seq?.skipReason).toBe('no_expected');
    expect(r.hasMismatch).toBe(false);
  });

  it('номера 1..N подряд — всё в порядке', () => {
    const r = validateUpdTotals({
      totalSum: null,
      vatSum: null,
      items: [
        { rowNo: 1, qty: 1, price: 100, sum: 100 },
        { rowNo: 2, qty: 1, price: 100, sum: 100 },
        { rowNo: 3, qty: 1, price: 100, sum: 100 },
      ],
    });
    expect(r.checks.find((c) => c.name === 'items_sequence')?.ok).toBe(true);
    expect(r.hasMismatch).toBe(false);
  });

  it('пропущенная строка видна, даже когда все суммы сошлись', () => {
    // Ровно случай УПД 1708/10: наименования съехали, позиция потерялась, а
    // построчная арифметика по оставшимся строкам может сойтись.
    const r = validateUpdTotals({
      totalSum: null,
      vatSum: null,
      items: [
        { rowNo: 1, qty: 1, price: 100, sum: 100 },
        { rowNo: 3, qty: 1, price: 100, sum: 100 },
        { rowNo: 4, qty: 1, price: 100, sum: 100 },
      ],
    });
    const seq = r.checks.find((c) => c.name === 'items_sequence');
    expect(seq?.ok).toBe(false);
    expect(seq?.expected).toBe(3);
    expect(seq?.diff).toBe(1);
    expect(r.checks.filter((c) => c.name === 'row_qty_price').every((c) => c.ok)).toBe(true);
    expect(r.hasMismatch).toBe(true);
  });

  it('задвоенный номер — тоже расхождение', () => {
    const r = validateUpdTotals({
      totalSum: null,
      vatSum: null,
      items: [
        { rowNo: 1, qty: 1, price: 100, sum: 100 },
        { rowNo: 2, qty: 1, price: 100, sum: 100 },
        { rowNo: 2, qty: 1, price: 100, sum: 100 },
      ],
    });
    expect(r.checks.find((c) => c.name === 'items_sequence')?.ok).toBe(false);
    expect(r.hasMismatch).toBe(true);
  });

  it('номер есть не у всех строк — проверка пропускается, а не краснеет', () => {
    // Подпозиции «1а»/«2а» номером-числом не выражаются и приходят null.
    // Красить из-за них документ нельзя: ошибки тут нет.
    const r = validateUpdTotals({
      totalSum: null,
      vatSum: null,
      items: [
        { rowNo: 1, qty: 1, price: 100, sum: 100 },
        { rowNo: null, qty: 1, price: 100, sum: 100 },
      ],
    });
    const seq = r.checks.find((c) => c.name === 'items_sequence');
    expect(seq?.ok).toBe(true);
    expect(seq?.skipReason).toBe('no_expected');
    expect(r.hasMismatch).toBe(false);
  });
});
