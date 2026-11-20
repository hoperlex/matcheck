/**
 * Параметры серверной выборки операций — один код для таблицы и для выгрузки.
 *
 * Раньше «Экспорт Excel» собирал свой укороченный набор (подрядчик, поставщик,
 * объект, поиск) и не знал ни про период, ни про id, ни про признаки. Из-за
 * этого выгрузка «принятых за июль» отдавала все приёмки от начала времён —
 * пользователь получал файл с 14.07 по 20.08 вместо запрошенного месяца.
 * Держать вторую копию правил нельзя: следующий фильтр снова забудут добавить.
 */
import dayjs from 'dayjs';
import { parseDeliveryPurposeFilter } from '@matcheck/contracts';

export type OperationsFilters = {
  contractorIds: string[];
  supplierIds: string[];
  siteIds: string[];
  q: string;
  /** Короткий человекочитаемый id операции (в URL — ?id=). */
  displayId: string;
  plate: string;
  features: string[];
  /**
   * У отгрузок — «Тип отгрузки» из мобильной формы, у приёмок — «Признак
   * приёмки» (коды DeliveryPurpose и none). В адресе у обоих ?purpose=, но у
   * каждой вкладки своё значение (OPERATIONS_TAB_KEYS в listMemory).
   */
  purposes?: string[];
  nophoto: boolean;
  // Порог «давно без фото» (часы) — приходит из плашки «Требует внимания»,
  // чтобы список показывал ровно то, что она посчитала.
  nophotoOlderHours: string | null;
  status: string | null;
  reviewState: string | null;
  /** Только у приёмок: отметка «Диспетчер» — checked | none (в URL — ?dispatcher=). */
  dispatcherCheck?: string | null;
  /**
   * Вид операции (в URL — ?entry=): manual — ручной внос/вынос, vehicle — с
   * машиной, null — все. Только эти два значения: чужое из ссылки не уходит на
   * сервер (там enum, ответ был бы 400 вместо таблицы).
   */
  entry?: 'manual' | 'vehicle' | null;
  /** Дни YYYY-MM-DD; пустая строка — граница не задана. */
  dateFrom: string;
  dateTo: string;
};

/** Читает фильтры из URL страницы. Ключи — те же, что пишет updateFilters. */
export function readOperationsFilters(params: URLSearchParams): OperationsFilters {
  return {
    contractorIds: parseCsv(params.get('contractor')),
    supplierIds: parseCsv(params.get('supplier')),
    siteIds: parseCsv(params.get('site')),
    q: params.get('q') ?? '',
    status: params.get('status'),
    displayId: params.get('id') ?? '',
    plate: params.get('plate') ?? '',
    features: params.getAll('feature'),
    purposes: params.getAll('purpose'),
    nophoto: params.get('nophoto') === '1',
    nophotoOlderHours: params.get('nophotoHours'),
    reviewState: params.get('review'),
    dispatcherCheck: params.get('dispatcher'),
    entry: parseEntry(params.get('entry')),
    dateFrom: params.get('dfrom') ?? '',
    dateTo: params.get('dto') ?? '',
  };
}

/**
 * Все ключи адреса, которые читает readOperationsFilters. «Сбросить» снимает
 * ровно их (и страницу); вкладка, тип и «Удалённые» — не фильтры, остаются.
 * Новый фильтр в readOperationsFilters обязан попасть и сюда — это проверяет
 * operationsQuery.test.ts.
 */
export const OPERATIONS_FILTER_KEYS = [
  'contractor',
  'supplier',
  'site',
  'q',
  'status',
  'id',
  'plate',
  'feature',
  'purpose',
  'nophoto',
  'nophotoHours',
  'review',
  'dispatcher',
  'entry',
  'dfrom',
  'dto',
] as const;

export function hasOperationsFilters(params: URLSearchParams): boolean {
  return OPERATIONS_FILTER_KEYS.some((key) => params.has(key));
}

/** Адрес без фильтров «Принятых» и без страницы — для кнопки «Сбросить». */
export function withoutOperationsFilters(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of OPERATIONS_FILTER_KEYS) next.delete(key);
  next.delete('page');
  return next;
}

/** Значение фильтра «Вид» из URL; всё, кроме двух известных, — «все». */
export function parseEntry(raw: string | null): 'manual' | 'vehicle' | null {
  return raw === 'manual' || raw === 'vehicle' ? raw : null;
}

function parseCsv(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Собирает query-строку для `/deliveries`, `/shipments` и их `export.xlsx`.
 *
 * Пагинацию вызывающий добавляет сам: у выгрузки её нет.
 */
export function operationsListQuery(
  filters: OperationsFilters,
  opts: { kind: 'delivery' | 'shipment'; trash?: boolean },
): URLSearchParams {
  const qs = new URLSearchParams();
  if (opts.trash) qs.set('trash', '1');
  if (filters.contractorIds.length) qs.set('contractorIds', filters.contractorIds.join(','));
  if (filters.supplierIds.length) qs.set('supplierIds', filters.supplierIds.join(','));
  if (filters.siteIds.length) qs.set('siteIds', filters.siteIds.join(','));
  if (filters.q.trim()) qs.set('q', filters.q.trim());
  if (filters.displayId.trim()) qs.set('displayId', filters.displayId.trim());
  if (filters.plate.trim()) qs.set('plate', filters.plate.trim());
  // У приёмки — только известные коды: экспорт читает адрес сам
  // (readOperationsFilters), и чужое значение из старой ссылки не должно
  // уходить на сервер иначе, чем у таблицы.
  const purposes =
    opts.kind === 'delivery'
      ? parseDeliveryPurposeFilter(filters.purposes ?? [])
      : (filters.purposes ?? []);
  if (purposes.length) qs.set('purposes', purposes.join(','));
  if (filters.features.length) qs.set('features', filters.features.join(','));
  if (filters.nophoto) {
    qs.set('nophoto', '1');
    if (filters.nophotoOlderHours) qs.set('nophotoOlderHours', filters.nophotoOlderHours);
  }
  // status=no_document — псевдо-значение селекта, на сервере это отдельный
  // параметр. Без маппинга оно не прошло бы валидацию статуса.
  if (filters.status === 'no_document') qs.set('noDocument', 'true');
  else if (filters.status) qs.set('status', filters.status);
  if (filters.reviewState) qs.set('reviewState', filters.reviewState);
  if (opts.kind === 'delivery' && filters.dispatcherCheck) {
    qs.set('dispatcherCheck', filters.dispatcherCheck);
  }
  if (filters.entry) qs.set('entry', filters.entry);
  // Дни → ISO-границы. Сервер сравнивает поле >= from AND поле < to, поэтому
  // верхняя граница — начало СЛЕДУЮЩЕГО дня: иначе записи выбранного
  // конечного дня выпали бы из выдачи.
  const fromField = opts.kind === 'delivery' ? 'arrivedFrom' : 'shippedFrom';
  const toField = opts.kind === 'delivery' ? 'arrivedTo' : 'shippedTo';
  if (filters.dateFrom) qs.set(fromField, dayjs(filters.dateFrom).startOf('day').toISOString());
  if (filters.dateTo) {
    qs.set(toField, dayjs(filters.dateTo).add(1, 'day').startOf('day').toISOString());
  }
  return qs;
}
