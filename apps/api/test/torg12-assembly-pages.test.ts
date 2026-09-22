/**
 * Поведение сборки при новом типе страницы `m15`.
 *
 * Тип появляется только у промпта с ТОРГ-12. Два требования, и оба про
 * сохранность: страница М-15 не должна выпадать из разбора (иначе файл,
 * состоящий из одних таких страниц, остался бы без документа вовсе), а
 * однородный файл М-15 при откате обязан уехать к своему парсеру, а не в
 * УПД, где он оседал пустым черновиком.
 */
import { describe, expect, it } from 'vitest';
import { planUpdSegments, rollbackKindsByFile } from '../src/domain/edo/upd-assembly.js';
import type { PageClassification } from '../src/domain/edo/upd-page-prefilter.js';

const cls = (page: number, type: PageClassification['type']): PageClassification => ({
  page,
  type,
  use: true,
});
const ref = (globalPage: number, registryItemId: string | null) => ({ globalPage, registryItemId });

describe('страница М-15 в плане сегментов', () => {
  it('не отбрасывается как чужая — ведёт себя как «прочее»', () => {
    const plan = planUpdSegments([cls(1, 'upd_main'), cls(2, 'm15')], 2, 5);
    expect(plan.droppedPages).toEqual([]);
    expect(plan.segments.flatMap((s) => s.pages)).toEqual([1, 2]);
  });

  it('накладная и сертификат отбрасываются как раньше', () => {
    const plan = planUpdSegments(
      [cls(1, 'upd_main'), cls(2, 'transport_waybill'), cls(3, 'certificate')],
      3,
      5,
    );
    expect(plan.droppedPages.map((d) => d.type)).toEqual(['transport_waybill', 'certificate']);
    expect(plan.segments.flatMap((s) => s.pages)).toEqual([1]);
  });
});

describe('rollbackKindsByFile: форма М-15', () => {
  it('однородный файл М-15 уходит к своему парсеру', () => {
    const kinds = rollbackKindsByFile([cls(1, 'm15'), cls(2, 'm15')], [ref(1, 'f1'), ref(2, 'f1')]);
    expect(kinds.get('f1')).toBe('m15');
  });

  it('М-15 вперемешку с УПД — маршрут прежний, угадывать нельзя', () => {
    const kinds = rollbackKindsByFile(
      [cls(1, 'upd_main'), cls(2, 'm15')],
      [ref(1, 'f1'), ref(2, 'f1')],
    );
    expect(kinds.has('f1')).toBe(false);
  });

  it('прежние виды не задеты', () => {
    expect(
      rollbackKindsByFile([cls(1, 'transport_waybill')], [ref(1, 'f1')]).get('f1'),
    ).toBe('transport_waybill');
    expect(rollbackKindsByFile([cls(1, 'certificate')], [ref(1, 'f1')]).get('f1')).toBe(
      'supplementary',
    );
  });
});
