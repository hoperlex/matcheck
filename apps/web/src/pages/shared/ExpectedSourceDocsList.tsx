import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Card, Space, Tag, Tooltip, Typography } from 'antd';
import { MinusSquareOutlined, PlusSquareOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  Counterparty,
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
import { dateSorter, numberSorter, prioritySorter, stringSorter } from '../../shared/ui/tableSorters';
import { dateRangeColumnFilter } from '../../shared/ui/DateRangeFilter';
import { formatDateRu, formatMoneyRu } from '../../shared/utils/formatRu';
import { shortenCounterpartyName } from '../../shared/utils/companyShortName';
import { parseCsvIds, toCsvIds } from '../../shared/utils/csvIds';
import { useSyncGlobalFilters } from '../../shared/hooks/useSyncGlobalFilters';
import { ExpandedSourceDocumentItems } from '../../shared/ui/ExpandedSourceDocumentItems';
import { usePrefetchSourceDocumentDetails } from '../../shared/hooks/usePrefetchSourceDocumentDetails';
import {
  buildInnMatchMap,
  expandDirectoryIdsToOperational,
} from '../../shared/utils/directoryFilterMap';

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

  const list = useQuery({
    queryKey: ['source-documents', 'unaccepted-upd', direction, filters.q],
    queryFn: () => {
      const qs = new URLSearchParams({
        kind: 'upd,transport_waybill,os2_transfer',
        direction,
        unaccepted: 'true',
        limit: '200',
      });
      if (filters.q.trim()) qs.set('q', filters.q.trim());
      return api.get<List>(`/source-documents?${qs.toString()}`);
    },
    placeholderData: keepPreviousData,
  });

  // Опции селектов фильтра «Подрядчик»/«Поставщик» берём из заказчиковских
  // справочников; маппинг в FK операций — через ИНН (см. directoryFilterMap).
  const counterpartiesQuery = useQuery({
    queryKey: ['counterparties', 'all'],
    queryFn: () =>
      api.get<{ items: Counterparty[]; total: number }>('/counterparties?limit=5000'),
  });
  const customerCounterpartiesQuery = useQuery({
    queryKey: ['customer-counterparties', 'all'],
    queryFn: () =>
      api.get<{ items: CustomerCounterparty[]; total: number }>(
        '/customer-counterparties?limit=5000',
      ),
  });
  const suppliersQuery = useQuery({
    queryKey: ['suppliers', 'all'],
    queryFn: () =>
      api.get<{ items: Supplier[]; total: number }>('/suppliers?limit=5000'),
  });
  const sitesQuery = useQuery({
    queryKey: ['sites', 'all'],
    queryFn: () =>
      api.get<{ items: Site[]; total: number }>('/sites?activeOnly=true&limit=200'),
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
  const contractorInnMap = useMemo(
    () =>
      buildInnMatchMap(
        customerCounterpartiesQuery.data?.items ?? [],
        counterpartiesQuery.data?.items ?? [],
      ),
    [customerCounterpartiesQuery.data, counterpartiesQuery.data],
  );
  const supplierInnMap = useMemo(
    () =>
      buildInnMatchMap(
        suppliersQuery.data?.items ?? [],
        counterpartiesQuery.data?.items ?? [],
      ),
    [suppliersQuery.data, counterpartiesQuery.data],
  );
  const contractorOperationalIds = useMemo(
    () => expandDirectoryIdsToOperational(filters.contractorIds, contractorInnMap),
    [filters.contractorIds, contractorInnMap],
  );
  const supplierOperationalIds = useMemo(
    () => expandDirectoryIdsToOperational(filters.supplierIds, supplierInnMap),
    [filters.supplierIds, supplierInnMap],
  );

  const allItems = list.data?.items ?? [];
  const filteredItems = useMemo(() => {
    return allItems.filter((r) => {
      if (filters.contractorIds.length > 0 && (!r.contractorId || !contractorOperationalIds.has(r.contractorId))) return false;
      if (filters.supplierIds.length > 0 && (!r.supplierId || !supplierOperationalIds.has(r.supplierId))) return false;
      if (filters.siteIds.length > 0 && (!r.siteId || !filters.siteIds.includes(r.siteId))) return false;
      return true;
    });
  }, [
    allItems,
    filters.contractorIds,
    filters.supplierIds,
    filters.siteIds,
    contractorOperationalIds,
    supplierOperationalIds,
  ]);

  // Префетч позиций — фоном после рендера. Раскрытие «+» читает кэш
  // react-query, без обращения к сети (см. usePrefetchSourceDocumentDetails).
  usePrefetchSourceDocumentDetails(useMemo(() => filteredItems.map((r) => r.id), [filteredItems]));

  // Раскрытие строк с позициями документа.
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const toggleExpand = (id: string) =>
    setExpandedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  return (
    <StickyPageHeader
      header={
        <>
          <ListFilters
            value={filters}
            onChange={updateFilters}
            fields={['contractor', 'supplier', 'site', 'q']}
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
        numbered
        expandable={{
          showExpandColumn: false,
          expandedRowKeys: expandedIds,
          expandedRowRender: (r) => (
            <ExpandedSourceDocumentItems id={r.id} kind={r.kind} />
          ),
        }}
        onRowClick={(r) => onOpen(r)}
        emptyText="Нет ожидаемых УПД и накладных"
        columns={[
          {
            title: 'Тип',
            key: 'kind',
            width: 150,
            sorter: prioritySorter<SourceDocument, SourceDocument['kind']>(
              (r) => r.kind,
              ['upd', 'request', 'transport_waybill', 'os2_transfer'],
            ),
            // Фильтр — чтобы можно было быстро посчитать «сколько УПД,
            // сколько Накладных, сколько Заявок» прямо в UI без БД.
            filters: [
              { text: 'УПД', value: 'upd' },
              { text: 'Накладная', value: 'waybill' },
              { text: 'Заявка', value: 'request' },
            ],
            onFilter: (value, r) => {
              if (value === 'waybill') {
                return r.kind === 'transport_waybill' || r.kind === 'os2_transfer';
              }
              return r.kind === value;
            },
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
            sorter: stringSorter<SourceDocument>((r) => r.docNumber),
            render: (v: string | null) => v ?? '— без номера —',
          },
          {
            title: 'Дата',
            dataIndex: 'docDate',
            // defaultSortOrder убран по UX-запросу: иначе при каждой
            // перемонтировке (refresh / переход) сортировка возвращалась
            // принудительно. Сервер уже отдаёт документы по parsed_at desc.
            sorter: dateSorter<SourceDocument>((r) => r.docDate),
            ...dateRangeColumnFilter<SourceDocument>((r) => r.docDate),
            render: (v: string | null) => formatDateRu(v),
          },
          {
            title: 'Дата поставки',
            dataIndex: 'expectedDate',
            sorter: dateSorter<SourceDocument>((r) => r.expectedDate),
            ...dateRangeColumnFilter<SourceDocument>((r) => r.expectedDate),
            render: (v: string | null) => formatDateRu(v),
          },
          {
            title: 'Поставщик',
            key: 'supplier',
            sorter: stringSorter<SourceDocument>((r) => r.supplierName),
            render: (_: unknown, r: SourceDocument) => shortenCounterpartyName(r.supplierName),
          },
          {
            title: 'Подрядчик',
            key: 'contractor',
            sorter: stringSorter<SourceDocument>((r) => r.contractorName),
            render: (_: unknown, r: SourceDocument) => r.contractorName ?? '—',
          },
          {
            title: 'Объект',
            key: 'site',
            // Truncate длинных имён («АЛ13 · ЖК АЛИЯ, БЛОКИ 13А, 13В») в
            // одну строку: высота строки таблицы не растёт, полный текст
            // виден в Tooltip при наведении. Единое поведение во всех 4
            // таблицах раздела «Операции».
            ellipsis: { showTitle: false },
            sorter: stringSorter<SourceDocument>((r) => r.siteName),
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
            sorter: numberSorter<SourceDocument>((r) => r.vatSum),
            render: (_: unknown, r: SourceDocument) => formatMoneyRu(r.vatSum),
          },
          {
            title: 'Сумма',
            key: 'total',
            sorter: numberSorter<SourceDocument>((r) => r.totalSum),
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
                {r.supplierName ?? '—'}
                {r.totalSum ? ` · ${r.totalSum} ₽` : ''}
                {r.vatSum ? ` (НДС ${r.vatSum} ₽)` : ''}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {r.contractorName ?? '—'} · {r.siteName ?? '—'}
              </Typography.Text>
            </Space>
          </Card>
        )}
      />
    </StickyPageHeader>
  );
}
