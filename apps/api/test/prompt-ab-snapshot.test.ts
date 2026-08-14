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
import {
  checkConsigneeAgainstExpectation,
  compareUnit,
  confidenceBucket,
  diffKeys,
  evaluateGate,
  isCriticalKey,
  matchExpectation,
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
      'регрессии стабильных полей: 1',
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
