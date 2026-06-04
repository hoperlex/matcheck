import { useMemo, useState } from 'react';
import { DatePicker, Select, Space, Typography } from 'antd';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import type {
  InspectorStatsResponse,
  InspectorStatsRow,
  Site,
} from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { dateSorter, numberSorter, stringSorter } from '../../shared/ui/tableSorters';
import { dateRangeColumnFilter } from '../../shared/ui/DateRangeFilter';
import { formatMoneyRu } from '../../shared/utils/formatRu';

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

  const sites = useQuery({
    queryKey: ['sites', 'all'],
    queryFn: () => api.get<{ items: Site[]; total: number }>('/sites?limit=500'),
  });
  const dateFrom = range?.[0] ? range[0].startOf('day').toISOString() : undefined;
  const dateTo = range?.[1] ? range[1].endOf('day').toISOString() : undefined;

  const statsQuery = useQuery({
    queryKey: ['reports', 'inspector-stats', { siteIds, inspectorIds, dateFrom, dateTo }],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (siteIds.length) qs.set('siteId', siteIds.join(','));
      if (inspectorIds.length) qs.set('inspectorId', inspectorIds.join(','));
      if (dateFrom) qs.set('dateFrom', dateFrom);
      if (dateTo) qs.set('dateTo', dateTo);
      qs.set('limit', '500');
      return api.get<InspectorStatsResponse>(`/reports/inspector-stats?${qs.toString()}`);
    },
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => statsQuery.data?.items ?? [], [statsQuery.data]);

  // Опции инспекторов собираем из ответа: «инспекторы которые работали в
  // выбранном диапазоне». Когда нужен «все инспекторы» — отдельный
  // endpoint /users?role= (пока не нужен).
  const inspectorOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      if (!seen.has(r.inspectorId)) seen.set(r.inspectorId, inspectorName(r));
    }
    return Array.from(seen.entries()).map(([value, label]) => ({ value, label }));
  }, [rows]);

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
                { label: '7 дней', value: [dayjs().subtract(6, 'day').startOf('day'), dayjs().endOf('day')] },
                { label: '30 дней', value: [dayjs().subtract(29, 'day').startOf('day'), dayjs().endOf('day')] },
              ]}
            />
            <Select<string[]>
              mode="multiple"
              allowClear
              placeholder="Все объекты"
              style={{ minWidth: 240 }}
              value={siteIds}
              onChange={setSiteIds}
              showSearch
              optionFilterProp="label"
              maxTagCount="responsive"
              loading={sites.isLoading}
              options={(sites.data?.items ?? []).map((s) => ({
                value: s.id,
                label: `${s.code} · ${s.name}`,
              }))}
            />
            <Select<string[]>
              mode="multiple"
              allowClear
              placeholder="Все инспекторы"
              style={{ minWidth: 240 }}
              value={inspectorIds}
              onChange={setInspectorIds}
              showSearch
              optionFilterProp="label"
              maxTagCount="responsive"
              options={inspectorOptions}
            />
          </Space>
        }
      >
        <ResponsiveTable<InspectorStatsRow>
          items={rows}
          loading={statsQuery.isLoading}
          // rowKey — тройка (дата+инспектор+объект) уникальна по GROUP BY на бэке.
          rowKey={(r) => `${r.date}:${r.inspectorId}:${r.siteId}`}
          emptyText="Нет данных за выбранный период"
          numbered
          columns={[
            {
              title: 'Дата',
              dataIndex: 'date',
              width: 130,
              sorter: dateSorter<InspectorStatsRow>((r) => r.date),
              ...dateRangeColumnFilter<InspectorStatsRow>((r) => r.date),
              render: (v: string) => formatDate(v),
            },
            {
              title: 'Инспектор',
              key: 'inspector',
              sorter: stringSorter<InspectorStatsRow>(inspectorName),
              render: (_: unknown, r: InspectorStatsRow) => inspectorName(r),
            },
            {
              title: 'Объект',
              key: 'site',
              sorter: stringSorter<InspectorStatsRow>((r) => `${r.siteCode} · ${r.siteName}`),
              render: (_: unknown, r: InspectorStatsRow) => `${r.siteCode} · ${r.siteName}`,
            },
            {
              title: 'Приёмки',
              dataIndex: 'deliveries',
              width: 110,
              align: 'right' as const,
              sorter: numberSorter<InspectorStatsRow>((r) => r.deliveries),
            },
            {
              title: 'Отгрузки',
              dataIndex: 'shipments',
              width: 110,
              align: 'right' as const,
              sorter: numberSorter<InspectorStatsRow>((r) => r.shipments),
            },
            {
              title: 'Машин',
              dataIndex: 'vehicles',
              width: 110,
              align: 'right' as const,
              sorter: numberSorter<InspectorStatsRow>((r) => r.vehicles),
            },
            {
              title: 'Сумма без НДС',
              dataIndex: 'sumNoVat',
              width: 180,
              align: 'right' as const,
              sorter: numberSorter<InspectorStatsRow>((r) => r.sumNoVat),
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
