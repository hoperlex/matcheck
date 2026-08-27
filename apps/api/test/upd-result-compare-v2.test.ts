/**
 * Правило выбора лучшего разбора: сравнение расхождений ПО ВЕЛИЧИНЕ.
 *
 * Зачем понадобилось. Прежнее правило сравнивало расхождение как ДА/НЕТ: у базы
 * есть, у кандидата есть — «равны», побеждает база. На боевом УПД № 42 повтор
 * снял тринадцать провалов построчной арифметики (проваленных проверок стало 1
 * вместо 15), и правило оставило худший разбор с вердиктом «equal».
 *
 * Главная опасность правки — обратная. `validateUpdTotals` считает
 * отсутствующее значение УСПЕШНО ПРОПУЩЕННОЙ проверкой: строка без цены не даёт
 * провала `row_qty_price`, пустой итог не даёт провала `sum_total`. Поэтому
 * наивное «у кого меньше провалов» выбрало бы разбор, потерявший данные. Тест
 * «кандидат обнулил цены» здесь главный: он должен проигрывать.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { UpdPdfParsed } from '@matcheck/contracts';

type Row = { qty: number | null; price: number | null; sum: number; vatSum: number };

/** Строка, где арифметика сходится: 1 × 1000 = 1220 − 220. */
const GOOD: Row = { qty: 1, price: 1000, sum: 1220, vatSum: 220 };
/** Та же строка, но количество прочитано неверно: 3 × 1000 ≠ 1000. */
const BROKEN: Row = { qty: 3, price: 1000, sum: 1220, vatSum: 220 };

/**
 * Документ из `total` строк, из которых `broken` прочитаны неверно.
 *
 * Важно, что у кандидата в тестах режимов остаётся ХОТЯ БЫ ОДНА битая строка:
 * так было и на боевом № 42 (15 провалов против 1). Если расхождение у
 * кандидата исчезает совсем, разницу видит и прежнее правило — и случай
 * перестаёт быть показательным.
 */
function docBroken(total: number, broken: number): UpdPdfParsed {
  return doc([
    ...Array.from({ length: broken }, () => BROKEN),
    ...Array.from({ length: total - broken }, () => GOOD),
  ]);
}

function doc(rows: Row[], over: Partial<UpdPdfParsed> = {}): UpdPdfParsed {
  const totalSum = rows.reduce((a, r) => a + r.sum, 0);
  const vatSum = rows.reduce((a, r) => a + r.vatSum, 0);
  return {
    docNumber: '42',
    docDate: '2026-08-19',
    totalSum,
    vatSum,
    itemsCount: null,
    confidence: 0.5,
    supplier: null,
    recipient: null,
    consignee: null,
    items: rows.map((r, idx) => ({
      rowNo: idx + 1,
      nameRaw: `позиция ${idx + 1}`,
      qty: r.qty,
      unit: 'шт',
      price: r.price,
      sum: r.sum,
      vatRate: 22,
      vatSum: r.vatSum,
      volumeM3: null,
      massKg: null,
      volumeConfidence: null,
      groupName: null,
    })),
    ...over,
  } as UpdPdfParsed;
}

/** Загружает comparator с нужным режимом: loadEnv кеширует, нужен свежий модуль. */
async function withMode(mode: 'off' | 'shadow' | 'on') {
  process.env.UPD_RESULT_COMPARE_V2 = mode;
  vi.resetModules();
  return import('../src/domain/edo/upd-result-compare.js');
}

beforeEach(() => {
  process.env.UPD_RESULT_COMPARE_V2 = 'off';
});

describe('v2: величина расхождения решает', () => {
  it('БОЕВОЙ СЛУЧАЙ № 42: провалов арифметики стало втрое меньше — побеждает кандидат', async () => {
    const { chooseBetterUpdResult } = await withMode('on');
    // Как на бою: у обоих расхождение ОСТАЁТСЯ, но у кандидата его в разы
    // меньше. Прежнее правило именно поэтому и говорило «равны».
    const base = docBroken(13, 13);
    const candidate = docBroken(13, 2);

    const r = chooseBetterUpdResult(base, candidate);
    expect(r.winner).toBe('candidate');
    expect(r.reasons.join(' ')).toMatch(/row_qty_price 13→2/);
  });

  it('ГЛАВНЫЙ ТЕСТ: кандидат обнулил цены — побеждает база', async () => {
    // Те же 13 строк, но без цены. Проверка row_qty_price для таких строк
    // ПРОПУСКАЕТСЯ и засчитывается успешной, поэтому у кандидата провалов
    // меньше — при том, что данных в нём меньше тоже. Наивное «меньше провалов
    // значит лучше» выбрало бы именно его.
    const { chooseBetterUpdResult } = await withMode('on');
    const base = docBroken(13, 13);
    const candidate = doc(Array.from({ length: 13 }, () => ({ ...BROKEN, price: null })));

    const r = chooseBetterUpdResult(base, candidate);
    expect(r.winner).toBe('base');
    expect(r.reasons.join(' ')).toMatch(/покрытие row_qty_price 13→0/);
  });

  it('кандидат потерял половину строк — побеждает база', async () => {
    const { chooseBetterUpdResult } = await withMode('on');
    const base = doc(Array.from({ length: 13 }, () => GOOD));
    const candidate = doc(Array.from({ length: 6 }, () => GOOD));

    expect(chooseBetterUpdResult(base, candidate).winner).toBe('base');
  });

  it('обмен одной ошибки на другую улучшением НЕ считается', async () => {
    // У базы не сходится итог документа, зато строки в порядке; у кандидата
    // наоборот. Формально «по одной ошибке» у обоих, но это разные ошибки, и
    // решать тут должен человек, а не арифметика.
    const { chooseBetterUpdResult } = await withMode('on');
    const base = doc(Array.from({ length: 5 }, () => GOOD), { totalSum: 999999 });
    const candidate = doc(Array.from({ length: 5 }, () => BROKEN));

    expect(chooseBetterUpdResult(base, candidate).winner).toBe('base');
  });

  it('ОБА РАЗБОРА ПУСТЫ: confidence замену не инициирует', async () => {
    // Боевой случай № 28515612 — сертификат соответствия, товарной таблицы нет
    // вовсе. Прежнее правило отдавало победу кандидату из-за confidence
    // 0 против 0.2, хотя показать нечего ни тому, ни другому.
    const { chooseBetterUpdResult } = await withMode('on');
    const base = doc([], { confidence: 0 });
    const candidate = doc([], { confidence: 0.2 });

    const r = chooseBetterUpdResult(base, candidate);
    expect(r.winner).toBe('base');
    expect(r.reasons.join(' ')).toMatch(/без позиций/);
  });

  it('полное равенство — остаётся база', async () => {
    const { chooseBetterUpdResult } = await withMode('on');
    const base = doc(Array.from({ length: 3 }, () => GOOD));
    const candidate = doc(Array.from({ length: 3 }, () => GOOD));

    expect(chooseBetterUpdResult(base, candidate).winner).toBe('base');
  });
});

describe('режимы: off не меняет поведение, shadow только наблюдает', () => {
  it('off — прежнее правило: случай № 42 остаётся за базой', async () => {
    // Характеризация. Именно это поведение и признано дефектным, но при
    // выключенном рубильнике оно обязано сохраняться буква в букву.
    const { chooseBetterUpdResult } = await withMode('off');
    const base = docBroken(13, 13);
    const candidate = docBroken(13, 2);

    const r = chooseBetterUpdResult(base, candidate);
    expect(r.winner).toBe('base');
    expect(r.reasons).toContain('equal');
  });

  it('shadow — применяется старое решение, но новое попадает в reasons', async () => {
    // Через reasons решение доезжает до second_pass без единой правки в worker:
    // сохранение уже кладёт их туда целиком.
    const { chooseBetterUpdResult } = await withMode('shadow');
    const base = docBroken(13, 13);
    const candidate = docBroken(13, 2);

    const r = chooseBetterUpdResult(base, candidate);
    expect(r.winner).toBe('base');
    expect(r.reasons.join(' ')).toMatch(/v2 решила иначе: candidate/);
  });

  it('shadow молчит, когда правила согласны', async () => {
    const { chooseBetterUpdResult } = await withMode('shadow');
    const base = doc(Array.from({ length: 3 }, () => GOOD));
    const candidate = doc(Array.from({ length: 3 }, () => GOOD));

    const r = chooseBetterUpdResult(base, candidate);
    expect(r.reasons.join(' ')).not.toMatch(/v2 решила иначе/);
  });

  it('on — при расхождении в reasons остаётся след прежнего решения', async () => {
    const { chooseBetterUpdResult } = await withMode('on');
    const base = docBroken(13, 13);
    const candidate = docBroken(13, 2);

    const r = chooseBetterUpdResult(base, candidate);
    expect(r.winner).toBe('candidate');
    expect(r.reasons.join(' ')).toMatch(/v1 решила иначе: base/);
  });
});
