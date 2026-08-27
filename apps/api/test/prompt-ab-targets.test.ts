/**
 * Тесты на позитивный критерий допуска промпта.
 *
 * До этих правок гейт умел только запрещать: он ловил регрессии, но версия,
 * дословно повторившая поведение базы, проходила зелёной. Для промпта, который
 * выпускают РАДИ исправления конкретного дефекта, это не проверка вовсе —
 * «ничего не сломал» и «починил» выглядели одинаково.
 *
 * Числа взяты с боевого УПД № 223379, на котором дефект и зафиксирован: строка
 * 1, количество 10, стоимость с налогом 5 301,90, НДС 883,65. Цена в графе 4
 * равна (5301,90 − 883,65) / 10 = 441,825, а модель читала 530,19 — то есть
 * стоимость с налогом, делённую на количество.
 */
import { describe, it, expect } from 'vitest';
import type { UpdPdfParsed } from '@matcheck/contracts';
import {
  checkTargets,
  compareOutcome,
  evaluateGate,
  outcomeOf,
  revisionBlocker,
  type ExpectedDocument,
  type OutcomeSnapshot,
  type UnitComparison,
} from '../scripts/prompt-ab-lib.js';

/** Цена из графы 4, как напечатано в бланке. */
const PRICE_NET = 441.825;
/** Что читала база: стоимость С налогом, делённая на количество. */
const PRICE_GROSS = 530.19;

function parsed(price: number, over: Partial<UpdPdfParsed> = {}): UpdPdfParsed {
  return {
    docNumber: '223379',
    docDate: '2026-08-25',
    totalSum: 5301.9,
    vatSum: 883.65,
    itemsCount: 1,
    confidence: 0.9,
    supplier: { inn: '7743429410', kpp: null, name: 'ООО «Поставщик»' },
    recipient: { inn: '7736255508', kpp: null, name: 'ООО «СУ-10»' },
    consignee: null,
    items: [
      {
        rowNo: 1,
        nameRaw: 'Кабель ВВГнг 3х2.5',
        qty: 10,
        unit: 'м',
        price,
        sum: 5301.9,
        vatRate: 20,
        vatSum: 883.65,
        volumeM3: null,
        massKg: null,
        volumeConfidence: null,
        groupName: null,
      },
    ],
    ...over,
  } as UpdPdfParsed;
}

const expected: ExpectedDocument = {
  docNumber: '223379',
  consignee: { name: 'ООО «СУ-10»', inn: '7736255508', kpp: null },
  items: [{ rowNo: 1, price: PRICE_NET, mustFix: ['price'] }],
};

const outcome = (over: Partial<OutcomeSnapshot> = {}): OutcomeSnapshot => ({
  status: 'parsed',
  parseErrorCode: null,
  missing: [],
  ...over,
});

const comparison = (over: Partial<UnitComparison>): UnitComparison => ({
  label: '223379.pdf',
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
  outcomeShift: { from: 'parsed/без ошибки', to: 'parsed/без ошибки', regressed: false, detail: null },
  targets: [],
  ...over,
});

describe('revisionBlocker — прогон без отпечатка кода не начинается', () => {
  it('отпечаток есть — препятствий нет', () => {
    expect(revisionBlocker({ sha: 'deadbeef' })).toBeNull();
  });

  it('отпечатка нет — прогон останавливается и объясняет, что чинить', () => {
    // Ровно та дыра, из-за которой части с разных деплоев сводились молча: в
    // прод-образе нет `.git`, отпечаток был null у всех частей, и они
    // признавались снятыми на одном коде.
    const blocker = revisionBlocker({ sha: null });
    expect(blocker).toMatch(/BUILD_SHA/);
    expect(blocker).toMatch(/остановлен/);
  });
});

describe('compareOutcome — итог документа сравнивается НАПРАВЛЕННО', () => {
  it('parsed → needs_resolution блокирует: документ перестал доезжать', () => {
    const shift = compareOutcome(
      outcome(),
      outcome({ status: 'needs_resolution', parseErrorCode: 'partial_parse', missing: ['items'] }),
    );
    expect(shift.regressed).toBe(true);
    expect(shift.detail).toMatch(/перестал доезжать/);
  });

  it('needs_resolution → parsed НЕ блокирует — это и есть победа', () => {
    // Главная страховка правки. Симметричное сравнение (как у остальных
    // критических полей) запретило бы ровно то улучшение, ради которого версию
    // и выпускают.
    const shift = compareOutcome(
      outcome({ status: 'needs_resolution', parseErrorCode: 'partial_parse', missing: ['items'] }),
      outcome(),
    );
    expect(shift.regressed).toBe(false);
  });

  it('появившийся validation_mismatch — регресс', () => {
    const shift = compareOutcome(outcome(), outcome({ parseErrorCode: 'validation_mismatch' }));
    expect(shift.regressed).toBe(true);
    expect(shift.detail).toMatch(/validation_mismatch/);
  });

  it('исчезнувший validation_mismatch — улучшение', () => {
    expect(compareOutcome(outcome({ parseErrorCode: 'validation_mismatch' }), outcome()).regressed).toBe(
      false,
    );
  });

  it('ДОБАВИВШАЯСЯ причина partial_parse блокирует', () => {
    // Без разбора причин «нет номера» и «список неполон» выглядят одинаково,
    // хотя это разные болезни: первая чинится промптом, вторая — повтором.
    const shift = compareOutcome(
      outcome({ status: 'needs_resolution', parseErrorCode: 'partial_parse', missing: ['items'] }),
      outcome({
        status: 'needs_resolution',
        parseErrorCode: 'partial_parse',
        missing: ['docNumber', 'items'],
      }),
    );
    expect(shift.regressed).toBe(true);
    expect(shift.detail).toMatch(/docNumber/);
  });

  it('ушедшая причина при том же статусе не блокирует', () => {
    const shift = compareOutcome(
      outcome({
        status: 'needs_resolution',
        parseErrorCode: 'partial_parse',
        missing: ['docNumber', 'items'],
      }),
      outcome({ status: 'needs_resolution', parseErrorCode: 'partial_parse', missing: ['items'] }),
    );
    expect(shift.regressed).toBe(false);
  });
});

describe('outcomeOf — итог считается боевым правилом, а не выдуманным', () => {
  it('верно прочитанный документ доезжает до планшета', () => {
    expect(outcomeOf(parsed(PRICE_NET))).toEqual({
      status: 'parsed',
      parseErrorCode: null,
      missing: [],
    });
  });

  it('цена, взятая с НДС, ломает построчную арифметику', () => {
    // Именно так дефект и виден боевому коду: 10 × 530,19 = 5 301,90, а
    // стоимость без налога 4 418,25 — строка не сходится сама с собой.
    const o = outcomeOf(parsed(PRICE_GROSS));
    expect(o.status).toBe('parsed');
    expect(o.parseErrorCode).toBe('validation_mismatch');
  });

  it('неполный список позиций уводит документ в partial_parse', () => {
    // Тот самый случай, ради которого исход и сравнивается: itemsCount сам по
    // себе критическим полем не считается, а документ из-за него на планшет
    // не попадёт вовсе.
    const o = outcomeOf(parsed(PRICE_NET, { itemsCount: 5 }));
    expect(o.status).toBe('needs_resolution');
    expect(o.parseErrorCode).toBe('partial_parse');
    expect(o.missing).toContain('itemsIncomplete');
  });
});

describe('checkTargets — доказательство исправления', () => {
  it('база ошиблась дважды, новая версия прочитала графу 4 — исправлено', () => {
    const targets = checkTargets({
      a1: parsed(PRICE_GROSS),
      a2: parsed(PRICE_GROSS),
      b: parsed(PRICE_NET),
      expected,
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]!.status).toBe('исправлено');
    expect(targets[0]!.where).toBe('№ 223379, строка 1, цена');
  });

  it('новая версия повторила дефект — НЕ исправлено', () => {
    // Ровно то, что раньше проходило зелёным: версия ничего не сломала, но и
    // не починила, а гейт умел проверять только первое.
    const targets = checkTargets({
      a1: parsed(PRICE_GROSS),
      a2: parsed(PRICE_GROSS),
      b: parsed(PRICE_GROSS),
      expected,
    });
    expect(targets[0]!.status).toBe('не исправлено');
    expect(targets[0]!.detail).toMatch(/441\.8250/);
  });

  it('база прочитала верно — дефекта нет, доказывать нечего', () => {
    const targets = checkTargets({
      a1: parsed(PRICE_NET),
      a2: parsed(PRICE_NET),
      b: parsed(PRICE_NET),
      expected,
    });
    expect(targets[0]!.status).toBe('не воспроизвелось');
  });

  it('база дала разное в двух прогонах — случай недоказан, а не зелёный', () => {
    // Без этой проверки достаточно одного удачного прогона, чтобы объявить
    // дефект вылеченным. На сканах модель ошибается через раз, и такой
    // «зелёный» отчёт означал бы только везение.
    const targets = checkTargets({
      a1: parsed(PRICE_GROSS),
      a2: parsed(PRICE_NET),
      b: parsed(PRICE_NET),
      expected,
    });
    expect(targets[0]!.status).toBe('нестабильно');
  });

  it('строки нет в разборе новой версии — не исправлено', () => {
    const targets = checkTargets({
      a1: parsed(PRICE_GROSS),
      a2: parsed(PRICE_GROSS),
      b: parsed(PRICE_NET, { items: [] }),
      expected,
    });
    expect(targets[0]!.status).toBe('не исправлено');
    expect(targets[0]!.detail).toMatch(/строки с номером 1/);
  });

  it('цель помечена, а эталонного значения нет — так проверять нельзя', () => {
    const targets = checkTargets({
      a1: parsed(PRICE_GROSS),
      a2: parsed(PRICE_GROSS),
      b: parsed(PRICE_NET),
      expected: {
        ...expected,
        items: [{ rowNo: 1, mustFix: ['price'] }],
      },
    });
    expect(targets[0]!.status).toBe('не размечено');
  });

  it('без mustFix целей нет вовсе — обычные документы корпуса не затронуты', () => {
    const targets = checkTargets({
      a1: parsed(PRICE_GROSS),
      a2: parsed(PRICE_GROSS),
      b: parsed(PRICE_GROSS),
      expected: { ...expected, items: [{ rowNo: 1, price: PRICE_NET }] },
    });
    expect(targets).toEqual([]);
  });
});

describe('evaluateGate — цели и исход', () => {
  const base = { checkedUnits: 1, failures: [] };

  it('исправленная цель активацию не держит', () => {
    const blockers = evaluateGate({
      ...base,
      comparisons: [
        comparison({
          targets: [{ where: '№ 223379, строка 1, цена', status: 'исправлено', detail: '' }],
        }),
      ],
    });
    expect(blockers).toEqual([]);
  });

  it('неисправленная цель блокирует активацию', () => {
    const blockers = evaluateGate({
      ...base,
      comparisons: [
        comparison({
          targets: [{ where: '№ 223379, строка 1, цена', status: 'не исправлено', detail: '' }],
        }),
      ],
    });
    expect(blockers).toContain('целевой дефект НЕ исправлен: 1 стр.');
  });

  it('невоспроизведённый дефект блокирует: доказательства нет', () => {
    const blockers = evaluateGate({
      ...base,
      comparisons: [
        comparison({
          targets: [{ where: '№ 223379, строка 1, цена', status: 'не воспроизвелось', detail: '' }],
        }),
      ],
    });
    expect(blockers.join(' ')).toMatch(/не воспроизвёлся/);
  });

  it('нестабильная целевая строка блокирует', () => {
    const blockers = evaluateGate({
      ...base,
      comparisons: [
        comparison({
          targets: [{ where: '№ 223379, строка 1, цена', status: 'нестабильно', detail: '' }],
        }),
      ],
    });
    expect(blockers.join(' ')).toMatch(/нестабильна/);
  });

  it('ухудшившийся итог документа блокирует', () => {
    const blockers = evaluateGate({
      ...base,
      comparisons: [
        comparison({
          outcomeShift: {
            from: 'parsed/без ошибки',
            to: 'needs_resolution/partial_parse',
            regressed: true,
            detail: 'документ перестал доезжать до планшета',
          },
        }),
      ],
    });
    expect(blockers).toContain('итог документа ухудшился: 1');
  });

  it('улучшившийся итог документа НЕ блокирует', () => {
    const blockers = evaluateGate({
      ...base,
      comparisons: [
        comparison({
          outcomeShift: {
            from: 'needs_resolution/partial_parse',
            to: 'parsed/без ошибки',
            regressed: false,
            detail: null,
          },
        }),
      ],
    });
    expect(blockers).toEqual([]);
  });
});
