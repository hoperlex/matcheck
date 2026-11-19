/**
 * Фильтры «Истории поступлений» в адресе страницы.
 *
 * Раньше они жили в useState: открыл приёмку из строки, закрыл — История
 * открывалась с нуля, а «Назад» браузера фильтров тоже не возвращал. Теперь
 * адрес — единственный источник, а память списков (shared/listMemory) отдаёт
 * его при возврате.
 */
import { parseCsvIds, toCsvIds } from '../../shared/utils/csvIds';
import type { SearchParamsPatch } from '../../shared/utils/searchParams';

export type MovementType = 'intake' | 'shipment';

/** По умолчанию открыт только «Поступление» — раздел так и называется. */
export const DEFAULT_MOVEMENT_TYPES: MovementType[] = ['intake'];

/** Значение `type`, когда в воронке не выбрано ничего (= показать всё). */
const NO_TYPES = 'all';

export type DayRange = { from: string | null; to: string | null };

export type MaterialsFilters<S extends string = string> = {
  siteIds: string[];
  contractorIds: string[];
  q: string;
  types: MovementType[];
  dateRange: DayRange;
  docDateRange: DayRange;
  sort: S | null;
  order: 'asc' | 'desc';
  page: number;
};

/** Ключи, которые снимает «Сбросить». Сортировка остаётся: это не фильтр. */
export const MATERIALS_FILTER_KEYS = [
  'site',
  'contractor',
  'q',
  'type',
  'dfrom',
  'dto',
  'docFrom',
  'docTo',
] as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// День из адреса уходит на сервер как `${day}T00:00:00.000Z`: мусор из
// подправленной руками ссылки дал бы 400 вместо таблицы.
function day(raw: string | null): string | null {
  return raw && DAY.test(raw) ? raw : null;
}

function isMovementType(v: string): v is MovementType {
  return v === 'intake' || v === 'shipment';
}

function parseTypes(raw: string | null): MovementType[] {
  if (raw === NO_TYPES) return [];
  const parsed = parseCsvIds(raw).filter(isMovementType);
  const unique = parsed.filter((v, i) => parsed.indexOf(v) === i);
  return unique.length ? unique : DEFAULT_MOVEMENT_TYPES;
}

/** Значение `type` для адреса; null — значение по умолчанию (параметр снимается). */
export function typesParam(types: MovementType[]): string | null {
  if (types.length === 0) return NO_TYPES;
  if (types.length === 1 && types[0] === 'intake') return null;
  return types.join(',');
}

export function readMaterialsFilters<S extends string>(
  params: URLSearchParams,
  asSort: (key: unknown) => S | null,
): MaterialsFilters<S> {
  const page = Number.parseInt(params.get('page') ?? '', 10);
  const sort = asSort(params.get('sort'));
  return {
    siteIds: parseCsvIds(params.get('site')),
    contractorIds: parseCsvIds(params.get('contractor')),
    q: params.get('q') ?? '',
    types: parseTypes(params.get('type')),
    dateRange: { from: day(params.get('dfrom')), to: day(params.get('dto')) },
    docDateRange: { from: day(params.get('docFrom')), to: day(params.get('docTo')) },
    sort,
    order: sort && params.get('order') === 'asc' ? 'asc' : 'desc',
    page: Number.isFinite(page) && page > 1 ? page : 1,
  };
}

/** Патч адреса для панели фильтров: любая смена — с первой страницы. */
export function panelPatch(patch: {
  siteIds?: string[];
  contractorIds?: string[];
  q?: string;
}): SearchParamsPatch {
  return {
    site: 'siteIds' in patch ? toCsvIds(patch.siteIds) : undefined,
    contractor: 'contractorIds' in patch ? toCsvIds(patch.contractorIds) : undefined,
    q: 'q' in patch ? patch.q : undefined,
    page: null,
  };
}

export function resetPatch(): SearchParamsPatch {
  const patch: SearchParamsPatch = { page: null };
  for (const key of MATERIALS_FILTER_KEYS) patch[key] = null;
  return patch;
}

export function hasMaterialsFilters(params: URLSearchParams): boolean {
  return MATERIALS_FILTER_KEYS.some((key) => params.has(key));
}
