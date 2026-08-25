/**
 * Тесты на критерий «можно активировать промпт».
 *
 * Сам гейт до сих пор был непроверяем: он жил внутри скрипта, который стоит
 * денег и требует боевой БД. Ошибка в нём не видна никак — отчёт просто
 * печатает «регрессий нет». Поэтому чистая часть вынесена в prompt-ab-lib.ts,
 * а здесь проверяется, что она действительно ловит то, ради чего заведена.
 */
import { describe, it, expect } from 'vitest';
import type { UpdPdfParsed } from '@matcheck/contracts';
import type { UnitComparison } from '../scripts/prompt-ab-lib.js';
import {
  checkConsigneeAgainstExpectation,
  checkMoneyAgainstExpectation,
  compareUnit,
  confidenceBucket,
  diffKeys,
  evaluateGate,
  isCriticalKey,
  matchExpectation,
  newMoneyMismatches,
  snapshotOf,
} from '../scripts/prompt-ab-lib.js';

function parsed(over: Partial<UpdPdfParsed> = {}): UpdPdfParsed {
  return {
    docNumber: '1421',
    docDate: '2026-07-09',
    totalSum: 43895.34,
    vatSum: 7315.89,
    itemsCount: 1,
    confidence: 0.9,
    supplier: { inn: '7743429410', kpp: null, name: 'ООО «Первый вентиляционный»' },
    recipient: { inn: '7736255508', kpp: null, name: 'ООО «СУ-10»' },
    consignee: null,
    items: [
      {
        nameRaw: 'Воздуховод 700x300',
        qty: 1,
        unit: 'шт',
        price: 1992.33,
        sum: 2390.8,
        vatRate: 20,
        vatSum: 398.47,
        volumeM3: 0.126,
        massKg: 12.5,
        volumeConfidence: 'high',
        groupName: 'Вентиляция',
      },
    ],
    ...over,
  } as UpdPdfParsed;
}

describe('snapshotOf — точность и состав', () => {
  it('видит расхождение в ЧЕТВЁРТОМ знаке qty (в БД scale 4)', () => {
    const a = snapshotOf(parsed());
    const b = snapshotOf(parsed({ items: [{ ...parsed().items[0]!, qty: 1.0001 }] }));
    expect(diffKeys(a, b)).toContain('items[0].qty');
  });

  it('видит расхождение в третьем знаке massKg (scale 3)', () => {
    const a = snapshotOf(parsed());
    const b = snapshotOf(parsed({ items: [{ ...parsed().items[0]!, massKg: 12.501 }] }));
    expect(diffKeys(a, b)).toContain('items[0].massKg');
  });

  it('в снимок входят volumeM3, massKg, volumeConfidence, groupName и confidence', () => {
    const s = snapshotOf(parsed());
    expect(Object.keys(s)).toEqual(
      expect.arrayContaining([
        'items[0].volumeM3',
        'items[0].massKg',
        'items[0].volumeConfidence',
        'items[0].groupName',
        'confidence',
        'confidenceBucket',
      ]),
    );
  });

  it('изменение groupName заметно', () => {
    const a = snapshotOf(parsed());
    const b = snapshotOf(parsed({ items: [{ ...parsed().items[0]!, groupName: 'Другое' }] }));
    expect(diffKeys(a, b)).toContain('items[0].groupName');
  });

  it('копеечное округление расхождением не считается', () => {
    const a = snapshotOf(parsed({ totalSum: 43895.34 }));
    const b = snapshotOf(parsed({ totalSum: 43895.340000001 }));
    expect(diffKeys(a, b)).toEqual([]);
  });
});

describe('confidence — пороги маршрутизации', () => {
  it.each([
    [0.49, '<0.5'],
    [0.5, '0.5–0.6'],
    [0.59, '0.5–0.6'],
    [0.6, '≥0.6'],
    [0.95, '≥0.6'],
  ])('%s → %s', (v, bucket) => {
    expect(confidenceBucket(v)).toBe(bucket);
  });

  it('переход через 0.6 фиксируется как сдвиг (дедуп и автоподрядчик)', () => {
    const c = compareUnit({
      label: 'f.pdf',
      a1: parsed({ confidence: 0.62 }),
      a2: parsed({ confidence: 0.62 }),
      b: parsed({ confidence: 0.55 }),
      consigneeFromModel: true,
      expected: undefined,
    });
    expect(c.confidenceShift).toBe('≥0.6 → 0.5–0.6');
    expect(evaluateGate({ checkedUnits: 1, failures: [], comparisons: [c] })).toContain(
      'confidence пересёк порог: 1',
    );
  });

  it('дрожание внутри одного интервала порогом не считается, но видно как изменение', () => {
    const c = compareUnit({
      label: 'f.pdf',
      a1: parsed({ confidence: 0.9 }),
      a2: parsed({ confidence: 0.9 }),
      b: parsed({ confidence: 0.85 }),
      consigneeFromModel: true,
      expected: undefined,
    });
    expect(c.confidenceShift).toBeNull();
    expect(c.changed).toContain('confidence');
  });
});

describe('критические поля', () => {
  it.each([
    ['docNumber', true],
    ['docDate', true],
    ['items.length', true],
    ['items[3].qty', true],
    ['items[0].nameRaw', true],
    ['recipient.name', true],
    ['supplier.inn', true],
    ['items[0].volumeConfidence', false],
    ['itemsCount', false],
    ['consignee.name', false],
  ])('%s → критическое: %s', (key, critical) => {
    expect(isCriticalKey(key)).toBe(critical);
  });

  it('нестабильный номер документа в A/A блокирует активацию', () => {
    const c = compareUnit({
      label: 'f.pdf',
      a1: parsed({ docNumber: '1421' }),
      a2: parsed({ docNumber: '142I' }),
      b: parsed({ docNumber: '1421' }),
      consigneeFromModel: true,
      expected: undefined,
    });
    expect(c.unstableCritical).toContain('docNumber');
    expect(evaluateGate({ checkedUnits: 1, failures: [], comparisons: [c] })).toContain(
      'нестабильные критические поля в A/A: 1',
    );
  });
});

describe('грузополучатель против эталона', () => {
  const expected = {
    docNumber: '1421',
    consignee: { name: 'ООО «СУ-10»', inn: null, kpp: null },
  };

  it('совпал и пришёл от модели → ок', () => {
    const v = checkConsigneeAgainstExpectation(
      {
        label: 'f.pdf',
        parsed: parsed({ consignee: { inn: null, kpp: null, name: 'ООО "СУ-10"' } }),
        consigneeFromModel: true,
      },
      expected,
    );
    // Кавычки и регистр расхождением не считаются — сравниваем организацию.
    expect(v.status).toBe('ok');
  });

  it('дозаполненный регулярками НЕ засчитывается модели', () => {
    // Главная ловушка прежнего скрипта: fillPartiesFromText работает и на
    // старой версии промпта, поэтому «поле непустое» ничего не доказывает.
    const v = checkConsigneeAgainstExpectation(
      {
        label: 'f.pdf',
        parsed: parsed({ consignee: { inn: null, kpp: null, name: 'ООО «СУ-10»' } }),
        consigneeFromModel: false,
      },
      expected,
    );
    expect(v.status).toBe('filled_from_text');
  });

  it('не совпал с эталоном → mismatch', () => {
    const v = checkConsigneeAgainstExpectation(
      {
        label: 'f.pdf',
        parsed: parsed({ consignee: { inn: null, kpp: null, name: 'Иванов И.И.' } }),
        consigneeFromModel: true,
      },
      expected,
    );
    expect(v.status).toBe('mismatch');
  });

  it('пустой грузополучатель при непустом эталоне → mismatch', () => {
    const v = checkConsigneeAgainstExpectation(
      { label: 'f.pdf', parsed: parsed({ consignee: null }), consigneeFromModel: true },
      expected,
    );
    expect(v.status).toBe('mismatch');
  });

  // Дефект, который прежний гейт пропускал: в графе 4 реквизитов нет (эталон
  // null), а модель подставляет туда ИНН и КПП покупателя. Проверка вида
  // `if (wantInn && …)` считала это успехом — именно так дефект и доехал до боя.
  it('эталон inn: null, модель вернула ИНН → mismatch', () => {
    const v = checkConsigneeAgainstExpectation(
      {
        label: 'f.pdf',
        parsed: parsed({ consignee: { inn: '7736255508', kpp: null, name: 'ООО «СУ-10»' } }),
        consigneeFromModel: true,
      },
      expected,
    );
    expect(v.status).toBe('mismatch');
    expect('detail' in v && v.detail).toContain('не напечатан в графе 4');
  });

  it('эталон kpp: null, модель вернула КПП → mismatch', () => {
    const v = checkConsigneeAgainstExpectation(
      {
        label: 'f.pdf',
        parsed: parsed({ consignee: { inn: null, kpp: '774550001', name: 'ООО «СУ-10»' } }),
        consigneeFromModel: true,
      },
      expected,
    );
    expect(v.status).toBe('mismatch');
    expect('detail' in v && v.detail).toContain('КПП');
  });

  it('«он же»: эталон с реальными реквизитами покупателя → ok', () => {
    // Законный повтор графы 6 не должен краснеть, поэтому в манифесте у таких
    // документов стоят настоящие ИНН/КПП, а не null.
    const v = checkConsigneeAgainstExpectation(
      {
        label: 'f.pdf',
        parsed: parsed({
          consignee: { inn: '7736255508', kpp: '774550001', name: 'ООО «СУ-10»' },
        }),
        consigneeFromModel: true,
      },
      {
        docNumber: '1421',
        consignee: { name: 'ООО «СУ-10»', inn: '7736255508', kpp: '774550001' },
      },
    );
    expect(v.status).toBe('ok');
  });

  it('графа 4 пуста по манифесту, модель ничего не вернула → ok', () => {
    const v = checkConsigneeAgainstExpectation(
      { label: 'f.pdf', parsed: parsed({ consignee: null }), consigneeFromModel: true },
      undefined,
      false,
    );
    expect(v.status).toBe('ok');
  });

  it('графа 4 пуста, но модель выдумала сторону → mismatch', () => {
    // В корпусе такие документы есть (УПД №100000, Х-3655): напечатана только
    // подпись графы. Раньше именно сюда попадал мусор «(4)» и «и его адрес:».
    const v = checkConsigneeAgainstExpectation(
      {
        label: 'f.pdf',
        parsed: parsed({ consignee: { inn: null, kpp: null, name: 'ООО «СУ-10»' } }),
        consigneeFromModel: true,
      },
      undefined,
      false,
    );
    expect(v.status).toBe('mismatch');
    expect('detail' in v && v.detail).toContain('пуста');
  });

  it('ИНН с пробелами против эталона без них — не расхождение', () => {
    const v = checkConsigneeAgainstExpectation(
      {
        label: 'f.pdf',
        parsed: parsed({ consignee: { inn: '77 36 25 55 08', kpp: null, name: 'ООО «СУ-10»' } }),
        consigneeFromModel: true,
      },
      { docNumber: '1421', consignee: { name: 'ООО «СУ-10»', inn: '7736255508', kpp: null } },
    );
    expect(v.status).toBe('ok');
  });
});

describe('сопоставление с эталоном по номеру документа', () => {
  const expectations = [
    { docNumber: 'A-1', consignee: { name: 'Первый', inn: null, kpp: null } },
    { docNumber: 'A-2', consignee: { name: 'Второй', inn: null, kpp: null } },
  ];

  it('находит по номеру, даже если порядок сегментов поехал', () => {
    expect(matchExpectation(parsed({ docNumber: 'A-2' }), 0, expectations)?.consignee.name).toBe(
      'Второй',
    );
  });

  it('без номера — запасной путь по индексу', () => {
    expect(matchExpectation(parsed({ docNumber: null }), 1, expectations)?.consignee.name).toBe(
      'Второй',
    );
  });
});

describe('evaluateGate', () => {
  const clean = () =>
    compareUnit({
      label: 'f.pdf',
      a1: parsed(),
      a2: parsed(),
      b: parsed({ consignee: { inn: null, kpp: null, name: 'ООО «СУ-10»' } }),
      consigneeFromModel: true,
      expected: { docNumber: '1421', consignee: { name: 'ООО «СУ-10»', inn: null, kpp: null } },
    });

  it('чистый прогон — блокеров нет', () => {
    expect(evaluateGate({ checkedUnits: 1, failures: [], comparisons: [clean()] })).toEqual([]);
  });

  it('пустой прогон не выглядит успешным', () => {
    expect(evaluateGate({ checkedUnits: 0, failures: [], comparisons: [] })).toContain(
      'нет разобранных документов',
    );
  });

  it('упавший разбор блокирует', () => {
    expect(
      evaluateGate({
        checkedUnits: 1,
        failures: [{ file: 'x.pdf', error: 'boom' }],
        comparisons: [clean()],
      }),
    ).toContain('не разобрались файлы: 1');
  });

  it('изменение, совпавшее с эталоном, регрессом не считается', () => {
    // Боевой случай: на скане 1697 в бланке количество 76,032 и цена 6 846,72.
    // База читала ценой 76032 (это количество), новая версия прочитала верно.
    // Diff между версиями тут максимальный — и это ИСПРАВЛЕНИЕ, а не регресс.
    const wrong = [{ ...parsed().items[0]!, rowNo: 1, qty: 1, price: 76032 }];
    const right = [{ ...parsed().items[0]!, rowNo: 1, qty: 76.032, price: 6846.72 }];
    const c = compareUnit({
      label: '1697.pdf',
      a1: parsed({ items: wrong }),
      a2: parsed({ items: wrong }),
      b: parsed({ items: right }),
      consigneeFromModel: true,
      expected: {
        docNumber: '1421',
        consignee: { name: 'ООО «СУ-10»', inn: null, kpp: null },
        items: [{ rowNo: 1, qty: 76.032, price: 6846.72 }],
      },
    });
    expect(c.changed).not.toContain('items[row1].qty');
    expect(c.changed).not.toContain('items[row1].price');
    expect(evaluateGate({ checkedUnits: 1, failures: [], comparisons: [c] })).toEqual([]);
  });

  it('изменение против эталона остаётся регрессом', () => {
    // Обратная сторона: если новая версия разошлась с бумагой, «подтверждения»
    // нет и поле обязано попасть в блокеры.
    const right = [{ ...parsed().items[0]!, rowNo: 1, qty: 76.032, price: 6846.72 }];
    const wrong = [{ ...parsed().items[0]!, rowNo: 1, qty: 1, price: 76032 }];
    const c = compareUnit({
      label: '1697.pdf',
      a1: parsed({ items: right }),
      a2: parsed({ items: right }),
      b: parsed({ items: wrong }),
      consigneeFromModel: true,
      expected: {
        docNumber: '1421',
        consignee: { name: 'ООО «СУ-10»', inn: null, kpp: null },
        items: [{ rowNo: 1, qty: 76.032, price: 6846.72 }],
      },
    });
    expect(c.changedCritical).toContain('items[row1].price');
    expect(evaluateGate({ checkedUnits: 1, failures: [], comparisons: [c] })).toContain(
      'регрессии критических полей: 1',
    );
  });

  it('оценочные поля меняются свободно: масса, объём, категория', () => {
    // Они шевелятся от любой правки промпта, эталона у них нет и быть не может
    // (это оценка модели, а не то, что напечатано в бланке).
    const base = parsed().items[0]!;
    const c = compareUnit({
      label: 'f.pdf',
      a1: parsed(),
      a2: parsed(),
      b: parsed({
        items: [{ ...base, massKg: 0.2, volumeM3: 0.0001, groupName: 'Прочее' }],
        consignee: { inn: null, kpp: null, name: 'ООО «СУ-10»' },
      }),
      consigneeFromModel: true,
      // Эталон нужен любой: гейт отдельно блокирует прогон, где сверять не с
      // чем вовсе, и без него тест проверял бы не то.
      expected: { docNumber: '1421', consignee: { name: 'ООО «СУ-10»', inn: null, kpp: null } },
    });
    expect(c.changed.length).toBeGreaterThan(0);
    expect(c.changedCritical).toEqual([]);
    expect(evaluateGate({ checkedUnits: 1, failures: [], comparisons: [c] })).toEqual([]);
  });

  it('дефект базы, дрожащий между прогонами, не объявляется новым', () => {
    // На сканах модель подставляет ИНН покупателя в графу 4 через раз. Считая
    // базу по одному прогону, гейт объявил бы это регрессом новой версии.
    const withInn = { inn: '7736255508', kpp: null, name: 'ООО «СУ-10»' };
    const clean = { inn: null, kpp: null, name: 'ООО «СУ-10»' };
    const c = compareUnit({
      label: 'scan.pdf',
      a1: parsed({ consignee: clean }),
      a2: parsed({ consignee: withInn }),
      b: parsed({ consignee: withInn }),
      consigneeFromModel: true,
      expected: { docNumber: '1421', consignee: { name: 'ООО «СУ-10»', inn: null, kpp: null } },
    });
    expect(c.expectation.status).toBe('mismatch');
    expect(c.baseExpectation.status).toBe('mismatch');
    expect(evaluateGate({ checkedUnits: 1, failures: [], comparisons: [c] })).toEqual([]);
  });

  it('расхождение, которое есть и у базы, активацию не блокирует', () => {
    // Часть дефектов промптом не лечится: запрет подставлять ИНН покупателя в
    // графу 4 написан ещё в v13, а модель его игнорирует. Абсолютный гейт из-за
    // такого запрещал бы ЛЮБУЮ новую версию — то есть навсегда. Блокируют
    // только новые расхождения; унаследованные остаются в отчёте.
    const withBuyerInn = { inn: '7736255508', kpp: null, name: 'ООО «СУ-10»' };
    const c = compareUnit({
      label: 'f.pdf',
      a1: parsed({ consignee: withBuyerInn }),
      a2: parsed({ consignee: withBuyerInn }),
      b: parsed({ consignee: withBuyerInn }),
      consigneeFromModel: true,
      expected: { docNumber: '1421', consignee: { name: 'ООО «СУ-10»', inn: null, kpp: null } },
    });
    expect(c.expectation.status).toBe('mismatch');
    expect(c.baseExpectation.status).toBe('mismatch');
    expect(evaluateGate({ checkedUnits: 1, failures: [], comparisons: [c] })).toEqual([]);
  });

  it('расхождение, появившееся только у новой версии, блокирует', () => {
    const c = compareUnit({
      label: 'f.pdf',
      a1: parsed({ consignee: { inn: null, kpp: null, name: 'ООО «СУ-10»' } }),
      a2: parsed({ consignee: { inn: null, kpp: null, name: 'ООО «СУ-10»' } }),
      b: parsed({ consignee: { inn: '7736255508', kpp: null, name: 'ООО «СУ-10»' } }),
      consigneeFromModel: true,
      expected: { docNumber: '1421', consignee: { name: 'ООО «СУ-10»', inn: null, kpp: null } },
    });
    expect(evaluateGate({ checkedUnits: 1, failures: [], comparisons: [c] })).toContain(
      'НОВОЕ расхождение с эталоном: 1',
    );
  });

  it('сумма, разошедшаяся с эталоном у обеих версий, не блокирует', () => {
    // Эталон говорит «цена 1992.33», обе версии читают 1892.33 — дефект общий,
    // и он виден в отчёте, но выкат новой версии из-за него не держим.
    const wrongPrice = [{ ...parsed().items[0]!, price: 1892.33 }];
    const expected = {
      docNumber: '1421',
      consignee: { name: 'ООО «СУ-10»', inn: null, kpp: null },
      items: [{ rowNo: 1, price: 1992.33 }],
    };
    const c = compareUnit({
      label: 'f.pdf',
      a1: parsed({ items: wrongPrice }),
      a2: parsed({ items: wrongPrice }),
      b: parsed({ items: wrongPrice }),
      consigneeFromModel: true,
      expected,
    });
    expect(c.moneyMismatches.length).toBeGreaterThan(0);
    expect(newMoneyMismatches(c)).toEqual([]);
    expect(evaluateGate({ checkedUnits: 1, failures: [], comparisons: [c] })).toEqual([]);
  });

  it('изменение стабильного поля блокирует', () => {
    const c = compareUnit({
      label: 'f.pdf',
      a1: parsed(),
      a2: parsed(),
      b: parsed({ totalSum: 43895.35 }),
      consigneeFromModel: true,
      expected: undefined,
    });
    expect(evaluateGate({ checkedUnits: 1, failures: [], comparisons: [c] })).toContain(
      'регрессии критических полей: 1',
    );
  });

  it('изменение самого грузополучателя регрессом НЕ считается', () => {
    // Это добавляемое поле: у базовой версии его нет по определению.
    const c = compareUnit({
      label: 'f.pdf',
      a1: parsed({ consignee: null }),
      a2: parsed({ consignee: null }),
      b: parsed({ consignee: { inn: null, kpp: null, name: 'ООО «СУ-10»' } }),
      consigneeFromModel: true,
      expected: { docNumber: '1421', consignee: { name: 'ООО «СУ-10»', inn: null, kpp: null } },
    });
    expect(c.changed).toEqual([]);
    expect(evaluateGate({ checkedUnits: 1, failures: [], comparisons: [c] })).toEqual([]);
  });

  it('прогон, где эталона нет ни у одного документа, не считается доказательством', () => {
    const c = compareUnit({
      label: 'f.pdf',
      a1: parsed(),
      a2: parsed(),
      b: parsed(),
      consigneeFromModel: true,
      expected: undefined,
    });
    expect(evaluateGate({ checkedUnits: 1, failures: [], comparisons: [c] })).toContain(
      'ни у одного документа нет эталона в манифесте (сверять не с чем)',
    );
  });
});

describe('checkMoneyAgainstExpectation — сверка денег с бумагой', () => {
  const item = (over: Record<string, unknown>) => ({ ...parsed().items[0]!, ...over });

  it('позиция ищется по номеру из графы 1, а не по индексу массива', () => {
    // Модель вернула строки в обратном порядке: по индексу сверка сравнила бы
    // вторую позицию с эталоном первой и нашла бы несуществующее расхождение.
    const p = parsed({
      items: [
        item({ rowNo: 2, nameRaw: 'Вторая', qty: 5, price: 100, sum: 500 }),
        item({ rowNo: 1, nameRaw: 'Первая', qty: 2, price: 10, sum: 20 }),
      ],
    });
    const problems = checkMoneyAgainstExpectation(p, {
      docNumber: '1421',
      consignee: { name: '', inn: null, kpp: null },
      items: [{ rowNo: 1, qty: 2, price: 10, sum: 20 }],
    });
    expect(problems).toEqual([]);
  });

  it('потерянная строка видна как отсутствие номера', () => {
    const p = parsed({ items: [item({ rowNo: 1 })] });
    const problems = checkMoneyAgainstExpectation(p, {
      docNumber: '1421',
      consignee: { name: '', inn: null, kpp: null },
      items: [{ rowNo: 2, qty: 1 }],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.detail).toContain('в разборе нет');
  });

  it('задвоенный номер позиции — тоже расхождение', () => {
    const p = parsed({ items: [item({ rowNo: 1 }), item({ rowNo: 1, nameRaw: 'Дубль' })] });
    const problems = checkMoneyAgainstExpectation(p, {
      docNumber: '1421',
      consignee: { name: '', inn: null, kpp: null },
      items: [{ rowNo: 1, qty: 1 }],
    });
    expect(problems[0]?.detail).toContain('задвоен');
  });

  it('эталонный null означает «в бумаге нет»: подставленная цена — расхождение', () => {
    // Керамзит: цен в бланке нет вовсе, а модель вернула 29.51.
    const p = parsed({ items: [item({ rowNo: 1, qty: 72, price: 29.51, sum: 72 })] });
    const problems = checkMoneyAgainstExpectation(p, {
      docNumber: '1421',
      consignee: { name: '', inn: null, kpp: null },
      items: [{ rowNo: 1, qty: 72, price: null, sum: null }],
    });
    expect(problems.map((m) => m.detail)).toEqual([
      expect.stringContaining('цена в бумаге не напечатана'),
      expect.stringContaining('сумма в бумаге не напечатана'),
    ]);
  });

  it('неразмеченное поле не сверяется — это не то же самое, что null', () => {
    // В эталоне только количество: цену никто не проверял, и придираться к ней
    // нельзя, иначе вся неразмеченная часть корпуса станет «регрессией».
    const p = parsed({ items: [item({ rowNo: 1, qty: 72, price: 29.51, sum: 72 })] });
    const problems = checkMoneyAgainstExpectation(p, {
      docNumber: '1421',
      consignee: { name: '', inn: null, kpp: null },
      items: [{ rowNo: 1, qty: 72 }],
    });
    expect(problems).toEqual([]);
  });

  it('итоги документа сверяются, когда размечены', () => {
    const p = parsed({ totalSum: 72, vatSum: null });
    const problems = checkMoneyAgainstExpectation(p, {
      docNumber: '1421',
      consignee: { name: '', inn: null, kpp: null },
      totalSum: 47600,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.where).toBe('итог документа');
  });

  it('без эталона молчит', () => {
    expect(checkMoneyAgainstExpectation(parsed(), undefined)).toEqual([]);
  });
});

describe('evaluateGate — деньги блокируют активацию', () => {
  /**
   * Правило сознательно смягчено против первой редакции.
   *
   * Было: любое расхождение с эталоном по деньгам — блокер, даже если обе
   * версии ошиблись одинаково. Замысел верный (одинаковая ошибка не должна
   * выглядеть успехом), но на практике такой гейт неисполним: модель ошибается
   * и на активном промпте, поэтому «ноль расхождений» недостижимо, и запрет
   * висел бы на КАЖДОЙ новой версии — включая ту, что чинит эти же ошибки.
   *
   * Стало: блокируют расхождения, которых у базовой версии не было. Общие с
   * базой остаются в отчёте с пометкой «было и в базе» — они описывают то, что
   * происходит на бою прямо сейчас, и держать из-за них улучшение бессмысленно.
   */
  const comparison = (over: Partial<UnitComparison>): UnitComparison => ({
    label: 'a.pdf',
    unstable: [],
    unstableCritical: [],
    changed: [],
    changedCritical: [],
    changedDetails: [],
    confidenceShift: null,
    expectation: { status: 'ok' },
    moneyMismatches: [],
    baseExpectation: { status: 'ok' },
    baseMoneyMismatches: [],
    ...over,
  });

  const rowMismatch = { where: 'строка 1', detail: 'сумма: ожидалось 20.00, получено 72.00' };

  it('расхождение сумм, появившееся у новой версии, — блокер', () => {
    const blockers = evaluateGate({
      checkedUnits: 1,
      failures: [],
      comparisons: [comparison({ moneyMismatches: [rowMismatch] })],
    });
    expect(blockers.some((b) => b.includes('НОВОЕ расхождение сумм с эталоном'))).toBe(true);
  });

  it('то же расхождение у обеих версий активацию не держит', () => {
    const blockers = evaluateGate({
      checkedUnits: 1,
      failures: [],
      comparisons: [
        comparison({ moneyMismatches: [rowMismatch], baseMoneyMismatches: [rowMismatch] }),
      ],
    });
    expect(blockers).toEqual([]);
  });

  it('новое расхождение видно даже рядом с унаследованным', () => {
    // Строка 1 сломана у обеих версий, строка 2 — только у новой. Гейт обязан
    // среагировать на вторую и не «утонуть» в первой.
    const fresh = { where: 'строка 2', detail: 'цена: ожидалось 40.27, получено 540.27' };
    const blockers = evaluateGate({
      checkedUnits: 1,
      failures: [],
      comparisons: [
        comparison({
          moneyMismatches: [rowMismatch, fresh],
          baseMoneyMismatches: [rowMismatch],
        }),
      ],
    });
    expect(blockers.some((b) => b.includes('НОВОЕ расхождение сумм с эталоном: 1 док. / 1 полей'))).toBe(
      true,
    );
  });
});

describe('snapshotOf — ключ позиции', () => {
  const item = (over: Record<string, unknown>) => ({ ...parsed().items[0]!, ...over });

  it('перестановка строк с номерами не даёт ложного расхождения', () => {
    // Один и тот же разбор, порядок строк в ответе модели разный. По индексу
    // массива это выглядело бы как расхождение обеих позиций сразу.
    const a = snapshotOf(
      parsed({
        items: [
          item({ rowNo: 1, nameRaw: 'Первая', qty: 1 }),
          item({ rowNo: 2, nameRaw: 'Вторая', qty: 2 }),
        ],
      }),
    );
    const b = snapshotOf(
      parsed({
        items: [
          item({ rowNo: 2, nameRaw: 'Вторая', qty: 2 }),
          item({ rowNo: 1, nameRaw: 'Первая', qty: 1 }),
        ],
      }),
    );
    expect(diffKeys(a, b)).toEqual([]);
  });

  it('без номеров ключ остаётся индексом — сравнение не пропадает', () => {
    const a = snapshotOf(parsed({ items: [item({ rowNo: null, qty: 1 })] }));
    const b = snapshotOf(parsed({ items: [item({ rowNo: null, qty: 2 })] }));
    expect(diffKeys(a, b)).toContain('items[0].qty');
  });

  it('номера дублируются — тоже индекс: доверять такому ключу нельзя', () => {
    const a = snapshotOf(parsed({ items: [item({ rowNo: 1, qty: 1 }), item({ rowNo: 1, qty: 2 })] }));
    expect(Object.keys(a)).toContain('items[0].qty');
    expect(Object.keys(a)).toContain('items[1].qty');
  });

  it('критическим считается и ключ по номеру строки', () => {
    expect(isCriticalKey('items[row1].qty')).toBe(true);
    expect(isCriticalKey('items[0].qty')).toBe(true);
    expect(isCriticalKey('items[row1].groupName')).toBe(false);
  });
});
