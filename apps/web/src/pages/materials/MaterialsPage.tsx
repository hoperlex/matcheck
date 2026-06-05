import { useMemo, useState } from 'react';
import { Button, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { PictureOutlined } from '@ant-design/icons';
import { DebouncedSearch } from '../../shared/ui/DebouncedSearch';
import { MaterialPhotosModal } from './MaterialPhotosModal';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type {
  Counterparty,
  IntakeJournalResponse,
  IntakeJournalRow,
  ShipmentJournalResponse,
  ShipmentJournalRow,
  Site,
} from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { dateSorter, numberSorter, stringSorter } from '../../shared/ui/tableSorters';
import { dateRangeColumnFilter } from '../../shared/ui/DateRangeFilter';
import { formatMoneyRu } from '../../shared/utils/formatRu';
import { useSyncGlobalFiltersSiteContractor } from '../../shared/hooks/useSyncGlobalFilters';

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
 * Унифицированная строка журнала: общая структура для приёмки и отгрузки.
 * Поля, которые есть только в одном типе (Поставщик, Сумма НДС, Сумма),
 * остаются опциональными — для другого типа они показываются как «—».
 */
type UnifiedRow = {
  type: RowType;
  // Уникальный key строки. itemId источника гарантированно уникален в
  // пределах своего типа; чтобы избежать коллизий при мердже, мы префиксуем
  // его типом.
  rowKey: string;
  deliveryId: string | null;
  shipmentId: string | null;
  date: string | null;
  siteCode: string;
  siteName: string;
  materialName: string;
  qty: string | null;
  unit: string;
  supplierName: string | null;
  contractorName: string | null;
  docNumber: string | null;
  docDate: string | null;
  vatSum: string | null;
  sum: string | null;
  statusCode: string;
  statusLabel: string;
};

function fromIntake(r: IntakeJournalRow): UnifiedRow {
  return {
    type: 'intake',
    rowKey: `intake:${r.itemId}`,
    deliveryId: r.deliveryId,
    shipmentId: null,
    date: r.arrivedAt,
    siteCode: r.siteCode,
    siteName: r.siteName,
    materialName: r.materialName,
    qty: r.qty,
    unit: r.unit,
    supplierName: r.supplierName,
    contractorName: r.contractorName,
    docNumber: r.docNumber,
    docDate: r.docDate,
    vatSum: r.vatSum,
    sum: r.sum,
    statusCode: r.statusCode,
    statusLabel: r.statusLabel,
  };
}

function fromShipment(r: ShipmentJournalRow): UnifiedRow {
  // «Подрядчик» для отгрузки: для contractor/return — получатель-контрагент;
  // для transfer — объект-приёмник (это формально не подрядчик, но в общей
  // таблице семантически близко: «куда ушло»); для writeoff (списание) —
  // получателя нет.
  const contractorName =
    r.kind === 'transfer'
      ? r.destSiteName
      : r.kind === 'writeoff'
        ? null
        : r.receiverName;
  return {
    type: 'shipment',
    rowKey: `shipment:${r.itemId}`,
    deliveryId: null,
    shipmentId: r.shipmentId,
    date: r.shippedAt,
    siteCode: r.siteCode,
    siteName: r.siteName,
    materialName: r.materialName,
    qty: r.qty,
    unit: r.unit,
    supplierName: null,
    contractorName,
    docNumber: r.docNumber,
    docDate: r.docDate,
    vatSum: null,
    sum: null,
    statusCode: r.statusCode,
    statusLabel: r.statusLabel,
  };
}

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

  const sites = useQuery({
    queryKey: ['sites', 'all'],
    queryFn: () => api.get<{ items: Site[]; total: number }>('/sites?limit=500'),
  });
  const counterparties = useQuery({
    queryKey: ['counterparties', 'all'],
    queryFn: () =>
      api.get<{ items: Counterparty[]; total: number }>('/counterparties?limit=500'),
  });

  // Два параллельных запроса; объёмы небольшие (limit=500), мерж клиентом.
  // placeholderData: keepPreviousData — при смене фильтра старая выборка
  // остаётся на экране, новая подтягивается без прыжка к Empty/Spin.
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
    placeholderData: keepPreviousData,
  });
  const shipmentQuery = useQuery({
    queryKey: ['reports', 'shipment', { siteIds, contractorIds, q }],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (siteIds.length) qs.set('siteId', siteIds.join(','));
      if (contractorIds.length) qs.set('contractorId', contractorIds.join(','));
      if (q) qs.set('q', q);
      qs.set('limit', '500');
      return api.get<ShipmentJournalResponse>(`/reports/shipment?${qs.toString()}`);
    },
    placeholderData: keepPreviousData,
  });

  const rows = useMemo<UnifiedRow[]>(() => {
    const intake = (intakeQuery.data?.items ?? []).map(fromIntake);
    const shipment = (shipmentQuery.data?.items ?? []).map(fromShipment);
    // Сортируем по дате DESC: свежие сверху. null-даты — в конец.
    return [...intake, ...shipment].sort((a, b) => {
      if (a.date == null && b.date == null) return 0;
      if (a.date == null) return 1;
      if (b.date == null) return -1;
      return b.date.localeCompare(a.date);
    });
  }, [intakeQuery.data, shipmentQuery.data]);

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
          loading={intakeQuery.isLoading || shipmentQuery.isLoading}
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
              defaultFilteredValue: ['intake'],
              onFilter: (val, r) => r.type === val,
              sorter: stringSorter<UnifiedRow>((r) => TYPE_LABELS[r.type].label),
              render: (_: unknown, r: UnifiedRow) => {
                // Иконка 📷 — открывает модалку с фото этой приёмки/отгрузки.
                // stopPropagation: иначе onRowClick параллельно открыл бы
                // edit-модалку в /operations.
                const targetId =
                  r.type === 'intake' ? r.deliveryId : r.shipmentId;
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
              sorter: dateSorter<UnifiedRow>((r) => r.date),
              ...dateRangeColumnFilter<UnifiedRow>((r) => r.date),
              render: (v: string | null) =>
                v ? new Date(v).toLocaleDateString('ru-RU') : '—',
            },
            {
              title: 'Объект',
              key: 'site',
              sorter: stringSorter<UnifiedRow>((r) => `${r.siteCode} · ${r.siteName}`),
              render: (_: unknown, r: UnifiedRow) => `${r.siteCode} · ${r.siteName}`,
            },
            {
              title: 'Материал',
              dataIndex: 'materialName',
              width: 320,
              sorter: stringSorter<UnifiedRow>((r) => r.materialName),
            },
            {
              title: 'Кол-во',
              dataIndex: 'qty',
              width: 110,
              sorter: numberSorter<UnifiedRow>((r) => r.qty),
              render: (v: string | null) => trimQty(v),
            },
            {
              title: 'Ед.',
              dataIndex: 'unit',
              width: 80,
              sorter: stringSorter<UnifiedRow>((r) => r.unit),
            },
            {
              title: 'Поставщик',
              dataIndex: 'supplierName',
              sorter: stringSorter<UnifiedRow>((r) => r.supplierName),
              render: (v: string | null) => v ?? '—',
            },
            {
              title: 'Подрядчик',
              dataIndex: 'contractorName',
              sorter: stringSorter<UnifiedRow>((r) => r.contractorName),
              render: (v: string | null) => v ?? '—',
            },
            {
              title: '№ УПД',
              dataIndex: 'docNumber',
              width: 140,
              sorter: stringSorter<UnifiedRow>((r) => r.docNumber),
              render: (v: string | null) => v ?? '—',
            },
            {
              title: 'Дата УПД',
              dataIndex: 'docDate',
              width: 110,
              sorter: dateSorter<UnifiedRow>((r) => r.docDate),
              ...dateRangeColumnFilter<UnifiedRow>((r) => r.docDate),
              render: (v: string | null) => formatDocDate(v),
            },
            {
              title: 'Сумма НДС',
              dataIndex: 'vatSum',
              width: 120,
              sorter: numberSorter<UnifiedRow>((r) => r.vatSum),
              render: (v: string | null) => formatMoneyRu(v),
            },
            {
              title: 'Сумма',
              dataIndex: 'sum',
              width: 130,
              sorter: numberSorter<UnifiedRow>((r) => r.sum),
              render: (v: string | null) => formatMoneyRu(v),
            },
            {
              title: 'Статус',
              key: 'status',
              width: 160,
              sorter: stringSorter<UnifiedRow>((r) => r.statusLabel),
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
                {r.type === 'intake'
                  ? r.supplierName ?? '—'
                  : r.contractorName ?? 'списание'}
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
