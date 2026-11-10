import { useSearchParams } from 'react-router-dom';
import { Alert, Card, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { Site, SupplierContractSummary, SupplierContractsListResponse } from '@matcheck/contracts';
import { api } from '../../services/api';
import { DebouncedSearch } from '../../shared/ui/DebouncedSearch';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { formatMsk } from '../../shared/utils/estimatOrder';
import { contractDateRu, SITE_STATUS_LABELS } from '../../shared/utils/supplierContract';

const PAGE_SIZE = 50;
const FILTER_WIDTH = 260;

const KIND_LABELS: Record<SupplierContractSummary['kind'], string> = {
  supplier: 'С поставщиком',
  buyer: 'С покупателем',
  other: 'Прочее',
};

const STATUS_COLORS: Record<SupplierContractSummary['siteStatus'], string | undefined> = {
  exact: 'green',
  group: 'green',
  conflict: 'gold',
  none: undefined,
};

function SiteCell({ c }: { c: SupplierContractSummary }) {
  const codes = c.siteStatus === 'conflict' ? c.siteCodes.join(' / ') : c.siteCodes.join(', ');
  return (
    <Tag color={STATUS_COLORS[c.siteStatus]} style={{ whiteSpace: 'normal', marginInlineEnd: 0 }}>
      {codes ? `${codes} · ${SITE_STATUS_LABELS[c.siteStatus]}` : SITE_STATUS_LABELS[c.siteStatus]}
    </Tag>
  );
}

/**
 * Справочник «Договоры» — договоры с контрагентами из выгрузки 1С (группа
 * Снабжение). Только чтение: справочник обновляет CLI-импорт
 * (scripts/import-contracts.ts). Объект — подсказка правил по тексту договора.
 */
export default function SupplierContracts() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const siteId = params.get('site') ?? undefined;
  const pageRaw = Number.parseInt(params.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const offset = (page - 1) * PAGE_SIZE;

  const setFilter = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page');
    setParams(next, { replace: true });
  };
  const setPage = (n: number) => {
    const next = new URLSearchParams(params);
    if (n <= 1) next.delete('page');
    else next.set('page', String(n));
    setParams(next, { replace: true });
  };

  const sites = useQuery({
    queryKey: ['sites', { activeOnly: false, limit: 200 }],
    queryFn: () => api.get<{ items: Site[]; total: number }>('/sites?limit=200'),
  });

  const listParams = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (q) listParams.set('q', q);
  if (siteId) listParams.set('siteId', siteId);
  const list = useQuery({
    queryKey: ['supplier-contracts', listParams.toString()],
    queryFn: () => api.get<SupplierContractsListResponse>(`/supplier-contracts?${listParams.toString()}`),
  });

  const items = list.data?.items ?? [];
  const importedAt = list.data?.importedAt;
  return (
    <StickyPageHeader
      header={
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space align="baseline" wrap>
            <Typography.Title level={3} style={{ margin: 0 }}>
              Договоры
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              договоры с контрагентами из 1С (группа Снабжение) · только чтение
              {importedAt ? ` · загружены ${formatMsk(importedAt)} (МСК)` : ' · ещё не загружались'}
            </Typography.Text>
          </Space>
          <Space wrap size={8}>
            <DebouncedSearch
              placeholder="Номер, адрес, контрагент, ИНН"
              value={q}
              onChange={(v) => setFilter('q', v.trim() || undefined)}
              style={{ width: 300 }}
            />
            <Select<string>
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="Объект"
              value={siteId}
              onChange={(v) => setFilter('site', v)}
              style={{ width: FILTER_WIDTH }}
              loading={sites.isLoading}
              options={(sites.data?.items ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))}
              optionRender={(o) => (
                <Tooltip title={o.label} placement="left">
                  <span>{o.label}</span>
                </Tooltip>
              )}
            />
          </Space>
        </Space>
      }
    >
      {list.isError && <Alert type="error" showIcon message="Не удалось загрузить договоры" />}
      <ResponsiveTable<SupplierContractSummary>
        items={items}
        loading={list.isLoading}
        rowKey="id"
        scrollX={1350}
        emptyText={importedAt ? 'Договоров нет' : 'Договоры из 1С ещё не загружались'}
        numberedOffset={offset}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: list.data?.total ?? 0,
          showSizeChanger: false,
          onChange: setPage,
        }}
        columns={[
          {
            title: 'Контрагент',
            key: 'counterparty',
            width: 240,
            render: (_v, r) => (
              <Typography.Text ellipsis={{ tooltip: r.counterpartyName }} style={{ display: 'block' }}>
                {r.counterpartyName}
              </Typography.Text>
            ),
          },
          { title: 'ИНН', key: 'inn', width: 120, render: (_v, r) => r.counterpartyInn },
          {
            title: 'Договор',
            key: 'name',
            width: 420,
            render: (_v, r) => <Typography.Text style={{ whiteSpace: 'normal' }}>{r.name}</Typography.Text>,
          },
          { title: '№', key: 'number', width: 160, render: (_v, r) => r.number ?? '—' },
          { title: 'Дата', key: 'date', width: 100, render: (_v, r) => contractDateRu(r.contractDate) },
          { title: 'Вид', key: 'kind', width: 130, render: (_v, r) => KIND_LABELS[r.kind] },
          { title: 'Объект', key: 'site', width: 170, render: (_v, r) => <SiteCell c={r} /> },
          {
            title: 'В выгрузке',
            key: 'missing',
            width: 110,
            render: (_v, r) =>
              r.missingSince ? (
                <Tooltip title={`Нет в выгрузке 1С с ${formatMsk(r.missingSince)}`}>
                  <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                    нет
                  </Tag>
                </Tooltip>
              ) : (
                'да'
              ),
          },
        ]}
        cardRender={(r) => (
          <Card style={{ width: '100%' }} size="small">
            <Space direction="vertical" size={4}>
              <Typography.Text strong>{r.name}</Typography.Text>
              <Typography.Text type="secondary">
                {r.counterpartyName} · ИНН {r.counterpartyInn}
              </Typography.Text>
              <Space wrap size={6}>
                <SiteCell c={r} />
                {r.missingSince && <Tag color="orange">нет в выгрузке</Tag>}
              </Space>
            </Space>
          </Card>
        )}
      />
    </StickyPageHeader>
  );
}
