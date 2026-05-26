import { useState } from 'react';
import { DatePicker, Input, Select, Space, Tabs, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type {
  IntakeJournalResponse,
  IntakeJournalRow,
  ShipmentJournalResponse,
  ShipmentJournalRow,
  ShipmentKind,
  Site,
  StockBalanceResponse,
  StockBalanceRow,
} from '@matcheck/contracts';
import type { Dayjs } from 'dayjs';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';

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
  v ? v.split('-').reverse().join('.') : '—';

const trimQty = (s: string | null) => {
  if (!s) return '—';
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

const formatMoney = (s: string | null | undefined) => {
  if (s === null || s === undefined || s === '') return '—';
  const n = Number(s);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(2);
};

type MaterialsTab = 'balance' | 'intake' | 'shipment';

export default function MaterialsPage() {
  // Активный таб держим в state (а не во встроенных children Tabs),
  // чтобы навигационную панель вкладок можно было поместить в sticky
  // шапку, а содержимое таба — снаружи sticky-блока.
  const [activeKey, setActiveKey] = useState<MaterialsTab>('balance');
  return (
    <StickyPageHeader
      header={
        <>
          <Typography.Title level={3} style={{ margin: '0 0 8px' }}>
            Материалы
          </Typography.Title>
          <Tabs
            activeKey={activeKey}
            onChange={(k) => setActiveKey(k as MaterialsTab)}
            items={[
              { key: 'balance', label: 'На объекте' },
              { key: 'intake', label: 'Поступление' },
              { key: 'shipment', label: 'Отгрузка' },
            ]}
          />
        </>
      }
    >
      {activeKey === 'balance' && <BalanceTab />}
      {activeKey === 'intake' && <IntakeTab />}
      {activeKey === 'shipment' && <ShipmentTab />}
    </StickyPageHeader>
  );
}

// ─── Tab «На объекте» ─────────────────────────────────────────────────────

function BalanceTab() {
  const [siteId, setSiteId] = useState<string | undefined>(undefined);
  const [date, setDate] = useState<Dayjs | null>(null);
  const [q, setQ] = useState('');

  const sites = useQuery({
    queryKey: ['sites', 'all'],
    queryFn: () => api.get<{ items: Site[]; total: number }>('/sites?limit=500'),
  });

  const stockQuery = useQuery({
    queryKey: ['reports', 'stock', { siteId, date: date?.toISOString(), q }],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (siteId) qs.set('siteId', siteId);
      if (date) qs.set('date', date.endOf('day').toISOString());
      if (q) qs.set('q', q);
      return api.get<StockBalanceResponse>(`/reports/stock?${qs.toString()}`);
    },
  });

  return (
    <StickyPageHeader
      header={
        <Space wrap>
          <Select<string | undefined>
            allowClear
            placeholder="Все объекты"
            style={{ minWidth: 240 }}
            value={siteId}
            onChange={setSiteId}
            showSearch
            optionFilterProp="label"
            loading={sites.isLoading}
            options={(sites.data?.items ?? []).map((s) => ({
              value: s.id,
              label: `${s.code} · ${s.name}`,
            }))}
          />
          <DatePicker
            value={date}
            onChange={setDate}
            placeholder="На дату (сейчас)"
            format="DD.MM.YYYY"
          />
          <Input.Search
            placeholder="Материал"
            allowClear
            onSearch={setQ}
            style={{ width: 240 }}
          />
        </Space>
      }
    >
      <ResponsiveTable<StockBalanceRow>
        items={stockQuery.data?.items ?? []}
        loading={stockQuery.isLoading}
        rowKey={(r) => `${r.siteId}-${r.materialId ?? 'null'}-${r.unit}`}
        emptyText="Остатков нет"
        numbered
        columns={[
          { title: 'Объект', key: 'site', render: (_, r) => `${r.siteCode} · ${r.siteName}` },
          { title: 'Материал', dataIndex: 'materialName' },
          {
            title: 'Подрядчик',
            dataIndex: 'contractorName',
            render: (v: string | null) => v ?? '—',
          },
          { title: 'Принято', dataIndex: 'qtyIn', render: (v: string) => trimQty(v) },
          { title: 'Отгружено', dataIndex: 'qtyOut', render: (v: string) => trimQty(v) },
          {
            title: 'Остаток',
            dataIndex: 'balance',
            render: (v: string) => {
              const n = Number(v);
              return (
                <Typography.Text strong style={{ color: n < 0 ? '#cf1322' : undefined }}>
                  {trimQty(v)}
                </Typography.Text>
              );
            },
          },
          { title: 'Ед.', dataIndex: 'unit', width: 80 },
          {
            title: 'Сумма',
            dataIndex: 'sum',
            width: 130,
            render: (v: string | null) => formatMoney(v),
          },
        ]}
        cardRender={(r) => (
          <div style={{ width: '100%' }}>
            <Space style={{ width: '100%', justifyContent: 'space-between' }}>
              <Typography.Text strong>{r.materialName}</Typography.Text>
              <Typography.Text
                strong
                style={{ color: Number(r.balance) < 0 ? '#cf1322' : undefined }}
              >
                {trimQty(r.balance)} {r.unit}
              </Typography.Text>
            </Space>
            <Typography.Text type="secondary">
              {r.siteCode} · {r.siteName}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ display: 'block' }}>
              Принято {trimQty(r.qtyIn)} · Отгружено {trimQty(r.qtyOut)}
            </Typography.Text>
          </div>
        )}
      />
    </StickyPageHeader>
  );
}

// ─── Tab «Поступление» ────────────────────────────────────────────────────

function IntakeTab() {
  const navigate = useNavigate();
  const [siteId, setSiteId] = useState<string | undefined>(undefined);
  const [q, setQ] = useState('');

  const sites = useQuery({
    queryKey: ['sites', 'all'],
    queryFn: () => api.get<{ items: Site[]; total: number }>('/sites?limit=500'),
  });

  const intakeQuery = useQuery({
    queryKey: ['reports', 'intake', { siteId, q }],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (siteId) qs.set('siteId', siteId);
      if (q) qs.set('q', q);
      qs.set('limit', '500');
      return api.get<IntakeJournalResponse>(`/reports/intake?${qs.toString()}`);
    },
  });

  return (
    <StickyPageHeader
      header={
        <Space wrap>
          <Select<string | undefined>
            allowClear
            placeholder="Все объекты"
            style={{ minWidth: 240 }}
            value={siteId}
            onChange={setSiteId}
            showSearch
            optionFilterProp="label"
            loading={sites.isLoading}
            options={(sites.data?.items ?? []).map((s) => ({
              value: s.id,
              label: `${s.code} · ${s.name}`,
            }))}
          />
          <Input.Search
            placeholder="Материал или поставщик"
            allowClear
            onSearch={setQ}
            style={{ width: 320 }}
          />
        </Space>
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
            render: (v: string | null) =>
              v ? new Date(v).toLocaleDateString('ru-RU') : '—',
            width: 110,
          },
          { title: 'Объект', key: 'site', render: (_, r) => `${r.siteCode} · ${r.siteName}` },
          { title: 'Материал', dataIndex: 'materialName' },
          { title: 'Кол-во', dataIndex: 'qty', render: (v: string | null) => trimQty(v), width: 110 },
          { title: 'Ед.', dataIndex: 'unit', width: 80 },
          { title: 'Поставщик', dataIndex: 'supplierName', render: (v) => v ?? '—' },
          { title: 'Подрядчик', dataIndex: 'contractorName', render: (v) => v ?? '—' },
          {
            title: '№ УПД',
            dataIndex: 'docNumber',
            render: (v: string | null) => v ?? '—',
            width: 140,
          },
          {
            title: 'Дата УПД',
            dataIndex: 'docDate',
            render: (v: string | null) => formatDocDate(v),
            width: 110,
          },
          {
            title: 'Сумма НДС',
            dataIndex: 'vatSum',
            width: 120,
            render: (v: string | null) => formatMoney(v),
          },
          {
            title: 'Сумма',
            dataIndex: 'sum',
            width: 130,
            render: (v: string | null) => formatMoney(v),
          },
          {
            title: 'Статус',
            key: 'status',
            width: 160,
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
              Сумма {formatMoney(r.sum)} · НДС {formatMoney(r.vatSum)}
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

function ShipmentTab() {
  const navigate = useNavigate();
  const [siteId, setSiteId] = useState<string | undefined>(undefined);
  const [kind, setKind] = useState<ShipmentKind | undefined>(undefined);
  const [q, setQ] = useState('');

  const sites = useQuery({
    queryKey: ['sites', 'all'],
    queryFn: () => api.get<{ items: Site[]; total: number }>('/sites?limit=500'),
  });

  const shipmentQuery = useQuery({
    queryKey: ['reports', 'shipment', { siteId, kind, q }],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (siteId) qs.set('siteId', siteId);
      if (kind) qs.set('kind', kind);
      if (q) qs.set('q', q);
      qs.set('limit', '500');
      return api.get<ShipmentJournalResponse>(`/reports/shipment?${qs.toString()}`);
    },
  });

  return (
    <StickyPageHeader
      header={
        <Space wrap>
          <Select<string | undefined>
            allowClear
            placeholder="Все объекты"
            style={{ minWidth: 240 }}
            value={siteId}
            onChange={setSiteId}
            showSearch
            optionFilterProp="label"
            loading={sites.isLoading}
            options={(sites.data?.items ?? []).map((s) => ({
              value: s.id,
              label: `${s.code} · ${s.name}`,
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
          <Input.Search
            placeholder="Материал или получатель"
            allowClear
            onSearch={setQ}
            style={{ width: 320 }}
          />
        </Space>
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
            render: (v: string | null) =>
              v ? new Date(v).toLocaleDateString('ru-RU') : '—',
            width: 110,
          },
          {
            title: 'Вид',
            key: 'kind',
            width: 130,
            render: (_, r) => (
              <Tag color={KIND_LABELS[r.kind].color}>{KIND_LABELS[r.kind].label}</Tag>
            ),
          },
          { title: 'Объект', key: 'site', render: (_, r) => `${r.siteCode} · ${r.siteName}` },
          { title: 'Материал', dataIndex: 'materialName' },
          {
            title: 'Кол-во',
            dataIndex: 'qty',
            render: (v: string | null) => trimQty(v),
            width: 110,
          },
          { title: 'Ед.', dataIndex: 'unit', width: 80 },
          {
            title: 'Получатель',
            key: 'receiver',
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
