import { describe, expect, it } from 'vitest';
import {
  mergeClassificationChunks,
  pageRefsOfSegment,
  planUpdSegments,
  type AssemblyPage,
} from '../src/domain/edo/upd-assembly.js';
import type { PageClassification } from '../src/domain/edo/upd-page-prefilter.js';

const cls = (page: number, type: PageClassification['type']): PageClassification => ({
  page,
  type,
  use: type !== 'certificate' && type !== 'transport_waybill',
});

/** Страница-пустышка: планировщику важны только номера и адреса. */
const page = (globalPage: number, inputOrder: number, pageInFile = 1): AssemblyPage => ({
  ref: { registryItemId: `item-${inputOrder}`, inputOrder, pageInFile },
  globalPage,
  full: Buffer.alloc(0),
  thumb: Buffer.alloc(0),
});

describe('mergeClassificationChunks', () => {
  it('сдвигает номера страниц второй порции на размер первой', () => {
    const merged = mergeClassificationChunks(
      [
        [cls(1, 'upd_main'), cls(2, 'upd_continuation')],
        [cls(1, 'upd_main')],
      ],
      [2, 1],
    );
    expect(merged.map((c) => c.page)).toEqual([1, 2, 3]);
    expect(merged[2]!.type).toBe('upd_main');
  });

  it('считает сдвиг по размеру порции, а не по числу ответов', () => {
    // Модель не упомянула вторую страницу первой порции. Если сдвигать по
    // длине ответа, третья страница уехала бы на позицию второй.
    const merged = mergeClassificationChunks([[cls(1, 'upd_main')], [cls(1, 'upd_main')]], [2, 1]);
    expect(merged.map((c) => c.page)).toEqual([1, 3]);
  });
});

describe('planUpdSegments', () => {
  it('режет пакет по границам upd_main', () => {
    const plan = planUpdSegments(
      [cls(1, 'upd_main'), cls(2, 'upd_continuation'), cls(3, 'upd_main')],
      3,
      5,
    );
    expect(plan.confident).toBe(true);
    expect(plan.segments).toHaveLength(2);
    expect(plan.segments[0]!.pages).toEqual([1, 2]);
    expect(plan.segments[1]!.pages).toEqual([3]);
  });

  it('не теряет страницу, которую классификатор не упомянул', () => {
    // Модель вернула 1, 2 и 4 — третья страница в ответе отсутствует. Она
    // обязана остаться в сегменте, а сборка — признать себя ненадёжной.
    const plan = planUpdSegments(
      [cls(1, 'upd_main'), cls(2, 'upd_continuation'), cls(4, 'upd_main')],
      4,
      5,
    );
    const allPages = plan.segments.flatMap((s) => s.pages);
    expect(allPages).toContain(3);
    expect(plan.confident).toBe(false);
    expect(plan.reasons.join(' ')).toContain('не упомянул страницы: 3');
  });

  it('исключает сертификаты и накладные, но не считает это поводом для отката', () => {
    const plan = planUpdSegments(
      [cls(1, 'upd_main'), cls(2, 'certificate'), cls(3, 'upd_main')],
      3,
      5,
    );
    expect(plan.confident).toBe(true);
    expect(plan.segments.flatMap((s) => s.pages)).toEqual([1, 3]);
  });

  it('отбраковывает сегмент длиннее предела страниц', () => {
    const plan = planUpdSegments(
      [
        cls(1, 'upd_main'),
        cls(2, 'upd_continuation'),
        cls(3, 'upd_continuation'),
        cls(4, 'upd_continuation'),
      ],
      4,
      3,
    );
    expect(plan.confident).toBe(false);
    expect(plan.reasons.join(' ')).toContain('больше предела 3');
  });

  it('неуверенный сегмент делает весь план ненадёжным', () => {
    // Страница «other» посреди пакета — segmentUpdPages пометит сегмент
    // uncertain, и публиковать такую нарезку нельзя.
    const plan = planUpdSegments([cls(1, 'upd_main'), cls(2, 'other')], 2, 5);
    expect(plan.confident).toBe(false);
  });

  it('пустая классификация — нет сегментов и нет уверенности', () => {
    const plan = planUpdSegments([], 0, 5);
    expect(plan.segments).toHaveLength(0);
    expect(plan.confident).toBe(false);
  });
});

describe('pageRefsOfSegment', () => {
  it('отдаёт адреса страниц в порядке сегмента', () => {
    const pages = [page(1, 0), page(2, 1), page(3, 2)];
    const plan = planUpdSegments(
      [cls(1, 'upd_main'), cls(2, 'upd_continuation'), cls(3, 'upd_main')],
      3,
      5,
    );
    const refs = pageRefsOfSegment(plan.segments[0]!, pages);
    expect(refs).toEqual([
      { registryItemId: 'item-0', inputOrder: 0, pageInFile: 1 },
      { registryItemId: 'item-1', inputOrder: 1, pageInFile: 1 },
    ]);
  });

  it('различает страницы одного файла по pageInFile', () => {
    const pages = [page(1, 0, 1), page(2, 0, 2)];
    const plan = planUpdSegments([cls(1, 'upd_main'), cls(2, 'upd_continuation')], 2, 5);
    const refs = pageRefsOfSegment(plan.segments[0]!, pages);
    expect(refs.map((r) => r.pageInFile)).toEqual([1, 2]);
    expect(new Set(refs.map((r) => r.registryItemId)).size).toBe(1);
  });
});
