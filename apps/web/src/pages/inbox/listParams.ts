/**
 * Параметры запроса списка «Документы» — ОДИН сборщик на всех потребителей.
 *
 * Их трое: сам список, счётчик «Требуют внимания» и выгрузка Excel. Пока
 * каждый собирал query-строку сам, они разошлись молча и по-разному: выгрузка
 * слала полный набор, а список — половину, без дат, сортировки, страницы и
 * `mismatch`. Снаружи это выглядело как «фильтр по дате поставки не работает»:
 * адрес менялся, воронка загоралась, выдача оставалась прежней.
 *
 * Поэтому набор условий здесь один, а различия между потребителями выражены
 * режимом — внести расхождение снова можно только осознанно.
 */

/** Что именно спрашиваем. Отличия — только в пагинации и `needsAttention`. */
export type DocumentListParamsMode = 'list' | 'attention' | 'export';

export type DocumentListParamsInput = {
  direction: 'inbound' | 'outbound';
  /** 'all' в запрос не уходит: сервер без параметра отдаёт все типы. */
  kind: string;
  q: string;
  contractorIds: readonly string[];
  supplierIds: readonly string[];
  siteIds: readonly string[];
  needsAttention: boolean;
  mismatch: boolean;
  docDateFrom: string | null;
  docDateTo: string | null;
  expectedDateFrom: string | null;
  expectedDateTo: string | null;
  sort: string | null;
  order: 'asc' | 'desc';
  /** Страница с единицы — как в адресе и в antd. */
  page: number;
  pageSize: number;
};

export function buildDocumentListParams(
  input: DocumentListParamsInput,
  mode: DocumentListParamsMode,
): URLSearchParams {
  const qs = new URLSearchParams({ direction: input.direction });

  if (input.kind !== 'all') qs.set('kind', input.kind);
  const q = input.q.trim();
  if (q) qs.set('q', q);
  if (input.contractorIds.length > 0) qs.set('contractorIds', input.contractorIds.join(','));
  if (input.supplierIds.length > 0) qs.set('supplierIds', input.supplierIds.join(','));
  if (input.siteIds.length > 0) qs.set('siteIds', input.siteIds.join(','));
  if (input.mismatch) qs.set('mismatch', 'true');
  if (input.docDateFrom) qs.set('docDateFrom', input.docDateFrom);
  if (input.docDateTo) qs.set('docDateTo', input.docDateTo);
  if (input.expectedDateFrom) qs.set('expectedDateFrom', input.expectedDateFrom);
  if (input.expectedDateTo) qs.set('expectedDateTo', input.expectedDateTo);

  // Счётчик очереди ручной проверки всегда считает ИМЕННО её, независимо от
  // того, нажата кнопка или нет: иначе после нажатия число схлопнулось бы до
  // размера страницы и перестало что-либо значить.
  if (mode === 'attention') {
    qs.set('needsAttention', 'true');
  } else if (input.needsAttention) {
    qs.set('needsAttention', 'true');
  }

  // Порядок нужен и списку, и выгрузке: файл обязан повторять экран. Счётчику
  // он не нужен — оттуда берут только `total`.
  if (mode !== 'attention' && input.sort) {
    qs.set('sort', input.sort);
    qs.set('order', input.order);
  }

  if (mode === 'list') {
    qs.set('limit', String(input.pageSize));
    qs.set('offset', String((input.page - 1) * input.pageSize));
  }
  // Счётчику довольно одной строки: значение берётся из `total`.
  if (mode === 'attention') qs.set('limit', '1');
  // Выгрузка — весь набор, а не страница: ни `limit`, ни `offset` серверная
  // схема экспорта не принимает, и окно страницы там означало бы обрезанный файл.

  return qs;
}
