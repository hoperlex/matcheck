import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Card, Space, Tag, Tooltip, Typography, type TableProps } from 'antd';
import { MinusSquareOutlined, PlusSquareOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  CustomerCounterparty,
  Site,
  SourceDirection,
  SourceDocument,
  SourceDocumentListResponseSchema,
  Supplier,
  UpdCheck,
  UpdValidation,
} from '@matcheck/contracts';
import type { z } from 'zod';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { ListFilters, type ListFiltersValue } from '../../shared/ui/ListFilters';
import { PageTabs, type PageTabItem } from '../../shared/ui/PageTabs';
import { parseDateRangeKey, serverDateRangeColumnFilter } from '../../shared/ui/DateRangeFilter';
import { formatDateRu, formatMoneyRu } from '../../shared/utils/formatRu';
import { shortenCounterpartyName } from '../../shared/utils/companyShortName';
import { documentPartyColumns } from '../../shared/ui/documentPartyColumns';
import { parseCsvIds, toCsvIds } from '../../shared/utils/csvIds';
import { useSyncGlobalFilters } from '../../shared/hooks/useSyncGlobalFilters';
import { ExpandedSourceDocumentItems } from '../../shared/ui/ExpandedSourceDocumentItems';
import { usePrefetchSourceDocumentDetails } from '../../shared/hooks/usePrefetchSourceDocumentDetails';
import { useAuthStore } from '../../stores/auth';

type List = z.infer<typeof SourceDocumentListResponseSchema>;

function checkLabel(c: UpdCheck): string {
  const row = typeof c.scope === 'object' && c.scope ? c.scope.row : null;
  switch (c.name) {
    case 'sum_total':
      return 'Σ сумм по строкам vs итог';
    case 'vat_total':
      return 'Σ НДС по строкам vs итог';
    case 'items_count':
      return 'Кол-во позиций';
    case 'items_sequence':
      return 'Нумерация позиций';
    case 'row_qty_price':
      return `Строка ${row ?? '?'}: qty×price`;
    case 'row_vat_rate':
      return `Строка ${row ?? '?'}: НДС%`;
  }
}

function MismatchTag({ v }: { v: UpdValidation }) {
  const fails = v.checks.filter((c) => !c.ok);
  if (fails.length === 0) return null;
  const tooltip = (
    <Space direction="vertical" size={2}>
      {fails.slice(0, 5).map((c, idx) => (
        <Typography.Text key={idx} style={{ color: 'inherit' }}>
          {checkLabel(c)}: {c.expected ?? '—'} vs {c.actual ?? '—'} (Δ {c.diff ?? '—'})
        </Typography.Text>
      ))}
      {fails.length > 5 ? <Typography.Text>… и ещё {fails.length - 5}</Typography.Text> : null}
    </Space>
  );
  return (
    <Tooltip title={tooltip}>
      <Tag color="warning" style={{ marginLeft: 6 }}>
        ⚠ расхождение
      </Tag>
    </Tooltip>
  );
}

/**
 * Список ожидаемых УПД (kind=upd, unaccepted=true). Используется и в КПП
 * (direction=inbound — приёмки), и в Отгрузке (direction=outbound).
 *
 * Сервер возвращает supplierName/contractorName/siteName через JOIN
 * (см. apps/api/src/routes/source-documents.ts), поэтому имена в столбцах
 * не требуют дополнительного резолва. Параметр q идёт и в URL, и в серверный
 * запрос — сохраняет существующую серверную семантику поиска по docNumber.
 */
// Поля серверной сортировки — те же, что понимает GET /source-documents.
const SORT_FIELDS = [
  'kind',
  'docNumber',
  'docDate',
  'expectedDate',
  'siteName',
  'buyerName',
  'consigneeName',
  'supplierName',
  'vatSum',
  'totalSum',
] as const;
type SortField = (typeof SORT_FIELDS)[number];

const COLUMN_TO_SORT_FIELD: Record<string, SortField> = {
  kind: 'kind',
  docNumber: 'docNumber',
  docDate: 'docDate',
  expectedDate: 'expectedDate',
  siteName: 'siteName',
  buyer: 'buyerName',
  consignee: 'consigneeName',
  supplier: 'supplierName',
  vatSum: 'vatSum',
  totalSum: 'totalSum',
};

// Колоночный фильтр «Тип»: «Накладная» на экране — это ТН и ОС-2 разом.
const KIND_FILTER_TO_PARAM: Record<string, string> = {
  upd: 'upd',
  waybill: 'transport_waybill,os2_transfer',
  request: 'request',
};

export function ExpectedSourceDocsList({
  direction,
  onOpen,
  tabs,
  activeTab,
  onTabChange,
  filtersExtra,
}: {
  direction: SourceDirection;
  onOpen: (upd: SourceDocument) => void;
  // Вкладки страницы-родителя (например «Ожидаемые / Принятые») рендерятся
  // ВНУТРИ нашего sticky-header'а под ListFilters — этого требует UX
  // эталона. Если не передать, вкладочный блок не рисуется (компонент
  // совместим с использованием вне страницы с вкладками).
  tabs?: PageTabItem[];
  activeTab?: string;
  onTabChange?: (key: string) => void;
  // Слот в правый край ListFilters — туда родитель вставляет кнопку
  // «Новая приёмка» / «Новая отгрузка».
  filtersExtra?: ReactNode;
}) {
  const [params, setParams] = useSearchParams();
  // Подрядчику справочники закрыты — панель фильтров для него сводится к поиску
  // (как в «Документах»), иначе три запроса уходят в 403.
  const isContractor = useAuthStore((s) => s.user?.role) === 'contractor';

  // Страница, сортировка, диапазоны дат и тип документа — в адресе, применяет
  // их сервер. Клиентских сортировок и фильтров здесь больше нет: на экране
  // одна страница, и сравнение по ней давало бы неверный ответ.
  const PAGE_SIZE = 50;
  const pageRaw = Number.parseInt(params.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const sortField = SORT_FIELDS.includes((params.get('sort') ?? '') as SortField)
    ? (params.get('sort') as SortField)
    : null;
  const sortOrder: 'asc' | 'desc' = params.get('order') === 'asc' ? 'asc' : 'desc';
  const docDateFrom = params.get('docFrom');
  const docDateTo = params.get('docTo');
  const expectedFrom = params.get('expFrom');
  const expectedTo = params.get('expTo');
  // Тип документа: в адресе — те же значения, что понимает сервер. «Накладная»
  // на экране — это две сущности сразу (ТН и ОС-2), поэтому колоночный фильтр
  // разворачивается в пару.
  const kindFilter = params.get('kind') ?? '';
  const kindParam = kindFilter || 'upd,transport_waybill,os2_transfer';

  const filters: ListFiltersValue = {
    contractorIds: parseCsvIds(params.get('contractor')),
    supplierIds: parseCsvIds(params.get('supplier')),
    siteIds: parseCsvIds(params.get('site')),
    q: params.get('q') ?? '',
  };

  const updateFilters = (patch: Partial<ListFiltersValue>) => {
    const next = new URLSearchParams(params);
    const apply = (key: string, val: string | null | undefined) => {
      if (val) next.set(key, val);
      else next.delete(key);
    };
    if ('contractorIds' in patch) apply('contractor', toCsvIds(patch.contractorIds));
    if ('supplierIds' in patch) apply('supplier', toCsvIds(patch.supplierIds));
    if ('siteIds' in patch) apply('site', toCsvIds(patch.siteIds));
    if ('q' in patch) apply('q', patch.q);
    // Новый фильтр — новая выдача: со старой страницы можно попасть в пустоту.
    next.delete('page');
    setParams(next, { replace: true });
  };

  // «Липкие» фильтры между разделами — см. useSyncGlobalFilters.
  useSyncGlobalFilters({
    current: {
      contractorIds: filters.contractorIds,
      supplierIds: filters.supplierIds,
      siteIds: filters.siteIds,
    },
    apply: (next) =>
      updateFilters({
        contractorIds: next.contractorIds,
        supplierIds: next.supplierIds,
        siteIds: next.siteIds,
      }),
  });

  // Фильтры — на сервере. Клиентские отсеивали строки уже ПОСЛЕ лимита в 200,
  // а непринятых документов на порядок больше: документ подрядчика, лежащий
  // трёхсотым по свежести, не находился никаким выбором в селекте. Плюс сравнение
  // шло с operational supplier_id, который у современных УПД пуст, — фильтр
  // «Поставщик» не возвращал вообще ничего.
  const listQuery = {
    contractor: toCsvIds(filters.contractorIds),
    supplier: toCsvIds(filters.supplierIds),
    site: toCsvIds(filters.siteIds),
    q: filters.q.trim(),
    kind: kindParam,
    docDateFrom,
    docDateTo,
    expectedFrom,
    expectedTo,
    sort: sortField,
    order: sortOrder,
    page,
  };
  const list = useQuery({
    queryKey: ['source-documents', 'unaccepted-upd', direction, listQuery],
    queryFn: () => {
      const qs = new URLSearchParams({
        kind: kindParam,
        direction,
        unaccepted: 'true',
        limit: String(PAGE_SIZE),
        offset: String((page - 1) * PAGE_SIZE),
      });
      if (listQuery.q) qs.set('q', listQuery.q);
      if (listQuery.contractor) qs.set('contractorIds', listQuery.contractor);
      if (listQuery.supplier) qs.set('supplierIds', listQuery.supplier);
      if (listQuery.site) qs.set('siteIds', listQuery.site);
      if (docDateFrom) qs.set('docDateFrom', docDateFrom);
      if (docDateTo) qs.set('docDateTo', docDateTo);
      if (expectedFrom) qs.set('expectedDateFrom', expectedFrom);
      if (expectedTo) qs.set('expectedDateTo', expectedTo);
      if (sortField) {
        qs.set('sort', sortField);
        qs.set('order', sortOrder);
      }
      return api.get<List>(`/source-documents?${qs.toString()}`);
    },
    placeholderData: keepPreviousData,
  });

  // Опции селектов «Подрядчик»/«Поставщик» — заказчиковские справочники (то же,
  // что во вкладках «Справочники»). Разворот id справочника в FK операций делает
  // сервер по ИНН — на клиенте ИНН-карты больше нет: она отсеивала строки уже
  // после серверного лимита и не знала про supplier_directory_id.
  //
  // Подрядчику справочники закрыты (403 на всех четырёх маршрутах), поэтому для
  // него запросы не уходят вовсе, а в панели остаётся только поиск.
  const customerCounterpartiesQuery = useQuery({
    queryKey: ['customer-counterparties', 'all'],
    queryFn: () =>
      api.get<{ items: CustomerCounterparty[]; total: number }>(
        '/customer-counterparties?limit=5000',
      ),
    enabled: !isContractor,
  });
  const suppliersQuery = useQuery({
    queryKey: ['suppliers', 'all'],
    queryFn: () => api.get<{ items: Supplier[]; total: number }>('/suppliers?limit=5000'),
    enabled: !isContractor,
  });
  const sitesQuery = useQuery({
    queryKey: ['sites', { activeOnly: true, limit: 200 }],
    queryFn: () => api.get<{ items: Site[]; total: number }>('/sites?activeOnly=true&limit=200'),
    enabled: !isContractor,
  });

  const contractorOptions = useMemo(
    () =>
      (customerCounterpartiesQuery.data?.items ?? []).map((c) => ({
        value: c.id,
        label: c.name,
      })),
    [customerCounterpartiesQuery.data],
  );
  const supplierOptions = useMemo(
    () =>
      (suppliersQuery.data?.items ?? []).map((s) => ({
        value: s.id,
        label: s.name,
      })),
    [suppliersQuery.data],
  );

  const filteredItems = list.data?.items ?? [];

  // Префетч позиций — фоном после рендера. Раскрытие «+» читает кэш
  // react-query, без обращения к сети (см. usePrefetchSourceDocumentDetails).
  usePrefetchSourceDocumentDetails(useMemo(() => filteredItems.map((r) => r.id), [filteredItems]));

  // Сортировка серверная — колонке достаточно знать, активна ли она.
  const sortProps = (columnKey: string) => ({
    sorter: true as const,
    sortOrder:
      sortField && COLUMN_TO_SORT_FIELD[columnKey] === sortField
        ? ((sortOrder === 'asc' ? 'ascend' : 'descend') as 'ascend' | 'descend')
        : null,
  });

  // Страница, сортировка и колоночные фильтры — в адрес, оттуда в запрос.
  const handleTableChange: NonNullable<TableProps<SourceDocument>['onChange']> = (
    tablePagination,
    tableFilters,
    tableSorter,
  ) => {
    const single = Array.isArray(tableSorter) ? tableSorter[0] : tableSorter;
    const columnKey = single && single.order ? String(single.columnKey ?? '') : '';
    const field = COLUMN_TO_SORT_FIELD[columnKey];
    const doc = parseDateRangeKey(tableFilters['docDate']?.[0] as string | undefined);
    const exp = parseDateRangeKey(tableFilters['expectedDate']?.[0] as string | undefined);
    const kinds = (tableFilters['kind'] ?? [])
      .map((v) => KIND_FILTER_TO_PARAM[String(v)])
      .filter(Boolean)
      .join(',');
    const nextPage = tablePagination.current ?? 1;
    const changed =
      doc.from !== docDateFrom ||
      doc.to !== docDateTo ||
      exp.from !== expectedFrom ||
      exp.to !== expectedTo ||
      kinds !== kindFilter ||
      (field ?? null) !== sortField;
    const next = new URLSearchParams(params);
    const apply = (key: string, val: string | null): void => {
      if (val) next.set(key, val);
      else next.delete(key);
    };
    apply('sort', field ?? null);
    apply('order', field ? (single?.order === 'ascend' ? 'asc' : 'desc') : null);
    apply('docFrom', doc.from);
    apply('docTo', doc.to);
    apply('expFrom', exp.from);
    apply('expTo', exp.to);
    apply('kind', kinds || null);
    // Смена состава выдачи возвращает на первую страницу: иначе можно остаться
    // на седьмой странице результата, где страниц теперь две.
    apply('page', changed || nextPage <= 1 ? null : String(nextPage));
    setParams(next, { replace: true });
  };

  // Раскрытие строк с позициями документа.
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const toggleExpand = (id: string) =>
    setExpandedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <StickyPageHeader
      header={
        <>
          <ListFilters
            value={filters}
            onChange={updateFilters}
            fields={isContractor ? ['q'] : ['contractor', 'supplier', 'site', 'q']}
            contractorOptions={contractorOptions}
            supplierOptions={supplierOptions}
            sites={sitesQuery.data?.items ?? []}
            loading={
              customerCounterpartiesQuery.isLoading ||
              suppliersQuery.isLoading ||
              sitesQuery.isLoading
            }
            searchPlaceholder="Номер документа"
            extra={filtersExtra}
          />
          {tabs && activeTab && onTabChange && (
            <PageTabs items={tabs} activeKey={activeTab} onChange={onTabChange} />
          )}
        </>
      }
    >
      <ResponsiveTable<SourceDocument>
        items={filteredItems}
        loading={list.isLoading}
        rowKey="id"
        numberedOffset={(page - 1) * PAGE_SIZE}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: list.data?.total ?? 0,
          showSizeChanger: false,
          showTotal: (total) => `Всего: ${total}`,
        }}
        onChange={handleTableChange}
        numbered
        // Три стороны документа получили фиксированные 170px под ИНН второй
        // строкой, и без явной минимальной ширины на 1024-1366px ужимались бы
        // соседние колонки. 13 колонок: 3×170 фиксированных, остальным от ~110.
        scrollX={1500}
        expandable={{
          showExpandColumn: false,
          expandedRowKeys: expandedIds,
          expandedRowRender: (r) => <ExpandedSourceDocumentItems id={r.id} kind={r.kind} />,
        }}
        onRowClick={(r) => onOpen(r)}
        emptyText="Нет ожидаемых УПД и накладных"
        columns={[
          {
            title: 'Тип',
            key: 'kind',
            width: 150,
            ...sortProps('kind'),
            // Фильтр по типу применяет сервер: на экране одна страница, и
            // отсев по ней отвечал бы «сколько УПД на этой странице».
            filters: [
              { text: 'УПД', value: 'upd' },
              { text: 'Накладная', value: 'waybill' },
              { text: 'Заявка', value: 'request' },
            ],
            filteredValue: kindFilter
              ? Object.entries(KIND_FILTER_TO_PARAM)
                  .filter(([, param]) =>
                    param.split(',').some((k) => kindFilter.split(',').includes(k)),
                  )
                  .map(([key]) => key)
              : null,
            render: (_: unknown, r: SourceDocument) => {
              const expanded = expandedIds.includes(r.id);
              const tag =
                r.kind === 'transport_waybill' || r.kind === 'os2_transfer' ? (
                  <Tag color="purple">Накладная</Tag>
                ) : r.kind === 'upd' ? (
                  <Tag color="blue">УПД</Tag>
                ) : (
                  <Tag color="gold">Заявка</Tag>
                );
              return (
                <Space size={4}>
                  <Button
                    type="text"
                    size="small"
                    icon={expanded ? <MinusSquareOutlined /> : <PlusSquareOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleExpand(r.id);
                    }}
                  />
                  {tag}
                </Space>
              );
            },
          },
          {
            title: 'Номер',
            dataIndex: 'docNumber',
            ...sortProps('docNumber'),
            render: (v: string | null) => v ?? '— без номера —',
          },
          {
            title: 'Дата',
            dataIndex: 'docDate',
            // defaultSortOrder убран по UX-запросу: иначе при каждой
            // перемонтировке (refresh / переход) сортировка возвращалась
            // принудительно. Сервер уже отдаёт документы по parsed_at desc.
            ...sortProps('docDate'),
            ...serverDateRangeColumnFilter<SourceDocument>({ from: docDateFrom, to: docDateTo }),
            render: (v: string | null) => formatDateRu(v),
          },
          {
            title: 'Дата поставки',
            dataIndex: 'expectedDate',
            ...sortProps('expectedDate'),
            ...serverDateRangeColumnFilter<SourceDocument>({
              from: expectedFrom,
              to: expectedTo,
            }),
            render: (v: string | null) => formatDateRu(v),
          },
          // Тот же набор сторон, что в «Документах»: раньше здесь была пара
          // «Поставщик / Подрядчик», и один документ выглядел на двух экранах
          // по-разному. См. shared/ui/documentPartyColumns.
          ...documentPartyColumns<SourceDocument>((r) => r, { sortProps }),
          {
            title: 'Объект',
            key: 'site',
            // Truncate длинных имён («АЛ13 · ЖК АЛИЯ, БЛОКИ 13А, 13В») в
            // одну строку: высота строки таблицы не растёт, полный текст
            // виден в Tooltip при наведении. Единое поведение во всех 4
            // таблицах раздела «Операции».
            ellipsis: { showTitle: false },
            ...sortProps('siteName'),
            render: (_: unknown, r: SourceDocument) => {
              const name = r.siteName ?? '—';
              return (
                <Tooltip title={name} placement="topLeft">
                  <span>{name}</span>
                </Tooltip>
              );
            },
          },
          {
            title: 'Сумма НДС',
            key: 'vat',
            ...sortProps('vatSum'),
            render: (_: unknown, r: SourceDocument) => formatMoneyRu(r.vatSum),
          },
          {
            title: 'Сумма',
            key: 'total',
            ...sortProps('totalSum'),
            render: (_: unknown, r: SourceDocument) => (
              <span>
                {formatMoneyRu(r.totalSum)}
                {r.validation?.hasMismatch ? <MismatchTag v={r.validation} /> : null}
              </span>
            ),
          },
        ]}
        cardRender={(r) => (
          <Card style={{ width: '100%' }} size="small">
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Space>
                <Tag color="blue">{r.docNumber ?? '— без номера —'}</Tag>
                <Typography.Text strong>{r.docDate ?? '—'}</Typography.Text>
                {r.validation?.hasMismatch ? <MismatchTag v={r.validation} /> : null}
              </Space>
              <Typography.Text type="secondary">
                {shortenCounterpartyName(r.supplierName)}
                {r.totalSum ? ` · ${r.totalSum} ₽` : ''}
                {r.vatSum ? ` (НДС ${r.vatSum} ₽)` : ''}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {shortenCounterpartyName(r.buyerName)} · {shortenCounterpartyName(r.consigneeName)}{' '}
                · {r.siteName ?? '—'}
              </Typography.Text>
            </Space>
          </Card>
        )}
      />
    </StickyPageHeader>
  );
}
