/**
 * Сборщик параметров списка «Документы».
 *
 * Тест держит то, из-за чего фильтры и не работали: набор условий у списка,
 * счётчика и выгрузки обязан совпадать, а различаться им можно только
 * пагинацией и `needsAttention`.
 */
import { describe, expect, it } from 'vitest';
import { buildDocumentListParams, type DocumentListParamsInput } from './listParams';

const FULL: DocumentListParamsInput = {
  direction: 'inbound',
  kind: 'upd',
  q: '  1877  ',
  contractorIds: ['c1', 'c2'],
  supplierIds: ['s1'],
  siteIds: ['site1'],
  needsAttention: false,
  mismatch: true,
  docDateFrom: '2026-08-01',
  docDateTo: '2026-08-31',
  expectedDateFrom: '2026-08-27',
  expectedDateTo: '2026-08-27',
  sort: 'totalSum',
  order: 'asc',
  page: 3,
  pageSize: 50,
};

/**
 * Условия ВЫБОРКИ: без пагинации, очереди и порядка. Именно они обязаны
 * совпадать у списка, выгрузки и счётчика — состав строк от сортировки не
 * зависит, а счётчику порядок не нужен вовсе.
 */
const NOT_A_CONDITION = new Set(['limit', 'offset', 'needsAttention', 'sort', 'order']);

function conditions(qs: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of qs.entries()) {
    if (NOT_A_CONDITION.has(k)) continue;
    out[k] = v;
  }
  return out;
}

describe('buildDocumentListParams', () => {
  it('список несёт все фильтры, порядок и окно страницы', () => {
    const qs = buildDocumentListParams(FULL, 'list');
    expect(Object.fromEntries(qs.entries())).toEqual({
      direction: 'inbound',
      kind: 'upd',
      // Пробелы вокруг номера в запрос не уходят.
      q: '1877',
      contractorIds: 'c1,c2',
      supplierIds: 's1',
      siteIds: 'site1',
      mismatch: 'true',
      docDateFrom: '2026-08-01',
      docDateTo: '2026-08-31',
      expectedDateFrom: '2026-08-27',
      expectedDateTo: '2026-08-27',
      sort: 'totalSum',
      order: 'asc',
      limit: '50',
      // Третья страница при размере 50 — это смещение 100, а не номер страницы.
      offset: '100',
    });
  });

  it('выгрузка повторяет условия и порядок экрана, но берёт весь набор', () => {
    const qs = buildDocumentListParams(FULL, 'export');
    expect(conditions(qs)).toEqual(conditions(buildDocumentListParams(FULL, 'list')));
    expect(qs.get('sort')).toBe('totalSum');
    expect(qs.get('order')).toBe('asc');
    // Окно страницы в файле означало бы обрезанную выгрузку.
    expect(qs.get('limit')).toBeNull();
    expect(qs.get('offset')).toBeNull();
  });

  it('счётчик считает ту же выборку, но всегда очередь ручной проверки', () => {
    const qs = buildDocumentListParams(FULL, 'attention');
    expect(conditions(qs)).toEqual(conditions(buildDocumentListParams(FULL, 'list')));
    expect(qs.get('needsAttention')).toBe('true');
    expect(qs.get('limit')).toBe('1');
    expect(qs.get('offset')).toBeNull();
    // Порядок счётчику не нужен: из ответа берут только total.
    expect(qs.get('sort')).toBeNull();
  });

  it('нажатая кнопка «Требуют внимания» доходит до списка и выгрузки', () => {
    const on = { ...FULL, needsAttention: true };
    expect(buildDocumentListParams(on, 'list').get('needsAttention')).toBe('true');
    expect(buildDocumentListParams(on, 'export').get('needsAttention')).toBe('true');
    expect(buildDocumentListParams(FULL, 'list').get('needsAttention')).toBeNull();
  });

  it('пустые фильтры не превращаются в параметры', () => {
    const empty: DocumentListParamsInput = {
      ...FULL,
      kind: 'all',
      q: '   ',
      contractorIds: [],
      supplierIds: [],
      siteIds: [],
      mismatch: false,
      docDateFrom: null,
      docDateTo: null,
      expectedDateFrom: null,
      expectedDateTo: null,
      sort: null,
      page: 1,
    };
    expect(Object.fromEntries(buildDocumentListParams(empty, 'list').entries())).toEqual({
      direction: 'inbound',
      limit: '50',
      offset: '0',
    });
  });
});
