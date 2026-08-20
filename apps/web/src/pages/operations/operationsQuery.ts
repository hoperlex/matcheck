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

export type OperationsFilters = {
  contractorIds: string[];
  supplierIds: string[];
  siteIds: string[];
  q: string;
  /** Короткий человекочитаемый id операции (в URL — ?id=). */
  displayId: string;
  plate: string;
  features: string[];
  /** Только у отгрузок: «Тип отгрузки» из мобильной формы. */
  purposes?: string[];
  nophoto: boolean;
  status: string | null;
  reviewState: string | null;
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
    reviewState: params.get('review'),
    dateFrom: params.get('dfrom') ?? '',
    dateTo: params.get('dto') ?? '',
  };
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
  if (filters.purposes?.length) qs.set('purposes', filters.purposes.join(','));
  if (filters.features.length) qs.set('features', filters.features.join(','));
  if (filters.nophoto) qs.set('nophoto', '1');
  // status=no_document — псевдо-значение селекта, на сервере это отдельный
  // параметр. Без маппинга оно не прошло бы валидацию статуса.
  if (filters.status === 'no_document') qs.set('noDocument', 'true');
  else if (filters.status) qs.set('status', filters.status);
  if (filters.reviewState) qs.set('reviewState', filters.reviewState);
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
