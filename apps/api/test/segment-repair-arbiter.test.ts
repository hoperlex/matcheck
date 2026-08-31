/**
 * Арбитраж автоповтора сегмента.
 *
 * Эталон — боевой УПД № 53 от 31.08.2026 (документ
 * 7d431c15-93e4-475f-bddb-f9c8f6d2295e). В бланке три строки, модель вернула
 * две: первую с её числами и третью — под наименованием второй. Строка на
 * 1 043 565 ₽ исчезла, а итог по шапке (2 557 288 ₽) остался посчитанным по
 * всем трём: именно это расхождение и должен уметь чинить повтор.
 *
 * Два теста здесь главные и оба про безопасность:
 *   * «подгонка шапки» — кандидат оставляет те же две строки и переписывает
 *     итог под их сумму; валидация становится чистой, а материалов
 *     по-прежнему 2 из 3;
 *   * «повторил ошибку в итоге» — кандидат вернул все три строки, но снова
 *     прочитал итог как 2 557 288 ₽. Допуск sum_total равен двум копейкам,
 *     поэтому проверка у него всё ещё провалена, и правило «принимать только
 *     разбор без расхождений» отвергло бы верный результат.
 */
import { describe, expect, it } from 'vitest';
import type { UpdPdfParsed } from '@matcheck/contracts';
import {
  decideSegmentRepair,
  preserveDocumentIdentity,
} from '../src/domain/edo/segment-repair-arbiter.js';

type Row = {
  rowNo: number | null;
  nameRaw: string;
  price: number | null;
  sum: number | null;
  vatSum: number | null;
};

/** Строки бланка № 53 в том виде, в каком они напечатаны. */
const LINE_1: Row = {
  rowNo: 1,
  nameRaw: 'Вводно-распределительное устройство ВРУ2.1(ПОН)',
  price: 1007299.18,
  sum: 1228905,
  vatSum: 221605.82,
};
const LINE_2: Row = {
  rowNo: 2,
  nameRaw: 'Вводно-распределительное устройство ВРУ2.2(ПОН)',
  price: 855381.15,
  sum: 1043565,
  vatSum: 188183.85,
};
const LINE_3: Row = {
  rowNo: 3,
  nameRaw: 'Вводно-распределительное устройство ВРУ2.2(ПЭСПЗ)',
  price: 233440.98,
  sum: 284798,
  vatSum: 51357.02,
};

/** Что вернула модель на первом заходе: имя второй строки, числа третьей. */
const MERGED_2_3: Row = { ...LINE_3, rowNo: 2, nameRaw: LINE_2.nameRaw };
/** Первая строка тоже прочитана с опечаткой в наименовании: 2.1 → 2.2. */
const LINE_1_AS_READ: Row = { ...LINE_1, nameRaw: LINE_2.nameRaw };

function doc(rows: Row[], over: Partial<UpdPdfParsed> = {}): UpdPdfParsed {
  return {
    docNumber: '53',
    docDate: '2026-08-31',
    totalSum: 2557288,
    vatSum: 461146.69,
    itemsCount: null,
    confidence: 0.95,
    supplier: { inn: '7743190837', kpp: '774301001', name: 'ООО "ПЭМ-ЭНЕРГО"' },
    recipient: { inn: '7743483077', kpp: '774301001', name: 'ООО "ТАДЖИНКСТРОЙ"' },
    consignee: null,
    items: rows.map((r) => ({
      rowNo: r.rowNo,
      nameRaw: r.nameRaw,
      qty: 1,
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

/** Сохранённый разбор: две позиции, итог по трём строкам. */
const baseline = doc([LINE_1_AS_READ, MERGED_2_3]);

describe('автоповтор сегмента: когда кандидат принимается', () => {
  it('вернулись все три строки и сошёлся итог — принять', () => {
    const candidate = doc([LINE_1, LINE_2, LINE_3], { totalSum: 2557268 });
    const verdict = decideSegmentRepair(baseline, candidate);
    expect(verdict.accept).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('sum_total');
  });

  it('три строки, но итог снова прочитан с ошибкой на 20 ₽ — всё равно принять', () => {
    // Допуск sum_total — две копейки, поэтому проверка у кандидата провалена.
    // Но расхождение на 20 ₽ вместо потерянной строки на 1 043 565 ₽ — именно
    // то улучшение, ради которого повтор и запускается.
    const candidate = doc([LINE_1, LINE_2, LINE_3]);
    const verdict = decideSegmentRepair(baseline, candidate);
    expect(verdict.accept).toBe(true);
    // Победа приходит по НДС: Σ строк совпала с шапкой документа.
    expect(verdict.reasons.join(' ')).toContain('vat_total');
  });
});

describe('автоповтор сегмента: когда кандидат отклоняется', () => {
  it('подгонка шапки: те же две строки, переписан итог — отклонить', () => {
    const candidate = doc([LINE_1_AS_READ, MERGED_2_3], {
      totalSum: 1513703,
      vatSum: 272962.84,
    });
    const verdict = decideSegmentRepair(baseline, candidate);
    expect(verdict.accept).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('переписан только итог');
  });

  it('кандидат потерял итог и цены — отклонить как потерю покрытия', () => {
    const candidate = doc(
      [
        { ...LINE_1_AS_READ, price: null, sum: null, vatSum: null },
        { ...MERGED_2_3, price: null, sum: null, vatSum: null },
      ],
      { totalSum: null, vatSum: null },
    );
    const verdict = decideSegmentRepair(baseline, candidate);
    expect(verdict.accept).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('покрытие');
  });

  it('кандидат без позиций — отклонить', () => {
    const verdict = decideSegmentRepair(baseline, doc([], { totalSum: 2557268 }));
    expect(verdict.accept).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('без позиций');
  });

  it('задвоение: каждая строка вернулась дважды — отклонить', () => {
    // Ловушка: Σ задвоенных строк (3 027 406 ₽) БЛИЖЕ к итогу 2 557 288 ₽, чем
    // исходные 1 513 703 ₽, поэтому правило «Σ приблизилась к якорю» само по
    // себе засчитало бы это за починку.
    const candidate = doc([LINE_1_AS_READ, MERGED_2_3, LINE_1_AS_READ, MERGED_2_3]);
    const verdict = decideSegmentRepair(baseline, candidate);
    expect(verdict.accept).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('задвоились');
  });

  it('задвоение с перенумерованными строками — тоже отклонить', () => {
    // Дубли номеров ловит items_sequence; если модель пронумерует строки
    // подряд, эта защита молчит — остаётся только проверка на задвоение.
    const candidate = doc([
      { ...LINE_1_AS_READ, rowNo: 1 },
      { ...MERGED_2_3, rowNo: 2 },
      { ...LINE_1_AS_READ, rowNo: 3 },
      { ...MERGED_2_3, rowNo: 4 },
    ]);
    const verdict = decideSegmentRepair(baseline, candidate);
    expect(verdict.accept).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('задвоились');
  });

  it('ничего не изменилось — отклонить', () => {
    const verdict = decideSegmentRepair(baseline, doc([LINE_1_AS_READ, MERGED_2_3]));
    expect(verdict.accept).toBe(false);
  });
});

describe('идентичность документа', () => {
  it('номер, дата и стороны берутся из сохранённого разбора', () => {
    const candidate = doc([LINE_1, LINE_2, LINE_3], {
      docNumber: '58',
      docDate: '2026-08-30',
      supplier: { inn: '0000000000', kpp: null, name: 'ООО "ЧУЖОЙ"' },
    });
    const merged = preserveDocumentIdentity(baseline, candidate);
    expect(merged.docNumber).toBe('53');
    expect(merged.docDate).toBe('2026-08-31');
    expect(merged.supplier?.name).toBe('ООО "ПЭМ-ЭНЕРГО"');
    // Строки — то, ради чего повтор и делался, — берутся у кандидата.
    expect(merged.items).toHaveLength(3);
  });

  it('отсутствующую у baseline сторону кандидат дозаполняет', () => {
    const withoutConsignee = doc([LINE_1_AS_READ, MERGED_2_3], { consignee: null });
    const candidate = doc([LINE_1, LINE_2, LINE_3], {
      consignee: { inn: null, kpp: null, name: 'ООО "ТАДЖИНКСТРОЙ"' },
    });
    const merged = preserveDocumentIdentity(withoutConsignee, candidate);
    expect(merged.consignee?.name).toBe('ООО "ТАДЖИНКСТРОЙ"');
  });
});
