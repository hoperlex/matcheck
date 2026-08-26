/**
 * Тесты на прогон корпуса ЧАСТЯМИ.
 *
 * Полный корпус — около 180 вызовов модели, поэтому его гоняют окнами. Цена
 * ошибки здесь тихая и потому неприятная: сдвинутое окно оставляет кусок
 * корпуса непроверенным, а вердикт «регрессий нет» выглядит точно так же, как
 * после полного прогона. Ни одна из этих ошибок не проявляется на экране —
 * только тестом.
 */
import { describe, it, expect } from 'vitest';
import type { UnitComparison } from '../scripts/prompt-ab-lib.js';
import {
  coverageOf,
  evaluateGate,
  identityDiff,
  missingReportFields,
  mixedModelPrompts,
  parseIntArg,
  windowOf,
} from '../scripts/prompt-ab-lib.js';

/** Минимальное сравнение без замечаний: гейт на нём молчит. */
function clean(label: string): UnitComparison {
  return {
    label,
    unstable: [],
    unstableCritical: [],
    changed: [],
    confidenceShift: null,
    expectation: { status: 'ok' },
    moneyMismatches: [],
    changedDetails: [],
    changedCritical: [],
    baseExpectation: { status: 'ok' },
    baseMoneyMismatches: [],
  };
}

describe('parseIntArg — числовые аргументы', () => {
  it('без аргумента возвращает значение по умолчанию', () => {
    expect(parseIntArg(null, '--limit', 42)).toBe(42);
    expect(parseIntArg(undefined, '--limit', 0)).toBe(0);
  });

  it('читает корректное целое, включая ноль', () => {
    expect(parseIntArg('5', '--limit', 1)).toBe(5);
    expect(parseIntArg('0', '--offset', 7)).toBe(0);
  });

  it('на мусоре ПАДАЕТ, а не прогоняет весь корпус', () => {
    // Главный смысл функции. Прежнее поведение: Number('abc') = NaN,
    // Number.isFinite(NaN) = false, slice(0, undefined) — то есть опечатка
    // молча превращала «прогони 5 файлов» в «прогони все 39».
    expect(() => parseIntArg('abc', '--limit', 5)).toThrow(/--limit/);
    expect(() => parseIntArg('', '--limit', 5)).toThrow(/--limit/);
    expect(() => parseIntArg('2.5', '--limit', 5)).toThrow(/целое/);
    expect(() => parseIntArg('-1', '--offset', 0)).toThrow(/≥ 0/);
    expect(() => parseIntArg('Infinity', '--limit', 5)).toThrow();
  });

  it('в сообщении назван флаг — иначе непонятно, что править в команде', () => {
    expect(() => parseIntArg('x', '--offset', 0)).toThrow(/--offset: ожидается целое число ≥ 0/);
  });
});

describe('windowOf — окно прогона', () => {
  const corpus = Array.from({ length: 39 }, (_, i) => `file-${i}.pdf`);

  it('последовательные окна покрывают корпус без пропусков и повторов', () => {
    const size = 5;
    const collected: string[] = [];
    for (let offset = 0; offset < corpus.length; offset += size) {
      collected.push(...windowOf(corpus, offset, size));
    }
    // Именно равенство списков, а не длин: перестановка или повтор файла
    // означали бы, что части сложились не в исходный корпус.
    expect(collected).toEqual(corpus);
  });

  it('последнее окно не выходит за конец корпуса', () => {
    expect(windowOf(corpus, 35, 5)).toHaveLength(4);
    expect(windowOf(corpus, 39, 5)).toEqual([]);
    expect(windowOf(corpus, 100, 5)).toEqual([]);
  });

  it('без --limit берётся весь остаток', () => {
    expect(windowOf(corpus, 0, Number.MAX_SAFE_INTEGER)).toEqual(corpus);
    expect(windowOf(corpus, 37, Number.MAX_SAFE_INTEGER)).toHaveLength(2);
  });
});

describe('coverageOf — полнота прогона по частям', () => {
  it('части подряд дают полное покрытие', () => {
    const windows = [
      { offset: 0, taken: 5 },
      { offset: 5, taken: 5 },
      { offset: 10, taken: 2 },
    ];
    expect(coverageOf(windows, 12)).toEqual({ covered: 12, overlaps: 0, missing: [] });
  });

  it('пропущенный кусок назван поимённо', () => {
    // Пропуск опаснее пересечения: это документы, которые никто не проверял,
    // а отчёт без них выглядит полноценным.
    const { missing, covered } = coverageOf(
      [
        { offset: 0, taken: 5 },
        { offset: 7, taken: 3 },
      ],
      10,
    );
    expect(missing).toEqual([5, 6]);
    expect(covered).toBe(8);
  });

  it('пересечение окон посчитано отдельно от покрытия', () => {
    const { covered, overlaps, missing } = coverageOf(
      [
        { offset: 0, taken: 5 },
        { offset: 3, taken: 5 },
      ],
      8,
    );
    expect(covered).toBe(8);
    expect(overlaps).toBe(2);
    expect(missing).toEqual([]);
  });

  it('пустой список частей — весь корпус не проверен', () => {
    expect(coverageOf([], 3)).toEqual({ covered: 0, overlaps: 0, missing: [0, 1, 2] });
  });
});

describe('свод частей равен единому прогону', () => {
  it('гейт на объединении частей даёт тот же вердикт, что на целом наборе', () => {
    const whole = [clean('a'), clean('b'), clean('c'), clean('d')];
    const parts = [whole.slice(0, 2), whole.slice(2)];

    const gateWhole = evaluateGate({ checkedUnits: whole.length, failures: [], comparisons: whole });
    const merged = parts.flat();
    const gateMerged = evaluateGate({
      checkedUnits: merged.length,
      failures: [],
      comparisons: merged,
    });

    expect(gateMerged).toEqual(gateWhole);
    expect(gateMerged).toEqual([]);
  });

  it('регресс в ОДНОЙ части блокирует весь свод', () => {
    // Часть, где всё чисто, разрешением не является: вердикт считается по
    // всему корпусу.
    const good = [clean('a'), clean('b')];
    const bad = [{ ...clean('c'), changed: ['docNumber'], changedCritical: ['docNumber'] }];

    expect(evaluateGate({ checkedUnits: good.length, failures: [], comparisons: good })).toEqual([]);

    const merged = [...good, ...bad];
    const blockers = evaluateGate({
      checkedUnits: merged.length,
      failures: [],
      comparisons: merged,
    });
    expect(blockers.join('; ')).toMatch(/регрессии критических полей: 1/);
  });
});

describe('missingReportFields — пригодность отчёта к сведению', () => {
  const full = {
    formatVersion: 1,
    docKind: 'upd',
    window: { offset: 0, limit: 5, selected: 39, taken: 5 },
    corpus: { manifestSha256: 'abc' },
    prompts: {
      base: { id: 'b', sha256: 'h1' },
      fresh: { id: 'f', sha256: 'h2' },
    },
    git: { sha: null, dirty: null },
    calls: [],
    failures: [],
    comparisons: [],
  };

  it('полный отчёт претензий не вызывает', () => {
    expect(missingReportFields(full)).toEqual([]);
  });

  it('отчёт без хеша промпта отвергается', () => {
    // Без хеша нельзя доказать, что части сравнивали один и тот же текст:
    // промпты неизменяемы по замыслу, но PATCH их менять позволяет.
    const broken = { ...full, prompts: { base: { id: 'b' }, fresh: { id: 'f', sha256: 'h2' } } };
    expect(missingReportFields(broken)).toEqual(['prompts.base.sha256']);
  });

  it('отчёт без списка вызовов отвергается', () => {
    const { calls: _calls, ...broken } = full;
    expect(missingReportFields(broken)).toContain('calls');
  });

  it('git с пустым sha полем считается заполненным', () => {
    // В прод-образе .git отсутствует, и sha честно равен null. Это не повод
    // отвергать отчёт — важно, что поле присутствует и не выдумано.
    expect(missingReportFields({ ...full, git: { sha: null, dirty: null } })).toEqual([]);
  });

  it('мусор вместо отчёта не роняет проверку', () => {
    expect(missingReportFields(null).length).toBeGreaterThan(0);
    expect(missingReportFields('строка').length).toBeGreaterThan(0);
  });
});

describe('mixedModelPrompts — достоверность сравнения', () => {
  const GEMINI = 'google/gemini-3-flash-preview';
  const QWEN = 'qwen/qwen3.6-plus';

  it('одна модель на промпт — претензий нет', () => {
    const calls = [
      { promptId: 'base', model: GEMINI },
      { promptId: 'base', model: GEMINI },
      { promptId: 'fresh', model: GEMINI },
    ];
    expect(mixedModelPrompts(calls).size).toBe(0);
  });

  it('две модели на одном промпте — находит и называет обе', () => {
    // Ровно тот случай, ради которого модель пишется в отчёт: текстовый путь
    // при ошибке молча уходит к следующему провайдеру, и тогда сравниваются
    // не два промпта, а две модели.
    const calls = [
      { promptId: 'base', model: GEMINI },
      { promptId: 'base', model: QWEN },
      { promptId: 'fresh', model: GEMINI },
    ];
    const mixed = mixedModelPrompts(calls);
    expect([...mixed.keys()]).toEqual(['base']);
    expect(mixed.get('base')).toEqual([GEMINI, QWEN]);
  });

  it('разные промпты на разных моделях — это НЕ смешение', () => {
    // Здесь каждая версия целиком отработала своей моделью. Сравнивать всё
    // равно нельзя, но ловится это сравнением версий, а не этой проверкой:
    // смешение — про непостоянство внутри одной версии.
    const calls = [
      { promptId: 'base', model: GEMINI },
      { promptId: 'fresh', model: QWEN },
    ];
    expect(mixedModelPrompts(calls).size).toBe(0);
  });

  it('вызовы без промпта или без модели не учитываются', () => {
    // Классификатор страниц пишет строку с promptId = null: это служебный
    // вызов, к сравнению версий он отношения не имеет.
    const calls = [
      { promptId: null, model: GEMINI },
      { promptId: 'base', model: null },
      { promptId: 'base', model: GEMINI },
    ];
    expect(mixedModelPrompts(calls).size).toBe(0);
  });

  it('пустой журнал не считается смешением', () => {
    expect(mixedModelPrompts([]).size).toBe(0);
  });
});

describe('identityDiff — можно ли сводить части', () => {
  const base = {
    docKind: 'upd',
    prompts: {
      base: { name: 'default v13', sha256: 'a'.repeat(64) },
      fresh: { name: 'default v15', sha256: 'b'.repeat(64) },
    },
    corpus: { manifestSha256: 'c'.repeat(64) },
    git: { sha: 'deadbeef' },
  };

  it('одинаковые условия — сводить можно', () => {
    expect(identityDiff(base, structuredClone(base))).toEqual([]);
  });

  it('корпусный и сегментный прогоны не сводятся', () => {
    // Разные наборы проверяемых единиц: у одного единица — файл, у другого
    // сегмент комплекта. Сложив их, получили бы бессмысленное покрытие.
    const seg = { ...structuredClone(base), docKind: 'upd-segment' };
    expect(identityDiff(base, seg)).toEqual([
      'вид прогона: «upd» против «upd-segment»',
    ]);
  });

  it('подменённый текст промпта при том же имени виден', () => {
    // Промпты неизменяемы по замыслу, но PATCH их менять позволяет. Имя
    // осталось прежним — значит поймать подмену может только хеш.
    const patched = structuredClone(base);
    patched.prompts.fresh.sha256 = 'z'.repeat(64);
    const diff = identityDiff(base, patched);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatch(/новый промпт/);
  });

  it('смена эталона между частями видна', () => {
    const other = structuredClone(base);
    other.corpus.manifestSha256 = 'd'.repeat(64);
    expect(identityDiff(base, other)).toEqual([
      expect.stringContaining('эталон'),
    ]);
  });

  it('правка кода между частями видна', () => {
    // Парсер меняет результат так же, как текст промпта.
    const other = { ...structuredClone(base), git: { sha: 'cafebabe' } };
    expect(identityDiff(base, other)).toEqual([
      'код (git): «deadbeef» против «cafebabe»',
    ]);
  });

  it('несколько расхождений перечисляются все', () => {
    const other = structuredClone(base);
    other.docKind = 'upd-segment';
    other.git = { sha: null };
    expect(identityDiff(base, other)).toHaveLength(2);
  });
});
