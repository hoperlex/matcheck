/**
 * Подтверждение дубликата содержимым.
 *
 * Прежнее правило считало дубликатом совпадение «вид + поставщик + номер +
 * дата», не глядя на содержимое. На бою за месяц из 126 таких пар у 23
 * разошлись суммы, у 21 — число позиций, а в 9 случаях спрятанный разбор был
 * ТОЧНЕЕ оставшегося. Здесь проверяется, что скрывается только доказанное
 * совпадение, а всё остальное остаётся видимым.
 *
 * Решают ЧИСЛА. Сравнение наименований подтвердило бы на боевых данных лишь 58
 * пар из 117 — остальные 59 копий вернулись бы на планшет и задвоили материалы,
 * потому что модель читает символы нестабильно (`5x4` против `5х4`).
 */
import { describe, it, expect } from 'vitest';
import type { UpdPdfParsed } from '@matcheck/contracts';
import { verdictForDuplicate, documentFingerprint } from '../src/domain/edo/duplicate-verdict.js';

type Row = {
  name: string;
  unit: string;
  qty: number | null;
  price: number | null;
  sum: number | null;
  vatSum: number | null;
};

const ROW: Row = { name: 'Кабель ВВГнг 3х2.5', unit: 'м', qty: 100, price: 82, sum: 10004, vatSum: 1804 };

function doc(rows: Row[], over: Partial<UpdPdfParsed> = {}): UpdPdfParsed {
  return {
    docNumber: '4242',
    docDate: '2026-08-20',
    totalSum: rows.reduce((a, r) => a + (r.sum ?? 0), 0),
    vatSum: rows.reduce((a, r) => a + (r.vatSum ?? 0), 0),
    itemsCount: rows.length,
    confidence: 0.9,
    supplier: null,
    recipient: null,
    consignee: null,
    items: rows.map((r, idx) => ({
      rowNo: idx + 1,
      nameRaw: r.name,
      qty: r.qty,
      unit: r.unit,
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

describe('дубликат подтверждается только доказанным совпадением', () => {
  it('точная копия → confirmed, скрывать можно', () => {
    const v = verdictForDuplicate(doc([ROW]), doc([ROW]), false);
    expect(v.kind).toBe('confirmed');
    expect(v).toMatchObject({ by: 'fingerprint' });
  });

  it('совпал хеш файла → confirmed, содержимое даже не смотрим', () => {
    // Самое сильное доказательство: тот же байтовый файл загружен дважды. Оно
    // не зависит от того, как модель прочитала бланк в этот раз.
    const v = verdictForDuplicate(doc([ROW]), doc([{ ...ROW, qty: 7 }]), true);
    expect(v).toMatchObject({ kind: 'confirmed', by: 'file_hash' });
  });

  it('ОДИНАКОВЫЙ ИТОГ, но разные количества → different, оба видимы', () => {
    // Совпадения суммы недостаточно: итог сходится, а по строкам разошлись
    // количества — это пересорт или частичная отгрузка, прятать нельзя.
    const a = doc([ROW]);
    const b = doc([{ ...ROW, name: 'Кабель ВВГнг 3х1.5', qty: 50, price: 164 }]);
    expect(a.totalSum).toBe(b.totalSum);
    const v = verdictForDuplicate(a, b, false);
    expect(v.kind).toBe('different');
    expect(v.detail).toMatch(/разное количество/);
  });

  it('одинаковые названия, но разные количества → different', () => {
    const v = verdictForDuplicate(doc([ROW]), doc([{ ...ROW, qty: 200, sum: 20008, vatSum: 3608 }]), false);
    expect(v.kind).toBe('different');
  });

  it('разное число позиций → different, причина названа', () => {
    const v = verdictForDuplicate(doc([ROW]), doc([ROW, { ...ROW, name: 'Гофра ПВХ 20' }]), false);
    expect(v.kind).toBe('different');
    expect(v.detail).toMatch(/разное число позиций: 1 и 2/);
  });

  it('СРАВНИТЬ НЕЧЕМ → unknown, документ НЕ скрывается', () => {
    // Прежнее правило в этой ситуации полагалось на совпадение реквизитов
    // внутри поставки — самая опасная ветка, потому что у разных отгрузок
    // реквизиты совпадают.
    const empty = doc([], { totalSum: null, vatSum: null });
    const v = verdictForDuplicate(empty, doc([ROW]), false);
    expect(v.kind).toBe('unknown');
  });

  it('позиции извлечены только у одного → unknown, а НЕ different', () => {
    // Это разное качество разбора, а не разные документы. Оба остаются видимы,
    // но объяснение человеку другое.
    const v = verdictForDuplicate(doc([], { totalSum: 10004, vatSum: 1804 }), doc([ROW]), false);
    expect(v.kind).toBe('unknown');
    expect(v.detail).toMatch(/позиции не извлечены/);
  });

  it('позиций нет, но есть итог И НДС — сравнить можно', () => {
    // Документ бывает parsed без позиций, но с суммой: CHECK с миграции 0107
    // требует только номер. Одного итога мало — нужны оба значения.
    const a = doc([], { totalSum: 10004, vatSum: 1804 });
    const b = doc([], { totalSum: 10004, vatSum: 1804 });
    expect(verdictForDuplicate(a, b, false).kind).toBe('confirmed');
  });

  it('позиций нет, итог совпал, а НДС не извлечён → unknown', () => {
    const a = doc([], { totalSum: 10004, vatSum: 1804 });
    const b = doc([], { totalSum: 10004, vatSum: null });
    expect(verdictForDuplicate(a, b, false).kind).toBe('unknown');
  });

  it('позиций нет у обоих, итоги разные → different', () => {
    const a = doc([], { totalSum: 10004, vatSum: 1804 });
    const b = doc([], { totalSum: 20008, vatSum: 3608 });
    expect(verdictForDuplicate(a, b, false).kind).toBe('different');
  });
});

describe('нестабильное чтение текста копию не рушит', () => {
  it('РАЗНОЕ НАПИСАНИЕ наименования при тех же числах → confirmed', () => {
    // Главный случай с боя: 31 пара из 117 расходилась только написанием.
    // Латинская «x» против кириллической, «i» против «l», лишний ноль.
    const a = doc([{ ...ROW, name: 'Кабель ВВГнг 3x2.5' }]);
    for (const variant of [
      'Кабель ВВГнг 3х2.5',
      'кабель ввгнг 3Х2.5',
      'Кабель\nВВГнг 3x2,5',
      'КАБЕЛЬ N-l60/40т 3x2.5',
    ]) {
      const v = verdictForDuplicate(a, doc([{ ...ROW, name: variant }]), false);
      expect(v.kind).toBe('confirmed');
    }
  });

  it('confirmed при расхождении текста объясняется отдельно', () => {
    const v = verdictForDuplicate(doc([ROW]), doc([{ ...ROW, name: 'Кабель ВВГ нг 3x2.5' }]), false);
    expect(v).toMatchObject({ kind: 'confirmed', by: 'fingerprint' });
    expect(v.detail).toMatch(/наименования прочитаны по-разному/);
    // А у полного совпадения формулировка другая — человеку видно, что сошлось.
    expect(verdictForDuplicate(doc([ROW]), doc([ROW]), false).detail).toMatch(/все позиции/);
  });

  it('разная единица измерения при тех же числах → confirmed', () => {
    // «шт» и «шт.» — то же самое; при совпавших количестве и сумме единица не
    // повод показывать копию второй раз.
    const a = doc([{ ...ROW, unit: 'шт' }]);
    const b = doc([{ ...ROW, unit: 'шт.' }]);
    expect(verdictForDuplicate(a, b, false).kind).toBe('confirmed');
  });

  it('построчный НДС разошёлся, а количества и суммы те же → confirmed', () => {
    // Ровно этот случай чинился в bd3a6ce: модель синтезировала налог по 20 %
    // вместо 22 %. Разбор другой, документ тот же.
    const v = verdictForDuplicate(
      doc([ROW]),
      doc([{ ...ROW, vatSum: 1667.33 }], { vatSum: 1667.33 }),
      false,
    );
    expect(v.kind).toBe('confirmed');
  });

  it('цена разошлась при совпавших количестве и сумме → confirmed', () => {
    const v = verdictForDuplicate(doc([ROW]), doc([{ ...ROW, price: 100.04 }]), false);
    expect(v.kind).toBe('confirmed');
  });
});

describe('отсутствующее значение ничего не доказывает', () => {
  it('количества нет ни у одного, суммы совпали → confirmed', () => {
    const row: Row = { ...ROW, qty: null };
    expect(verdictForDuplicate(doc([row]), doc([row]), false).kind).toBe('confirmed');
  });

  it('ни количеств, ни сумм → unknown, документ виден', () => {
    const row: Row = { ...ROW, qty: null, sum: null };
    const a = doc([row], { totalSum: 10004 });
    const b = doc([row], { totalSum: 10004 });
    const v = verdictForDuplicate(a, b, false);
    expect(v.kind).toBe('unknown');
    expect(v.detail).toMatch(/подтверждено строк 0 из 1/);
  });

  it('итог не извлечён у одного → unknown, даже если строки сошлись', () => {
    const a = doc([ROW]);
    const b = doc([ROW], { totalSum: null });
    expect(verdictForDuplicate(a, b, false).kind).toBe('unknown');
  });

  it('количество есть у одного, у другого нет → не различие', () => {
    // Сумма совпала — этого достаточно, чтобы строка считалась подтверждённой.
    const v = verdictForDuplicate(doc([ROW]), doc([{ ...ROW, qty: null }]), false);
    expect(v.kind).toBe('confirmed');
  });
});

describe('отпечаток', () => {
  it('перестановка строк — это другой документ', () => {
    // Сортировать позиции перед сравнением нельзя: порядок в бланке значим, и
    // сортировка сгладила бы реальное различие.
    const first = { ...ROW, name: 'Первая', qty: 10, sum: 1000 };
    const second = { ...ROW, name: 'Вторая', qty: 20, sum: 2000 };
    expect(documentFingerprint(doc([first, second]))).not.toBe(
      documentFingerprint(doc([second, first])),
    );
  });

  it('наименование в отпечаток не входит', () => {
    const a = doc([ROW]);
    const b = doc([{ ...ROW, name: 'Совсем другой текст' }]);
    expect(documentFingerprint(a)).toBe(documentFingerprint(b));
  });
});
