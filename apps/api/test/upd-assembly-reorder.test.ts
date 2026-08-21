/**
 * Порядок файлов в пакете не решает судьбу нарезки.
 *
 * Инспектор выбирает файлы в проводнике, и порядок там произвольный. Нарезка
 * же идёт строго по возрастанию номера страницы и открывает сегмент только на
 * `upd_main`: продолжение, встреченное первым, создаёт защитную fallback-группу,
 * а она лишает доверия весь план — пакет разъезжается на «файл = документ».
 * Так двухстраничная УПД УТ-4011 превратилась в два документа с одним номером,
 * второй из которых пометили дубликатом.
 *
 * Перестановка узкая намеренно: два одностраничных файла, одна шапка, одно
 * продолжение. Всё остальное обязано вести себя ровно как до правки — это и
 * проверяет большая часть набора.
 */
import { describe, expect, it } from 'vitest';
import type { PageClassification } from '../src/domain/edo/upd-page-prefilter.js';
import {
  planUpdSegments,
  REORDERED_REASON,
  type PlanUpdSegmentsOptions,
} from '../src/domain/edo/upd-assembly.js';

const MAX_PAGES = 8;

const page = (n: number, type: PageClassification['type']): PageClassification => ({
  page: n,
  type,
  use: true,
});

/** Каждая страница — из своего файла: россыпь фотографий или сканов. */
const ownFilePerPage = (count: number): ReadonlyMap<number, number> =>
  new Map(Array.from({ length: count }, (_, i) => [i + 1, i]));

const withReorder = (owners: ReadonlyMap<number, number>): PlanUpdSegmentsOptions => ({
  pageOwners: owners,
  reorder: true,
});

describe('перестановка: шапка открывает документ, где бы её ни загрузили', () => {
  it('продолжение загружено первым — план становится достоверным', () => {
    // Ровно случай УТ-4011: файл inputOrder=0 дал продолжение, inputOrder=1 — шапку.
    const classification = [page(1, 'upd_continuation'), page(2, 'upd_main')];

    const plan = planUpdSegments(classification, 2, MAX_PAGES, withReorder(ownFilePerPage(2)));

    expect(plan.confident).toBe(true);
    expect(plan.segments).toHaveLength(1);
    // Порядок чтения, а не возрастание номеров: продолжение читается после шапки.
    expect(plan.segments[0]!.pages).toEqual([2, 1]);
    expect(plan.segments[0]!.confidence).toBe('normal');
    expect(plan.reasons).toContain(REORDERED_REASON);
  });

  it('без перестановки тот же вход разваливает пакет — фикс не холостой', () => {
    const classification = [page(1, 'upd_continuation'), page(2, 'upd_main')];

    const plan = planUpdSegments(classification, 2, MAX_PAGES);

    expect(plan.confident).toBe(false);
    expect(plan.reasons.join(' ')).toContain('continuation_without_main');
  });
});

describe('анти-регресс: всё остальное считается как раньше', () => {
  it('рубильник выключен — план побайтово прежний', () => {
    const classification = [page(1, 'upd_continuation'), page(2, 'upd_main')];

    const off = planUpdSegments(classification, 2, MAX_PAGES, {
      pageOwners: ownFilePerPage(2),
      reorder: false,
    });
    const legacy = planUpdSegments(classification, 2, MAX_PAGES);

    expect(off).toEqual(legacy);
  });

  it('шапка и так первая — план не меняется и отметки о перестановке нет', () => {
    const classification = [page(1, 'upd_main'), page(2, 'upd_continuation')];

    const withOpt = planUpdSegments(classification, 2, MAX_PAGES, withReorder(ownFilePerPage(2)));
    const legacy = planUpdSegments(classification, 2, MAX_PAGES);

    expect(withOpt).toEqual(legacy);
    expect(withOpt.confident).toBe(true);
    expect(withOpt.reasons).not.toContain(REORDERED_REASON);
  });

  it('три УПД вперемешку — перестановка не применяется', () => {
    // Шестифайловый пакет с боя: три шапки и три продолжения, первым идёт
    // продолжение. Какое продолжение к какой шапке — по типам не понять,
    // поэтому прежний откат остаётся единственным честным исходом.
    const classification = [
      page(1, 'upd_continuation'),
      page(2, 'upd_main'),
      page(3, 'upd_continuation'),
      page(4, 'upd_main'),
      page(5, 'upd_main'),
      page(6, 'upd_continuation'),
    ];

    const plan = planUpdSegments(classification, 6, MAX_PAGES, withReorder(ownFilePerPage(6)));

    expect(plan.confident).toBe(false);
    expect(plan.reasons).not.toContain(REORDERED_REASON);
  });

  it('обе страницы из одного файла — порядок листов PDF не трогаем', () => {
    const classification = [page(1, 'upd_continuation'), page(2, 'upd_main')];
    const sameFile: ReadonlyMap<number, number> = new Map([
      [1, 0],
      [2, 0],
    ]);

    const plan = planUpdSegments(classification, 2, MAX_PAGES, withReorder(sameFile));

    expect(plan.confident).toBe(false);
    expect(plan.reasons).not.toContain(REORDERED_REASON);
  });

  it('третий тип среди страниц — перестановка не применяется', () => {
    const classification = [page(1, 'upd_continuation'), page(2, 'other')];

    const plan = planUpdSegments(classification, 2, MAX_PAGES, withReorder(ownFilePerPage(2)));

    expect(plan.confident).toBe(false);
    expect(plan.reasons).not.toContain(REORDERED_REASON);
  });

  it('страница не упомянута классификатором — перестановка не применяется', () => {
    // Вторая страница отсутствует в ответе модели: она попадёт в сегментацию
    // как unknown, и доверять такому пакету нельзя независимо от порядка.
    const classification = [page(1, 'upd_continuation')];

    const plan = planUpdSegments(classification, 2, MAX_PAGES, withReorder(ownFilePerPage(2)));

    expect(plan.confident).toBe(false);
    expect(plan.reasons).not.toContain(REORDERED_REASON);
  });

  it('карты файлов нет — перестановка не применяется', () => {
    const classification = [page(1, 'upd_continuation'), page(2, 'upd_main')];

    const plan = planUpdSegments(classification, 2, MAX_PAGES, { reorder: true });

    expect(plan.confident).toBe(false);
    expect(plan.reasons).not.toContain(REORDERED_REASON);
  });

  it('отказ по другой причине не лечится перестановкой', () => {
    // Шапка первая, но страниц больше предела на сегмент: причина отказа иная,
    // и трогать порядок незачем.
    const classification = [
      page(1, 'upd_main'),
      page(2, 'upd_continuation'),
      page(3, 'upd_continuation'),
    ];

    const plan = planUpdSegments(classification, 3, 2, withReorder(ownFilePerPage(3)));

    expect(plan.confident).toBe(false);
    expect(plan.reasons.join(' ')).toContain('больше предела');
    expect(plan.reasons).not.toContain(REORDERED_REASON);
  });

  it('перестановка не помогла — отдаётся исходный план с исходной причиной', () => {
    // Два файла, шапка второй, но страниц всего две при пределе в одну:
    // после перестановки сегмент всё равно шире предела.
    const classification = [page(1, 'upd_continuation'), page(2, 'upd_main')];

    const plan = planUpdSegments(classification, 2, 1, withReorder(ownFilePerPage(2)));

    expect(plan.confident).toBe(false);
    expect(plan.reasons.join(' ')).toContain('continuation_without_main');
    expect(plan.reasons).not.toContain(REORDERED_REASON);
  });
});
