/**
 * Тесты на восстановление количества из арифметики строки.
 *
 * Числа боевые. УПД № УТ-480 (ТК «Скарабей С», 13.09.2026, фото приёмки 15104):
 * в графе 3 напечатано 57,000, цена 4 450,82, стоимость с налогом 309 510,00,
 * НДС 55 813,28 по ставке 22 %. Модель вернула количество 16 — это «1б» из
 * служебной строки нумерации граф, прочитанная как число.
 *
 * Отдельно проверяются два контрпримера, из-за которых правило и обставлено
 * ограничениями: арифметика НЕ отличает ошибку в количестве от ошибки в цене.
 */
import { describe, it, expect } from 'vitest';
import type { UpdPdfParsed, UpdPdfItem } from '@matcheck/contracts';
import {
  ALLOWED_UNIT_CODE_PAIRS,
  applyQtyRepairs,
  buildQtyRepairTrace,
  detectQtyRepairs,
} from '../src/domain/edo/qty-repair.js';

function item(over: Partial<UpdPdfItem> = {}): UpdPdfItem {
  return {
    rowNo: 1,
    nameRaw: 'ОПТИМИСТ W220 Краска негорючая КМ0 моющаяся 14кг',
    qty: 16,
    unit: 'шт',
    price: 4450.82,
    sum: 309510,
    vatRate: 22,
    vatSum: 55813.28,
    volumeM3: null,
    massKg: null,
    volumeConfidence: null,
    groupName: null,
    ...over,
  } as UpdPdfItem;
}

function doc(over: Partial<UpdPdfParsed> = {}, itemOver: Partial<UpdPdfItem> = {}): UpdPdfParsed {
  return {
    docNumber: 'УТ-480',
    docDate: '2026-09-13',
    totalSum: 309510,
    vatSum: 55813.28,
    itemsCount: 1,
    confidence: 0.95,
    supplier: { inn: '7727798773', kpp: '772701001', name: 'ООО «ТК «Скарабей С»' },
    recipient: { inn: '9727099883', kpp: null, name: 'ООО «МСУ-15»' },
    consignee: null,
    items: [item(itemOver)],
    ...over,
  } as UpdPdfParsed;
}

const NO_VAT_REWRITE = { lineVatRewritten: false };

describe('detectQtyRepairs — кандидаты', () => {
  it('находит количество УТ-480: 253 696,72 / 4 450,82 = 57', () => {
    const found = detectQtyRepairs(doc(), NO_VAT_REWRITE);
    expect(found).toHaveLength(1);
    expect(found[0].qtyFrom).toBe(16);
    expect(found[0].qtyTo).toBe(57);
    // «16» ничем не отличается от настоящих шестнадцати штук: улики нет.
    expect(found[0].kind).toBe('unexplained');
    expect(found[0].applicable).toBe(false);
    expect(found[0].blockedBy).toBe('class_not_allowed');
  });

  it('молчит, когда цена вычислена моделью: 15 480,625 — третий знак', () => {
    // Тот же документ, но цена не прочитана, а поделена: 247 690 / 16.
    expect(detectQtyRepairs(doc({}, { price: 15480.625 }), NO_VAT_REWRITE)).toEqual([]);
  });

  it('молчит, когда строка и так сходится', () => {
    expect(detectQtyRepairs(doc({}, { qty: 57 }), NO_VAT_REWRITE)).toEqual([]);
  });

  it('молчит, когда построчный НДС переписали мы сами', () => {
    // Иначе сходимость row_vat_rate подтверждала бы наш же расчёт.
    expect(detectQtyRepairs(doc(), { lineVatRewritten: true })).toEqual([]);
  });

  it('молчит, когда НДС строки не прочитан: пропуск проверки — не успех', () => {
    expect(detectQtyRepairs(doc({}, { vatSum: null }), NO_VAT_REWRITE)).toEqual([]);
    expect(detectQtyRepairs(doc({}, { vatRate: null }), NO_VAT_REWRITE)).toEqual([]);
  });

  it('молчит, когда итог документа не прочитан или не сошёлся со строками', () => {
    expect(detectQtyRepairs(doc({ totalSum: null }), NO_VAT_REWRITE)).toEqual([]);
    expect(detectQtyRepairs(doc({ totalSum: 400000 }), NO_VAT_REWRITE)).toEqual([]);
  });

  it('молчит, когда восстановленное количество не целое', () => {
    // 309 510 с НДС 22 % → база 253 696,72; при цене 4 000 выходит 63,42.
    expect(detectQtyRepairs(doc({}, { price: 4000 }), NO_VAT_REWRITE)).toEqual([]);
  });
});

describe('контрпримеры: арифметика не отличает ошибку в количестве от ошибки в цене', () => {
  /** «32,4 м³ × 100 ₽»: количество прочитано верно, цена — нет (324 вместо 100). */
  const FRACTIONAL = doc(
    { totalSum: 3952.8, vatSum: 712.8, itemsCount: 1 },
    {
      nameRaw: 'Блок газобетонный D500',
      qty: 32.4,
      unit: 'м3',
      price: 324,
      sum: 3952.8,
      vatRate: 22,
      vatSum: 712.8,
    },
  );

  it('дробное количество наблюдается, но не правится', () => {
    const found = detectQtyRepairs(FRACTIONAL, NO_VAT_REWRITE);
    expect(found).toHaveLength(1);
    expect(found[0].qtyTo).toBe(10);
    expect(found[0].applicable).toBe(false);
    expect(found[0].blockedBy).toBe('fractional_qty');

    // И не применяется даже там, где применение разрешено вызывающим.
    const { parsed, applied } = applyQtyRepairs(FRACTIONAL, found);
    expect(applied).toEqual([]);
    expect(parsed.items[0].qty).toBe(32.4);
    expect(parsed).toBe(FRACTIONAL);
  });

  /** «6 м × 100 ₽», НДС 22 % → 732 ₽. Цена прочитана как 200: 600/200 = 3. */
  const UNIT_CODE_COLLISION = doc(
    { totalSum: 732, vatSum: 132, itemsCount: 1 },
    {
      nameRaw: 'Кабель ВВГнг 3х1,5',
      qty: 6,
      unit: 'м',
      price: 200,
      sum: 732,
      vatRate: 22,
      vatSum: 132,
    },
  );

  it('настоящее количество, совпавшее с кодом своей единицы, не правится', () => {
    const found = detectQtyRepairs(UNIT_CODE_COLLISION, NO_VAT_REWRITE);
    expect(found).toHaveLength(1);
    // Класс распознан как «код ОКЕИ в количестве» — и это ровно тот случай,
    // когда подозрение ложное: 6 метров настоящие, ошиблась цена.
    expect(found[0].kind).toBe('unit_code_as_qty');
    expect(found[0].qtyTo).toBe(3);
    expect(found[0].applicable).toBe(false);
    expect(found[0].blockedBy).toBe('class_not_allowed');

    const { parsed } = applyQtyRepairs(UNIT_CODE_COLLISION, found);
    expect(parsed.items[0].qty).toBe(6);
  });
});

describe('разрешённый список пар', () => {
  it('пуст до сверки со сканами — включённый режим on не применяет ничего', () => {
    // Замок на случай «добавим пару, чтобы правило заработало»: расширение
    // списка обязано идти вместе со сверкой и отрицательным тестом на эту пару.
    expect(ALLOWED_UNIT_CODE_PAIRS).toEqual([]);
  });

  it('ни один боевой класс не применяется при пустом списке', () => {
    // Вода питьевая, 796 в количестве при единице «шт» (фото 214805):
    // 4 657,35 с НДС 22 % → база 3 817,50; при цене 254,50 это 15 штук.
    const water = doc(
      { totalSum: 4657.35, vatSum: 839.85, itemsCount: 1 },
      {
        nameRaw: 'Вода питьевая Королевская вода 19л',
        qty: 796,
        unit: 'шт',
        price: 254.5,
        sum: 4657.35,
        vatRate: 22,
        vatSum: 839.85,
      },
    );
    const found = detectQtyRepairs(water, NO_VAT_REWRITE);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('unit_code_as_qty');
    expect(found[0].qtyTo).toBe(15);
    expect(found[0].applicable).toBe(false);
    expect(applyQtyRepairs(water, found).applied).toEqual([]);
  });
});

describe('applyQtyRepairs — применение', () => {
  it('возвращает тот же объект, когда применять нечего', () => {
    const d = doc();
    const res = applyQtyRepairs(d, detectQtyRepairs(d, NO_VAT_REWRITE));
    expect(res.parsed).toBe(d);
    expect(res.applied).toEqual([]);
  });

  it('к уже исправленному результату кандидатов больше нет', () => {
    // Ручная подстановка верного количества = состояние после правки.
    const repaired = doc({}, { qty: 57 });
    expect(detectQtyRepairs(repaired, NO_VAT_REWRITE)).toEqual([]);
  });
});

describe('buildQtyRepairTrace — след', () => {
  it('помечает применённые как applied, прочие — как observed', () => {
    const candidates = detectQtyRepairs(doc(), NO_VAT_REWRITE);
    const trace = buildQtyRepairTrace({
      mode: 'shadow',
      candidates,
      appliedRows: new Set<number>(),
      generation: 0,
      docVersion: '2026-09-14T08:00:00.000Z',
    });
    expect(trace).not.toBeNull();
    expect(trace!.entries[0].state).toBe('observed');
    expect(trace!.entries[0].qtyFrom).toBe(16);
    expect(trace!.entries[0].qtyTo).toBe(57);
    expect(trace!.docVersion).toBe('2026-09-14T08:00:00.000Z');

    const applied = buildQtyRepairTrace({
      mode: 'on',
      candidates,
      appliedRows: new Set([1]),
      generation: 0,
      docVersion: null,
    });
    expect(applied!.entries[0].state).toBe('applied');
  });

  it('без кандидатов следа нет', () => {
    expect(
      buildQtyRepairTrace({
        mode: 'shadow',
        candidates: [],
        appliedRows: new Set<number>(),
        generation: 0,
        docVersion: null,
      }),
    ).toBeNull();
  });
});
