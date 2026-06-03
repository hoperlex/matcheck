import { useState } from 'react';
import { Select, Space, Tag, Typography } from 'antd';
import { DebouncedSearch } from '../../shared/ui/DebouncedSearch';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type {
  Counterparty,
  IntakeJournalResponse,
  IntakeJournalRow,
  ShipmentJournalResponse,
  ShipmentJournalRow,
  ShipmentKind,
  Site,
} from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { PageTabs, type PageTabItem } from '../../shared/ui/PageTabs';
import { dateSorter, numberSorter, stringSorter } from '../../shared/ui/tableSorters';
import { dateRangeColumnFilter } from '../../shared/ui/DateRangeFilter';
import { formatMoneyRu } from '../../shared/utils/formatRu';
import { useSyncGlobalFiltersSiteContractor } from '../../shared/hooks/useSyncGlobalFilters';

const KIND_LABELS: Record<ShipmentKind, { label: string; color: string }> = {
  contractor: { label: 'Подрядчику', color: 'geekblue' },
  return: { label: 'Возврат', color: 'magenta' },
  transfer: { label: 'Перемещение', color: 'cyan' },
  writeoff: { label: 'Списание', color: 'volcano' },
};

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

type MaterialsTab = 'intake' | 'shipment';

const MATERIALS_TABS: PageTabItem[] = [
  { key: 'intake', label: 'Поступление' },
  { key: 'shipment', label: 'Отгрузка' },
];

export default function MaterialsPage() {
  // Активный таб держим в state — навигация без URL-параметра, как и было.
  // Сами вкладки теперь рендерятся ВНУТРИ каждого таба под его фильтрами
  // (см. *TabHeader ниже), чтобы соответствовать общему UX-шаблону:
  // [фильтры] → [вкладки] → [таблица].
  const [activeKey, setActiveKey] = useState<MaterialsTab>('intake');
  const onTabChange = (k: string) => setActiveKey(k as MaterialsTab);
  return (
    <StickyPageHeader
      header={
        <Typography.Title level={3} style={{ margin: 0 }}>
          История поступлений
        </Typography.Title>
      }
    >
      {activeKey === 'intake' && (
        <IntakeTab activeTab={activeKey} onTabChange={onTabChange} />
      )}
      {activeKey === 'shipment' && (
        <ShipmentTab activeTab={activeKey} onTabChange={onTabChange} />
      )}
    </StickyPageHeader>
  );
}

// Общий блок «фильтры → вкладки» в шапке каждого таба «Материалов».
// Используется внутри StickyPageHeader.header.
function TabBarUnderFilters({
  activeTab,
  onTabChange,
}: {
  activeTab: MaterialsTab;
  onTabChange: (k: string) => void;
}) {
  return <PageTabs items={MATERIALS_TABS} activeKey={activeTab} onChange={onTabChange} />;
}

// ─── Tab «Поступление» ────────────────────────────────────────────────────

function IntakeTab({
  activeTab,
  onTabChange,
}: {
  activeTab: MaterialsTab;
  onTabChange: (k: string) => void;
}) {
  const navigate = useNavigate();
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [contractorIds, setContractorIds] = useState<string[]>([]);
  const [q, setQ] = useState('');
  useSyncGlobalFiltersSiteContractor({ siteIds, setSiteIds, contractorIds, setContractorIds });

  const sites = useQuery({
    queryKey: ['sites', 'all'],
    queryFn: () => api.get<{ items: Site[]; total: number }>('/sites?limit=500'),
  });
  const counterparties = useQuery({
    queryKey: ['counterparties', 'all'],
    queryFn: () =>
      api.get<{ items: Counterparty[]; total: number }>('/counterparties?limit=500'),
  });

  const intakeQuery = useQuery({
    queryKey: ['reports', 'intake', { siteIds, contractorIds, q }],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (siteIds.length) qs.set('siteId', siteIds.join(','));
      if (contractorIds.length) qs.set('contractorId', contractorIds.join(','));
      if (q) qs.set('q', q);
      qs.set('limit', '500');
      return api.get<IntakeJournalResponse>(`/reports/intake?${qs.toString()}`);
    },
  });

  return (
    <StickyPageHeader
      header={
        <>
          <Space wrap>
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
              placeholder="Подрядчик"
              style={{ minWidth: 240 }}
              value={contractorIds}
              onChange={setContractorIds}
              showSearch
              optionFilterProp="label"
              maxTagCount="responsive"
              loading={counterparties.isLoading}
              options={(counterparties.data?.items ?? []).map((c) => ({
                value: c.id,
                label: c.name,
              }))}
            />
            <DebouncedSearch
              placeholder="Материал или поставщик"
              value={q}
              onChange={setQ}
              style={{ width: 320 }}
            />
          </Space>
          <TabBarUnderFilters activeTab={activeTab} onTabChange={onTabChange} />
        </>
      }
    >
      <ResponsiveTable<IntakeJournalRow>
        items={intakeQuery.data?.items ?? []}
        loading={intakeQuery.isLoading}
        rowKey="itemId"
        emptyText="Нет данных"
        numbered
        onRowClick={(r) => navigate(`/kpp?delivery=${r.deliveryId}&from=accepted`)}
        columns={[
          {
            title: 'Дата',
            dataIndex: 'arrivedAt',
            width: 110,
            sorter: dateSorter<IntakeJournalRow>((r) => r.arrivedAt),
            ...dateRangeColumnFilter<IntakeJournalRow>((r) => r.arrivedAt),
            render: (v: string | null) =>
              v ? new Date(v).toLocaleDateString('ru-RU') : '—',
          },
          {
            title: 'Объект',
            key: 'site',
            sorter: stringSorter<IntakeJournalRow>((r) => `${r.siteCode} · ${r.siteName}`),
            render: (_, r) => `${r.siteCode} · ${r.siteName}`,
          },
          {
            title: 'Материал',
            dataIndex: 'materialName',
            width: 320,
            sorter: stringSorter<IntakeJournalRow>((r) => r.materialName),
          },
          {
            title: 'Кол-во',
            dataIndex: 'qty',
            width: 110,
            sorter: numberSorter<IntakeJournalRow>((r) => r.qty),
            render: (v: string | null) => trimQty(v),
          },
          {
            title: 'Ед.',
            dataIndex: 'unit',
            width: 80,
            sorter: stringSorter<IntakeJournalRow>((r) => r.unit),
          },
          {
            title: 'Поставщик',
            dataIndex: 'supplierName',
            sorter: stringSorter<IntakeJournalRow>((r) => r.supplierName),
            render: (v) => v ?? '—',
          },
          {
            title: 'Подрядчик',
            dataIndex: 'contractorName',
            sorter: stringSorter<IntakeJournalRow>((r) => r.contractorName),
            render: (v) => v ?? '—',
          },
          {
            title: '№ УПД',
            dataIndex: 'docNumber',
            width: 140,
            sorter: stringSorter<IntakeJournalRow>((r) => r.docNumber),
            render: (v: string | null) => v ?? '—',
          },
          {
            title: 'Дата УПД',
            dataIndex: 'docDate',
            width: 110,
            sorter: dateSorter<IntakeJournalRow>((r) => r.docDate),
            ...dateRangeColumnFilter<IntakeJournalRow>((r) => r.docDate),
            render: (v: string | null) => formatDocDate(v),
          },
          {
            title: 'Сумма НДС',
            dataIndex: 'vatSum',
            width: 120,
            sorter: numberSorter<IntakeJournalRow>((r) => r.vatSum),
            render: (v: string | null) => formatMoneyRu(v),
          },
          {
            title: 'Сумма',
            dataIndex: 'sum',
            width: 130,
            sorter: numberSorter<IntakeJournalRow>((r) => r.sum),
            render: (v: string | null) => formatMoneyRu(v),
          },
          {
            title: 'Статус',
            key: 'status',
            width: 160,
            sorter: stringSorter<IntakeJournalRow>((r) => r.statusLabel),
            render: (_, r) => (
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
            <Typography.Text type="secondary" style={{ display: 'block' }}>
              {r.siteCode} · {r.siteName}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ display: 'block' }}>
              {r.arrivedAt
                ? new Date(r.arrivedAt).toLocaleDateString('ru-RU')
                : '—'}{' '}
              · {r.supplierName ?? '—'}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ display: 'block' }}>
              Сумма {formatMoneyRu(r.sum)} · НДС {formatMoneyRu(r.vatSum)}
            </Typography.Text>
            <Tag color={statusTagColor(r.statusCode)} style={{ marginTop: 4 }}>
              {r.statusLabel}
            </Tag>
          </div>
        )}
      />
    </StickyPageHeader>
  );
}

// ─── Tab «Отгрузка» ───────────────────────────────────────────────────────

function ShipmentTab({
  activeTab,
  onTabChange,
}: {
  activeTab: MaterialsTab;
  onTabChange: (k: string) => void;
}) {
  const navigate = useNavigate();
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [contractorIds, setContractorIds] = useState<string[]>([]);
  const [kind, setKind] = useState<ShipmentKind | undefined>(undefined);
  const [q, setQ] = useState('');
  useSyncGlobalFiltersSiteContractor({ siteIds, setSiteIds, contractorIds, setContractorIds });

  const sites = useQuery({
    queryKey: ['sites', 'all'],
    queryFn: () => api.get<{ items: Site[]; total: number }>('/sites?limit=500'),
  });
  const counterparties = useQuery({
    queryKey: ['counterparties', 'all'],
    queryFn: () =>
      api.get<{ items: Counterparty[]; total: number }>('/counterparties?limit=500'),
  });

  const shipmentQuery = useQuery({
    queryKey: ['reports', 'shipment', { siteIds, contractorIds, kind, q }],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (siteIds.length) qs.set('siteId', siteIds.join(','));
      if (contractorIds.length) qs.set('contractorId', contractorIds.join(','));
      if (kind) qs.set('kind', kind);
      if (q) qs.set('q', q);
      qs.set('limit', '500');
      return api.get<ShipmentJournalResponse>(`/reports/shipment?${qs.toString()}`);
    },
  });

  return (
    <StickyPageHeader
      header={
        <>
          <Space wrap>
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
              placeholder="Подрядчик"
              style={{ minWidth: 240 }}
              value={contractorIds}
              onChange={setContractorIds}
              showSearch
              optionFilterProp="label"
              maxTagCount="responsive"
              loading={counterparties.isLoading}
              options={(counterparties.data?.items ?? []).map((c) => ({
                value: c.id,
                label: c.name,
              }))}
            />
            <Select<ShipmentKind | undefined>
              allowClear
              placeholder="Любой вид"
              style={{ minWidth: 180 }}
              value={kind}
              onChange={setKind}
              options={(Object.keys(KIND_LABELS) as ShipmentKind[]).map((k) => ({
                value: k,
                label: KIND_LABELS[k].label,
              }))}
            />
            <DebouncedSearch
              placeholder="Материал или получатель"
              value={q}
              onChange={setQ}
              style={{ width: 320 }}
            />
          </Space>
          <TabBarUnderFilters activeTab={activeTab} onTabChange={onTabChange} />
        </>
      }
    >
      <ResponsiveTable<ShipmentJournalRow>
        items={shipmentQuery.data?.items ?? []}
        loading={shipmentQuery.isLoading}
        rowKey="itemId"
        emptyText="Нет данных"
        numbered
        onRowClick={(r) => navigate(`/shipments?shipment=${r.shipmentId}&from=list`)}
        columns={[
          {
            title: 'Дата',
            dataIndex: 'shippedAt',
            width: 110,
            sorter: dateSorter<ShipmentJournalRow>((r) => r.shippedAt),
            ...dateRangeColumnFilter<ShipmentJournalRow>((r) => r.shippedAt),
            render: (v: string | null) =>
              v ? new Date(v).toLocaleDateString('ru-RU') : '—',
          },
          {
            title: 'Вид',
            key: 'kind',
            width: 130,
            sorter: stringSorter<ShipmentJournalRow>((r) => KIND_LABELS[r.kind].label),
            render: (_, r) => (
              <Tag color={KIND_LABELS[r.kind].color}>{KIND_LABELS[r.kind].label}</Tag>
            ),
          },
          {
            title: 'Объект',
            key: 'site',
            sorter: stringSorter<ShipmentJournalRow>((r) => `${r.siteCode} · ${r.siteName}`),
            render: (_, r) => `${r.siteCode} · ${r.siteName}`,
          },
          {
            title: 'Материал',
            dataIndex: 'materialName',
            width: 320,
            sorter: stringSorter<ShipmentJournalRow>((r) => r.materialName),
          },
          {
            title: 'Кол-во',
            dataIndex: 'qty',
            width: 110,
            sorter: numberSorter<ShipmentJournalRow>((r) => r.qty),
            render: (v: string | null) => trimQty(v),
          },
          {
            title: 'Ед.',
            dataIndex: 'unit',
            width: 80,
            sorter: stringSorter<ShipmentJournalRow>((r) => r.unit),
          },
          {
            title: 'Получатель',
            key: 'receiver',
            sorter: stringSorter<ShipmentJournalRow>((r) =>
              r.kind === 'transfer'
                ? r.destSiteName ?? null
                : r.kind === 'writeoff'
                  ? null
                  : r.receiverName ?? null,
            ),
            render: (_, r) =>
              r.kind === 'transfer'
                ? r.destSiteName ?? '—'
                : r.kind === 'writeoff'
                  ? '—'
                  : r.receiverName ?? '—',
          },
          {
            title: 'Статус',
            key: 'status',
            width: 160,
            sorter: stringSorter<ShipmentJournalRow>((r) => r.statusLabel),
            render: (_, r) => (
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
              <Tag color={KIND_LABELS[r.kind].color}>{KIND_LABELS[r.kind].label}</Tag>
              <Tag color={statusTagColor(r.statusCode)}>{r.statusLabel}</Tag>
              <Typography.Text type="secondary">
                {r.siteCode} · {r.siteName}
              </Typography.Text>
            </Space>
            <Typography.Text type="secondary" style={{ display: 'block' }}>
              {r.shippedAt ? new Date(r.shippedAt).toLocaleDateString('ru-RU') : '—'} →{' '}
              {r.kind === 'transfer'
                ? r.destSiteName ?? '—'
                : r.kind === 'writeoff'
                  ? 'списание'
                  : r.receiverName ?? '—'}
            </Typography.Text>
          </div>
        )}
      />
    </StickyPageHeader>
  );
}
