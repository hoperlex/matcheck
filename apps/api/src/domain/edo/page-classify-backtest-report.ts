/**
 * Разбор одного пакета в бэктесте промпта классификации страниц.
 *
 * Вынесено из scripts/page-classify-number-backtest.ts, потому что именно
 * здесь живут ВОРОТА БЕЗОПАСНОСТИ разреза по номеру документа: потеряна ли
 * страница-шапка и сдвинулись ли границы нарезки. Проверить это в скрипте
 * можно было бы только платным прогоном по бою — то есть на практике никогда.
 *
 * Прежняя версия отчёта давала ложное спокойствие сразу двумя способами:
 *
 *   1. потерянные шапки считались обходом ТОЛЬКО нового ответа модели. Если
 *      модель страницу не вернула вовсе — самый плохой исход — цикл по ней не
 *      проходил, и счётчик оставался нулём;
 *   2. изменение нарезки фиксировалось по ЧИСЛУ сегментов. Сдвиг границы при
 *      том же количестве (1-2|3-5 → 1-3|4-5) выглядел как «ничего не
 *      изменилось».
 */
import { planUpdSegments } from './upd-assembly.js';
import type { PageClassification } from './upd-page-prefilter.js';

/** Границы нарезки строкой: «1-2|3-5». Именно они, а не число сегментов. */
export function boundaries(segments: Array<{ pages: number[] }>): string {
  return segments
    .map((s) => {
      const pages = [...s.pages].sort((a, b) => a - b);
      const first = pages[0];
      const last = pages[pages.length - 1];
      if (first == null || last == null) return '∅';
      return first === last ? String(first) : `${first}-${last}`;
    })
    .join('|');
}

export type BundleReport = {
  bundleId: string;
  pages: number;
  /** Страницы, которых нет в ответе модели вовсе. */
  missingBaseline: number[];
  missingNew: number[];
  /** Страница была шапкой в эталоне, а в новом ответе перестала ею быть. */
  lostMain: Array<{ page: number; became: string }>;
  typeChanges: Array<{ page: number; from: string; to: string; docNumber?: string }>;
  mainPages: number;
  mainWithNumber: number;
  boundariesBefore: string;
  boundariesAfter: string;
  confidentBefore: boolean;
  confidentAfter: boolean;
  /** Страницы, где разошёлся сам новый промпт между повторными вызовами. */
  unstablePages: number[];
};

export function analyseBundle(args: {
  bundleId: string;
  pageCount: number;
  maxPagesPerSegment: number;
  baseline: PageClassification[];
  next: PageClassification[];
  /** Повторные прогоны НОВОГО промпта, включая `next`. Один — разброс не мерим. */
  repeats?: PageClassification[][];
}): BundleReport {
  const { bundleId, pageCount, maxPagesPerSegment, baseline, next } = args;
  const repeats = args.repeats ?? [next];
  const byBase = new Map(baseline.map((c) => [c.page, c]));
  const byNext = new Map(next.map((c) => [c.page, c]));

  const report: BundleReport = {
    bundleId,
    pages: pageCount,
    missingBaseline: [],
    missingNew: [],
    lostMain: [],
    typeChanges: [],
    mainPages: 0,
    mainWithNumber: 0,
    boundariesBefore: '',
    boundariesAfter: '',
    confidentBefore: false,
    confidentAfter: false,
    unstablePages: [],
  };

  // Обход по ВСЕМ страницам пакета, а не по ответу модели: страница, которую
  // модель не вернула, — худший случай, и прежний счётчик её пропускал.
  for (let page = 1; page <= pageCount; page += 1) {
    const before = byBase.get(page);
    const after = byNext.get(page);
    if (!before) report.missingBaseline.push(page);
    if (!after) report.missingNew.push(page);

    if (before?.type === 'upd_main') {
      report.mainPages += 1;
      if (after?.docNumber != null) report.mainWithNumber += 1;
      if (!after) report.lostMain.push({ page, became: 'нет в ответе' });
      else if (after.type !== 'upd_main') report.lostMain.push({ page, became: after.type });
    }
    if (before && after && before.type !== after.type) {
      report.typeChanges.push({
        page,
        from: before.type,
        to: after.type,
        ...(after.docNumber != null ? { docNumber: after.docNumber } : {}),
      });
    }
    // Нестабильность самого нового промпта: тип страницы разошёлся между его
    // же повторными вызовами. Такие страницы нельзя записывать в «эффект
    // промпта» — это разброс модели.
    if (repeats.length > 1) {
      const types = new Set(repeats.map((r) => r.find((c) => c.page === page)?.type ?? '∅'));
      if (types.size > 1) report.unstablePages.push(page);
    }
  }

  const planBefore = planUpdSegments(baseline, pageCount, maxPagesPerSegment);
  const planAfter = planUpdSegments(next, pageCount, maxPagesPerSegment, {
    splitByDocNumber: true,
  });
  report.boundariesBefore = boundaries(planBefore.segments);
  report.boundariesAfter = boundaries(planAfter.segments);
  report.confidentBefore = planBefore.confident;
  report.confidentAfter = planAfter.confident;
  return report;
}

/**
 * Ворота безопасности по набору пакетов.
 *
 * Проходят ТОЛЬКО при нуле потерянных шапок и нуле страниц, не вернувшихся из
 * модели. Изменившиеся границы провалом не считаются — ради них всё и
 * затевалось, — но каждую нужно разметить глазами по оригиналу, поэтому они
 * отдаются отдельным числом. Доля прочитанных номеров в ворота не входит
 * вовсе: она измеряет пользу правила, а не его безопасность.
 *
 * Пустой набор ворота НЕ проходит. Ноль пакетов даёт ноль потерь, и без этой
 * проверки прогон, где все пакеты отвалились на подготовке страниц, выдал бы
 * «ВОРОТА ПРОЙДЕНЫ», ничего не проверив.
 */
export function safetyGate(reports: BundleReport[]): {
  passed: boolean;
  lostMain: number;
  missingNew: number;
  boundariesChanged: number;
  confidenceLost: number;
} {
  const lostMain = reports.reduce((a, r) => a + r.lostMain.length, 0);
  const missingNew = reports.reduce((a, r) => a + r.missingNew.length, 0);
  return {
    passed: reports.length > 0 && lostMain === 0 && missingNew === 0,
    lostMain,
    missingNew,
    boundariesChanged: reports.filter((r) => r.boundariesBefore !== r.boundariesAfter).length,
    confidenceLost: reports.filter((r) => r.confidentBefore && !r.confidentAfter).length,
  };
}
