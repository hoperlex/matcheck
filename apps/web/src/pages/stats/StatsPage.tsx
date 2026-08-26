import { useEffect, useMemo, useState } from 'react';
import { Collapse, DatePicker, Space, Typography, type TableProps } from 'antd';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import type {
  InspectorOptionsResponse,
  InspectorStatsResponse,
  InspectorStatsRow,
  Site,
  StatsSummaryResponse,
} from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { FilterSelect } from '../../shared/ui/FilterSelect';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';

import { formatMoneyRu } from '../../shared/utils/formatRu';
import { KpiStrip } from './widgets/KpiStrip';
import { DailyBarChart } from './widgets/DailyBarChart';
import { AttentionCounters } from './widgets/AttentionCounters';

// Поля серверной сортировки отчёта по инспекторам.
type StatsSort =
  | 'date'
  | 'inspector'
  | 'site'
  | 'deliveries'
  | 'shipments'
  | 'vehicles'
  | 'sumNoVat';

const SUMMARY_OPEN_KEY = 'matcheck:stats:summary-open';

// Имя инспектора в таблице: ФИО, иначе email (на случай если ФИО ещё
// не заполнено в Администрирование → Пользователи).
function inspectorName(r: InspectorStatsRow): string {
  return r.inspectorFullName?.trim() || r.inspectorEmail;
}

// dd.mm.yyyy для отображения. Серверная date — 'YYYY-MM-DD' в МСК.
function formatDate(v: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const [y, m, d] = v.split('-');
  return `${d}.${m}.${y}`;
}

export default function StatsPage() {
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [inspectorIds, setInspectorIds] = useState<string[]>([]);
  // Диапазон в локальной TZ браузера; на бэк отправляем ISO с TZ — он
  // сам нарежет по МСК-границам через AT TIME ZONE.
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);

  // Сворачиваемое состояние сводки — помним между сессиями. Если
  // пользователь свернул, не раскрываем обратно при каждом refetch.
  const [summaryOpen, setSummaryOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const raw = window.localStorage.getItem(SUMMARY_OPEN_KEY);
    return raw === null ? true : raw === '1';
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(SUMMARY_OPEN_KEY, summaryOpen ? '1' : '0');
    } catch {
      // ignore quota/private-mode
    }
  }, [summaryOpen]);

  const sites = useQuery({
    queryKey: ['sites', { limit: 500 }],
    queryFn: () => api.get<{ items: Site[]; total: number }>('/sites?limit=500'),
  });
  const dateFrom = range?.[0] ? range[0].startOf('day').toISOString() : undefined;
  const dateTo = range?.[1] ? range[1].endOf('day').toISOString() : undefined;

  // Для summary endpoint'а нужны YYYY-MM-DD (МСК-день), а не ISO. Если
  // диапазон не задан — не передаём from/to, бэк сам поставит default
  // 30 дней до сегодня.
  const summaryFrom = range?.[0] ? range[0].format('YYYY-MM-DD') : undefined;
  const summaryTo = range?.[1] ? range[1].format('YYYY-MM-DD') : undefined;
  const summaryQuery = useQuery({
    queryKey: [
      'reports',
      'stats-summary',
      { siteIds, inspectorIds, from: summaryFrom, to: summaryTo },
    ],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (siteIds.length) qs.set('siteIds', siteIds.join(','));
      if (inspectorIds.length) qs.set('inspectorIds', inspectorIds.join(','));
      if (summaryFrom) qs.set('from', summaryFrom);
      if (summaryTo) qs.set('to', summaryTo);
      const qsStr = qs.toString();
      return api.get<StatsSummaryResponse>(`/reports/stats-summary${qsStr ? `?${qsStr}` : ''}`);
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  // Пагинация серверная: групп «день × инспектор × объект» больше, чем потолок
  // запроса, и раньше половина истории была недоступна — за пределы первых 500
  // строк нельзя было ни пролистать, ни отсортироваться.
  const PAGE_SIZE = 100;
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<StatsSort | null>(null);
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  useEffect(() => {
    setPage(1);
  }, [siteIds, inspectorIds, dateFrom, dateTo]);
  const statsQuery = useQuery({
    queryKey: [
      'reports',
      'inspector-stats',
      { siteIds, inspectorIds, dateFrom, dateTo, page, sort, order },
    ],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (siteIds.length) qs.set('siteId', siteIds.join(','));
      if (inspectorIds.length) qs.set('inspectorId', inspectorIds.join(','));
      if (dateFrom) qs.set('dateFrom', dateFrom);
      if (dateTo) qs.set('dateTo', dateTo);
      qs.set('limit', String(PAGE_SIZE));
      qs.set('offset', String((page - 1) * PAGE_SIZE));
      if (sort) {
        qs.set('sort', sort);
        qs.set('order', order);
      }
      return api.get<InspectorStatsResponse>(`/reports/inspector-stats?${qs.toString()}`);
    },
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => statsQuery.data?.items ?? [], [statsQuery.data]);

  // Опции инспекторов — из справочника, а не из строк ответа. Раньше список
  // строился по выдаче: выбрал одного инспектора — ответ сузился до него, и
  // добавить второго стало нечем, пока не снимешь фильтр. Плюс инспекторы,
  // чьи смены не попали в текущую страницу отчёта, в списке не появлялись вовсе.
  const inspectors = useQuery({
    queryKey: ['reports', 'inspectors'],
    queryFn: () => api.get<InspectorOptionsResponse>('/reports/inspectors'),
    staleTime: 5 * 60_000,
  });
  // Сортировка серверная — колонке достаточно знать, активна ли она.
  const sortProps = (columnKey: StatsSort) => ({
    sorter: true as const,
    sortOrder:
      sort === columnKey
        ? ((order === 'asc' ? 'ascend' : 'descend') as 'ascend' | 'descend')
        : null,
  });

  const handleTableChange: NonNullable<TableProps<InspectorStatsRow>['onChange']> = (
    tablePagination,
    _tableFilters,
    tableSorter,
  ) => {
    const single = Array.isArray(tableSorter) ? tableSorter[0] : tableSorter;
    const nextSort = single?.order ? ((single.columnKey as StatsSort) ?? null) : null;
    const nextOrder: 'asc' | 'desc' = single?.order === 'ascend' ? 'asc' : 'desc';
    const changed = nextSort !== sort || nextOrder !== order;
    setSort(nextSort);
    setOrder(nextOrder);
    setPage(changed ? 1 : (tablePagination.current ?? 1));
  };

  const inspectorOptions = useMemo(
    () =>
      (inspectors.data?.items ?? []).map((i) => ({
        value: i.id,
        label: i.fullName?.trim() || i.email,
      })),
    [inspectors.data],
  );

  return (
    <StickyPageHeader
      header={
        <Typography.Title level={3} style={{ margin: 0 }}>
          Статистика
        </Typography.Title>
      }
    >
      <StickyPageHeader
        header={
          <Space wrap>
            <DatePicker.RangePicker
              value={range as [Dayjs, Dayjs] | null}
              onChange={(v) => setRange(v as [Dayjs | null, Dayjs | null] | null)}
              format="DD.MM.YYYY"
              presets={[
                { label: 'Сегодня', value: [dayjs().startOf('day'), dayjs().endOf('day')] },
                {
                  label: 'Вчера',
                  value: [
                    dayjs().subtract(1, 'day').startOf('day'),
                    dayjs().subtract(1, 'day').endOf('day'),
                  ],
                },
                {
                  label: '7 дней',
                  value: [dayjs().subtract(6, 'day').startOf('day'), dayjs().endOf('day')],
                },
                {
                  label: '30 дней',
                  value: [dayjs().subtract(29, 'day').startOf('day'), dayjs().endOf('day')],
                },
              ]}
            />
            {/* Общий FilterSelect: фиксированная ширина и «+N» — панель не
                меняет геометрию от длины выбранного названия. */}
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
              placeholder="Все инспекторы"
              value={inspectorIds}
              onChange={setInspectorIds}
              loading={inspectors.isLoading}
              options={inspectorOptions}
            />
          </Space>
        }
      >
        <Collapse
          activeKey={summaryOpen ? ['summary'] : []}
          onChange={(keys) => {
            const arr = Array.isArray(keys) ? keys : [keys];
            setSummaryOpen(arr.includes('summary'));
          }}
          style={{ marginBottom: 12, background: '#fff' }}
          items={[
            {
              key: 'summary',
              label: (
                <Typography.Text strong>
                  Сводка за период
                  <Typography.Text type="secondary" style={{ marginLeft: 8, fontWeight: 400 }}>
                    {summaryQuery.data?.range
                      ? ` ${formatDate(summaryQuery.data.range.from)} — ${formatDate(summaryQuery.data.range.to)} · ${summaryQuery.data.range.days} дн.`
                      : ''}
                  </Typography.Text>
                </Typography.Text>
              ),
              children: (
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  <KpiStrip data={summaryQuery.data} loading={summaryQuery.isLoading} />
                  <DailyBarChart data={summaryQuery.data} loading={summaryQuery.isLoading} />
                  <div>
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 12, display: 'block', marginBottom: 6 }}
                    >
                      Требует внимания
                    </Typography.Text>
                    <AttentionCounters
                      data={summaryQuery.data}
                      loading={summaryQuery.isLoading}
                      // Ссылки с плашек уносят тот же период и те же объекты,
                      // по которым посчитаны числа.
                      scope={{
                        siteIds,
                        dateFrom: summaryQuery.data?.range.from ?? summaryFrom ?? null,
                        dateTo: summaryQuery.data?.range.to ?? summaryTo ?? null,
                      }}
                    />
                  </div>
                </Space>
              ),
            },
          ]}
        />
        <ResponsiveTable<InspectorStatsRow>
          items={rows}
          loading={statsQuery.isLoading}
          // rowKey — тройка (дата+инспектор+объект) уникальна по GROUP BY на бэке.
          rowKey={(r) => `${r.date}:${r.inspectorId}:${r.siteId}`}
          emptyText="Нет данных за выбранный период"
          numbered
          numberedOffset={(page - 1) * PAGE_SIZE}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total: statsQuery.data?.total ?? 0,
            showSizeChanger: false,
            showTotal: (total) => `Всего: ${total}`,
          }}
          onChange={handleTableChange}
          columns={[
            {
              title: 'Дата',
              dataIndex: 'date',
              width: 130,
              ...sortProps('date'),
              render: (v: string) => formatDate(v),
            },
            {
              title: 'Инспектор',
              key: 'inspector',
              ...sortProps('inspector'),
              render: (_: unknown, r: InspectorStatsRow) => inspectorName(r),
            },
            {
              title: 'Объект',
              key: 'site',
              ...sortProps('site'),
              render: (_: unknown, r: InspectorStatsRow) => `${r.siteCode} · ${r.siteName}`,
            },
            {
              title: 'Приёмки',
              dataIndex: 'deliveries',
              width: 110,
              align: 'right' as const,
              ...sortProps('deliveries'),
            },
            {
              title: 'Отгрузки',
              dataIndex: 'shipments',
              width: 110,
              align: 'right' as const,
              ...sortProps('shipments'),
            },
            {
              title: 'Машин',
              dataIndex: 'vehicles',
              width: 110,
              align: 'right' as const,
              ...sortProps('vehicles'),
            },
            {
              title: 'Сумма',
              dataIndex: 'sumNoVat',
              width: 180,
              align: 'right' as const,
              ...sortProps('sumNoVat'),
              render: (v: string) => formatMoneyRu(v),
            },
          ]}
          cardRender={(r) => (
            <div style={{ width: '100%' }}>
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <Typography.Text strong>{inspectorName(r)}</Typography.Text>
                <Typography.Text strong>{formatMoneyRu(r.sumNoVat)}</Typography.Text>
              </Space>
              <Typography.Text type="secondary" style={{ display: 'block' }}>
                {formatDate(r.date)} · {r.siteCode} · {r.siteName}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ display: 'block' }}>
                Приёмки: {r.deliveries} · Отгрузки: {r.shipments} · Машин: {r.vehicles}
              </Typography.Text>
            </div>
          )}
        />
      </StickyPageHeader>
    </StickyPageHeader>
  );
}
