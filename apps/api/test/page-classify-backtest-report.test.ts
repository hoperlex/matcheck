/**
 * Ворота безопасности разреза по номеру документа.
 *
 * Механизм разреза (UPD_ASSEMBLY_SPLIT_BY_DOC_NUMBER) готов давно, но включать
 * его нельзя, пока бэктест не докажет: ни одна страница-шапка не потеряна и ни
 * одна граница не сдвинута незаметно. Прежний отчёт этого не доказывал, и тесты
 * ниже держат ровно те два случая, которые он пропускал.
 */
import { describe, expect, it } from 'vitest';
import {
  analyseBundle,
  boundaries,
  safetyGate,
  type BundleReport,
} from '../src/domain/edo/page-classify-backtest-report.js';
import type { PageClassification } from '../src/domain/edo/upd-page-prefilter.js';

const MAX_PAGES = 5;

const page = (
  n: number,
  type: PageClassification['type'],
  over: Partial<PageClassification> = {},
): PageClassification => ({ page: n, type, use: type !== 'certificate', ...over });

function run(
  baseline: PageClassification[],
  next: PageClassification[],
  pageCount: number,
  repeats?: PageClassification[][],
): BundleReport {
  return analyseBundle({
    bundleId: 'b1',
    pageCount,
    maxPagesPerSegment: MAX_PAGES,
    baseline,
    next,
    ...(repeats ? { repeats } : {}),
  });
}

describe('потерянные шапки', () => {
  it('страница, которую модель не вернула вовсе, считается потерянной шапкой', () => {
    // Главный дефект прежнего отчёта: он обходил только новый ответ, и такая
    // страница в счётчик не попадала — самый плохой исход выглядел как чистый.
    const baseline = [page(1, 'upd_main'), page(2, 'upd_main')];
    const next = [page(1, 'upd_main', { docNumber: 'A-1' })];

    const report = run(baseline, next, 2);
    expect(report.missingNew).toEqual([2]);
    expect(report.lostMain).toEqual([{ page: 2, became: 'нет в ответе' }]);
    expect(safetyGate([report]).passed).toBe(false);
  });

  it('шапка, ставшая продолжением, тоже потеряна', () => {
    const baseline = [page(1, 'upd_main'), page(2, 'upd_main')];
    const next = [page(1, 'upd_main'), page(2, 'upd_continuation')];

    const report = run(baseline, next, 2);
    expect(report.lostMain).toEqual([{ page: 2, became: 'upd_continuation' }]);
    expect(safetyGate([report]).lostMain).toBe(1);
  });

  it('страница, которой не было и в эталоне, шапкой не считается', () => {
    // Пропуск, унаследованный от прежнего промпта, — не регресс нового.
    const baseline = [page(1, 'upd_main')];
    const next = [page(1, 'upd_main')];

    const report = run(baseline, next, 2);
    expect(report.missingBaseline).toEqual([2]);
    expect(report.missingNew).toEqual([2]);
    expect(report.lostMain).toEqual([]);
    // Ворота всё равно закрыты: страница не вернулась из модели.
    expect(safetyGate([report]).passed).toBe(false);
  });
});

describe('границы нарезки', () => {
  it('сдвиг границы виден при ТОМ ЖЕ числе сегментов', () => {
    // Прежний отчёт сравнивал длины списков: 2 и 2 — «изменений нет». А это
    // ровно та ошибка, из-за которой страница уезжает в чужой документ.
    const baseline = [
      page(1, 'upd_main'),
      page(2, 'upd_continuation'),
      page(3, 'upd_main'),
      page(4, 'upd_continuation'),
    ];
    const next = [
      page(1, 'upd_main', { docNumber: 'A-1' }),
      page(2, 'upd_continuation'),
      page(3, 'upd_continuation'),
      page(4, 'upd_main', { docNumber: 'A-2' }),
    ];

    const report = run(baseline, next, 4);
    expect(report.boundariesBefore).toBe('1-2|3-4');
    expect(report.boundariesAfter).toBe('1-3|4');
    expect(report.boundariesBefore).not.toBe(report.boundariesAfter);
    expect(safetyGate([report]).boundariesChanged).toBe(1);
  });

  it('неизменная нарезка не отмечается как изменение', () => {
    const cls = [page(1, 'upd_main'), page(2, 'upd_continuation')];
    const report = run(cls, [page(1, 'upd_main', { docNumber: 'A-1' }), page(2, 'upd_continuation')], 2);
    expect(report.boundariesBefore).toBe(report.boundariesAfter);
    expect(safetyGate([report]).boundariesChanged).toBe(0);
  });

  it('границы печатаются диапазонами, одиночная страница — числом', () => {
    expect(boundaries([{ pages: [1, 2] }, { pages: [3] }])).toBe('1-2|3');
    // Порядок страниц внутри сегмента может быть не возрастающим
    // (preserveOrder), границы всё равно считаются по краям.
    expect(boundaries([{ pages: [3, 1, 2] }])).toBe('1-3');
  });
});

describe('уверенность нарезки и разброс модели', () => {
  it('потеря confident фиксируется отдельно от потери шапок', () => {
    // Страница, которую новый промпт не отнёс ни к чему, делает сегмент
    // uncertain: документ уйдёт прежним путём. Это не потеря, но знать надо.
    const baseline = [page(1, 'upd_main'), page(2, 'upd_continuation')];
    const next = [page(1, 'upd_main', { docNumber: 'A-1' }), page(2, 'unknown')];

    const report = run(baseline, next, 2);
    expect(report.lostMain).toEqual([]);
    expect(report.confidentBefore).toBe(true);
    expect(safetyGate([report]).confidenceLost).toBe(report.confidentAfter ? 0 : 1);
  });

  it('разброс самого промпта между повторами отмечается отдельно', () => {
    // Иначе колебание модели зачлось бы как эффект нового промпта.
    const baseline = [page(1, 'upd_main'), page(2, 'upd_main')];
    const first = [page(1, 'upd_main'), page(2, 'upd_main')];
    const second = [page(1, 'upd_main'), page(2, 'upd_continuation')];

    const report = run(baseline, first, 2, [first, second]);
    expect(report.unstablePages).toEqual([2]);
    // Сам прогон при этом чист: в `next` шапка на месте.
    expect(report.lostMain).toEqual([]);
  });

  it('без повторов разброс не измеряется и ложных пометок не даёт', () => {
    const cls = [page(1, 'upd_main')];
    expect(run(cls, cls, 1).unstablePages).toEqual([]);
  });
});

describe('что НЕ входит в ворота', () => {
  it('доля прочитанных номеров на ворота не влияет', () => {
    // Это метрика пользы: правило просто не сработает. Опасности в ней нет,
    // и заваливать ею выпуск нельзя.
    const baseline = [page(1, 'upd_main'), page(2, 'upd_main')];
    const next = [page(1, 'upd_main'), page(2, 'upd_main')];

    const report = run(baseline, next, 2);
    expect(report.mainPages).toBe(2);
    expect(report.mainWithNumber).toBe(0);
    expect(safetyGate([report]).passed).toBe(true);
  });

  it('изменение границ само по себе провалом не считается', () => {
    // Ради разреза всё и затевалось — но каждую границу надо разметить руками.
    const baseline = [page(1, 'upd_main'), page(2, 'upd_continuation')];
    const next = [
      page(1, 'upd_main', { docNumber: 'A-1' }),
      page(2, 'upd_main', { docNumber: 'A-2' }),
    ];

    const gate = safetyGate([run(baseline, next, 2)]);
    expect(gate.boundariesChanged).toBe(1);
    expect(gate.passed).toBe(true);
  });

  it('пустой набор ворота НЕ проходит', () => {
    // Ноль пакетов даёт ноль потерь. Без этой проверки прогон, где все пакеты
    // отвалились на подготовке страниц, объявил бы разрез безопасным, ничего
    // не проверив.
    const gate = safetyGate([]);
    expect(gate.passed).toBe(false);
    expect(gate.boundariesChanged).toBe(0);
  });
});
