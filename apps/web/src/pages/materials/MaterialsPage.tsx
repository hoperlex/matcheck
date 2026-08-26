import { useEffect, useState } from 'react';
import { Button, Space, Tag, Tooltip, Typography, type TableProps } from 'antd';
import { PictureOutlined } from '@ant-design/icons';
import { DebouncedSearch } from '../../shared/ui/DebouncedSearch';
import { MaterialPhotosModal } from './MaterialPhotosModal';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type {
  CustomerCounterparty,
  MovementRow,
  MovementsResponse,
  Site,
} from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { FilterSelect } from '../../shared/ui/FilterSelect';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { parseDateRangeKey, serverDateRangeColumnFilter } from '../../shared/ui/DateRangeFilter';
import { formatMoneyRu } from '../../shared/utils/formatRu';
import { useSyncGlobalFiltersSiteContractor } from '../../shared/hooks/useSyncGlobalFilters';

// Поля серверной сортировки объединённого журнала (см. /reports/movements).
type MovementSort =
  | 'date'
  | 'siteName'
  | 'materialName'
  | 'qty'
  | 'docNumber'
  | 'docDate'
  | 'sum'
  | 'status';

const STATUS_COLOR: Record<string, string> = {
  filled: 'green',
  shipped: 'green',
  confirmed_mol: 'blue',
};

const statusTagColor = (code: string) => STATUS_COLOR[code] ?? 'default';

const formatDocDate = (v: string | null) =>
  v ? v.slice(0, 10).split('-').reverse().join('.') : '—';

const trimQty = (s: string | null) => {
  if (!s) return '—';
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

// Тип движения — общий «отметчик» строки журнала. Цвета совпадают с
// чипами в Документах: green = приёмка, purple = отгрузка.
type RowType = 'intake' | 'shipment';
const TYPE_LABELS: Record<RowType, { label: string; color: string }> = {
  intake: { label: 'Поступление', color: 'green' },
  shipment: { label: 'Отгрузка', color: 'purple' },
};

/**
 * Строка журнала приходит с сервера уже унифицированной (/reports/movements):
 * поступления и отгрузки — одна лента по дате. Раньше страница делала два
 * независимых запроса по 500 строк и склеивала их в браузере: при тысячах
 * записей в выборку попадали последние сутки, а фильтры по датам и сортировки
 * работали только по ним.
 */
type UnifiedRow = MovementRow;

export default function MaterialsPage() {
  const navigate = useNavigate();
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [contractorIds, setContractorIds] = useState<string[]>([]);
  const [q, setQ] = useState('');
  // Состояние модалки «Фото материала». Открывается из иконки 📷 в
  // колонке «Тип» — не путать с onRowClick (тот ведёт в edit-режим).
  const [photosFor, setPhotosFor] = useState<{
    kind: 'delivery' | 'shipment';
    id: string;
  } | null>(null);
  useSyncGlobalFiltersSiteContractor({ siteIds, setSiteIds, contractorIds, setContractorIds });

  // Ключи кэша включают параметры запроса: под общим ['sites','all'] лежали
  // ответы с разными limit/activeOnly, и какой из них выиграет, зависело от
  // порядка монтирования страниц.
  const sites = useQuery({
    queryKey: ['sites', { limit: 500 }],
    queryFn: () => api.get<{ items: Site[]; total: number }>('/sites?limit=500'),
  });
  // Подрядчики — из справочника заказчика, как в «Операциях» и «Отгрузке».
  // Раньше здесь был операционный /counterparties без фильтра is_contractor:
  // в списке подрядчиков висели поставщики и покупатели, а выбранный id не
  // совпадал с тем, что кладут в общий стор соседние разделы.
  const customerCounterparties = useQuery({
    queryKey: ['customer-counterparties', 'all'],
    queryFn: () =>
      api.get<{ items: CustomerCounterparty[]; total: number }>(
        '/customer-counterparties?limit=5000',
      ),
  });

  // Страница, сортировка и колоночные фильтры — состояние таблицы; всё это
  // применяет сервер, поэтому клиентских sorter'ов и onFilter здесь нет.
  const PAGE_SIZE = 100;
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<MovementSort | null>(null);
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  // По умолчанию открыт только «Поступление» — раздел так и называется.
  const [types, setTypes] = useState<Array<'intake' | 'shipment'>>(['intake']);
  const [dateRange, setDateRange] = useState<{ from: string | null; to: string | null }>({
    from: null,
    to: null,
  });
  const [docDateRange, setDocDateRange] = useState<{ from: string | null; to: string | null }>({
    from: null,
    to: null,
  });

  const movementsQuery = useQuery({
    queryKey: [
      'reports',
      'movements',
      { siteIds, contractorIds, q, types, dateRange, docDateRange, sort, order, page },
    ],
    queryFn: () => {
      const qs = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String((page - 1) * PAGE_SIZE),
      });
      if (siteIds.length) qs.set('siteId', siteIds.join(','));
      if (contractorIds.length) qs.set('contractorId', contractorIds.join(','));
      if (q) qs.set('q', q);
      // Один выбранный тип сужает выборку на сервере; оба (или ни одного) —
      // значит показываем всё.
      if (types.length === 1 && types[0]) qs.set('type', types[0]);
      if (dateRange.from) qs.set('dateFrom', `${dateRange.from}T00:00:00.000Z`);
      if (dateRange.to) qs.set('dateTo', `${dateRange.to}T23:59:59.999Z`);
      if (docDateRange.from) qs.set('docDateFrom', docDateRange.from);
      if (docDateRange.to) qs.set('docDateTo', docDateRange.to);
      if (sort) {
        qs.set('sort', sort);
        qs.set('order', order);
      }
      return api.get<MovementsResponse>(`/reports/movements?${qs.toString()}`);
    },
    placeholderData: keepPreviousData,
  });

  const rows = movementsQuery.data?.items ?? [];

  // Сортировка серверная — колонке достаточно знать, активна ли она сейчас.
  const sortProps = (columnKey: MovementSort) => ({
    sorter: true as const,
    sortOrder:
      sort === columnKey
        ? ((order === 'asc' ? 'ascend' : 'descend') as 'ascend' | 'descend')
        : null,
  });

  const handleTableChange: NonNullable<TableProps<UnifiedRow>['onChange']> = (
    tablePagination,
    tableFilters,
    tableSorter,
  ) => {
    const single = Array.isArray(tableSorter) ? tableSorter[0] : tableSorter;
    const nextSort = single?.order ? ((single.columnKey as MovementSort) ?? null) : null;
    const nextOrder: 'asc' | 'desc' = single?.order === 'ascend' ? 'asc' : 'desc';
    const nextTypes = ((tableFilters['type'] as Array<'intake' | 'shipment'> | null) ?? []).filter(
      Boolean,
    );
    const nextDate = parseDateRangeKey(tableFilters['date']?.[0] as string | undefined);
    const nextDocDate = parseDateRangeKey(tableFilters['docDate']?.[0] as string | undefined);
    const changed =
      nextSort !== sort ||
      nextOrder !== order ||
      nextTypes.join(',') !== types.join(',') ||
      nextDate.from !== dateRange.from ||
      nextDate.to !== dateRange.to ||
      nextDocDate.from !== docDateRange.from ||
      nextDocDate.to !== docDateRange.to;
    setSort(nextSort);
    setOrder(nextOrder);
    setTypes(nextTypes);
    setDateRange(nextDate);
    setDocDateRange(nextDocDate);
    // Смена состава выдачи возвращает на первую страницу.
    setPage(changed ? 1 : (tablePagination.current ?? 1));
  };

  // Смена фильтров панели — тоже с первой страницы.
  useEffect(() => {
    setPage(1);
  }, [siteIds, contractorIds, q]);

  return (
    <StickyPageHeader
      header={
        <Typography.Title level={3} style={{ margin: 0 }}>
          История поступлений
        </Typography.Title>
      }
    >
      <StickyPageHeader
        header={
          <Space wrap>
            {/* Панель фильтров — общий FilterSelect: фиксированная ширина и
                «+N» вместо responsive-режима, из-за которого поля прыгали при
                длинных названиях. */}
            <FilterSelect
              mode="multiple"
              width={240}
              placeholder="Все объекты"
              value={siteIds}
              onChange={setSiteIds}
              loading={sites.isLoading}
              options={(sites.data?.items ?? []).map((s) => ({
                value: s.id,
                label: `${s.code} · ${s.name}`,
              }))}
            />
            <FilterSelect
              mode="multiple"
              width={240}
              placeholder="Подрядчик"
              value={contractorIds}
              onChange={setContractorIds}
              loading={customerCounterparties.isLoading}
              options={(customerCounterparties.data?.items ?? []).map((c) => ({
                value: c.id,
                label: c.name,
              }))}
            />
            <DebouncedSearch
              placeholder="Материал или контрагент"
              value={q}
              onChange={setQ}
              style={{ width: 320 }}
            />
          </Space>
        }
      >
        <ResponsiveTable<UnifiedRow>
          items={rows}
          loading={movementsQuery.isLoading}
          numberedOffset={(page - 1) * PAGE_SIZE}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total: movementsQuery.data?.total ?? 0,
            showSizeChanger: false,
            showTotal: (total) => `Всего: ${total}`,
          }}
          onChange={handleTableChange}
          rowKey="rowKey"
          emptyText="Нет данных"
          numbered
          onRowClick={(r) => {
            // from=materials — флажок «после закрытия модалки вернуть
            // пользователя в Историю поступлений, а не оставить в Операциях».
            // Обрабатывается в OperationsPage.closeModal.
            if (r.type === 'intake' && r.deliveryId) {
              navigate(`/operations?type=delivery&delivery=${r.deliveryId}&from=materials`);
            } else if (r.type === 'shipment' && r.shipmentId) {
              navigate(`/operations?type=shipment&shipment=${r.shipmentId}&from=materials`);
            }
          }}
          columns={[
            {
              title: 'Тип',
              key: 'type',
              width: 130,
              // По умолчанию открыт только «Поступление» — раздел исторически
              // называется «История поступлений». Пользователь снимает галочку
              // или ставит «Отгрузка», чтобы посмотреть исходящее движение.
              filters: [
                { text: TYPE_LABELS.intake.label, value: 'intake' },
                { text: TYPE_LABELS.shipment.label, value: 'shipment' },
              ],
              filteredValue: types.length ? types : null,
              render: (_: unknown, r: UnifiedRow) => {
                // Иконка 📷 — открывает модалку с фото этой приёмки/отгрузки.
                // stopPropagation: иначе onRowClick параллельно открыл бы
                // edit-модалку в /operations.
                const targetId = r.type === 'intake' ? r.deliveryId : r.shipmentId;
                const targetKind = r.type === 'intake' ? 'delivery' : 'shipment';
                return (
                  <Space size={4}>
                    <Tag color={TYPE_LABELS[r.type].color} style={{ marginInlineEnd: 0 }}>
                      {TYPE_LABELS[r.type].label}
                    </Tag>
                    {targetId && (
                      <Tooltip title="Фото">
                        <Button
                          type="text"
                          size="small"
                          icon={<PictureOutlined />}
                          onClick={(e) => {
                            e.stopPropagation();
                            setPhotosFor({ kind: targetKind, id: targetId });
                          }}
                        />
                      </Tooltip>
                    )}
                  </Space>
                );
              },
            },
            {
              title: 'Дата',
              dataIndex: 'date',
              width: 110,
              ...sortProps('date'),
              ...serverDateRangeColumnFilter<UnifiedRow>(dateRange),
              render: (v: string | null) => (v ? new Date(v).toLocaleDateString('ru-RU') : '—'),
            },
            {
              title: 'Объект',
              key: 'site',
              ...sortProps('siteName'),
              render: (_: unknown, r: UnifiedRow) => `${r.siteCode} · ${r.siteName}`,
            },
            {
              title: 'Материал',
              dataIndex: 'materialName',
              width: 320,
              ...sortProps('materialName'),
            },
            {
              title: 'Кол-во',
              dataIndex: 'qty',
              width: 110,
              ...sortProps('qty'),
              render: (v: string | null) => trimQty(v),
            },
            {
              title: 'Ед.',
              dataIndex: 'unit',
              width: 80,
            },
            {
              title: 'Поставщик',
              dataIndex: 'supplierName',

              render: (v: string | null) => v ?? '—',
            },
            {
              title: 'Подрядчик',
              dataIndex: 'contractorName',

              render: (v: string | null) => v ?? '—',
            },
            {
              title: '№ УПД',
              dataIndex: 'docNumber',
              width: 140,
              ...sortProps('docNumber'),
              render: (v: string | null) => v ?? '—',
            },
            {
              title: 'Дата УПД',
              dataIndex: 'docDate',
              width: 110,
              ...sortProps('docDate'),
              ...serverDateRangeColumnFilter<UnifiedRow>(docDateRange),
              render: (v: string | null) => formatDocDate(v),
            },
            {
              title: 'Сумма НДС',
              dataIndex: 'vatSum',
              width: 120,

              render: (v: string | null) => formatMoneyRu(v),
            },
            {
              title: 'Сумма',
              dataIndex: 'sum',
              width: 130,
              ...sortProps('sum'),
              render: (v: string | null) => formatMoneyRu(v),
            },
            {
              title: 'Статус',
              key: 'status',
              width: 160,
              ...sortProps('status'),
              render: (_: unknown, r: UnifiedRow) => (
                <Tag color={statusTagColor(r.statusCode)}>{r.statusLabel}</Tag>
              ),
            },
          ]}
          cardRender={(r) => (
            <div style={{ width: '100%' }}>
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <Typography.Text strong>{r.materialName}</Typography.Text>
                <Typography.Text strong>
                  {trimQty(r.qty)} {r.unit}
                </Typography.Text>
              </Space>
              <Space>
                <Tag color={TYPE_LABELS[r.type].color}>{TYPE_LABELS[r.type].label}</Tag>
                <Tag color={statusTagColor(r.statusCode)}>{r.statusLabel}</Tag>
                <Typography.Text type="secondary">
                  {r.siteCode} · {r.siteName}
                </Typography.Text>
              </Space>
              <Typography.Text type="secondary" style={{ display: 'block' }}>
                {r.date ? new Date(r.date).toLocaleDateString('ru-RU') : '—'} ·{' '}
                {r.type === 'intake' ? (r.supplierName ?? '—') : (r.contractorName ?? 'списание')}
              </Typography.Text>
              {r.type === 'intake' && (
                <Typography.Text type="secondary" style={{ display: 'block' }}>
                  Сумма {formatMoneyRu(r.sum)} · НДС {formatMoneyRu(r.vatSum)}
                </Typography.Text>
              )}
            </div>
          )}
        />
      </StickyPageHeader>
      <MaterialPhotosModal
        kind={photosFor?.kind ?? null}
        id={photosFor?.id ?? null}
        open={photosFor !== null}
        onClose={() => setPhotosFor(null)}
      />
    </StickyPageHeader>
  );
}
