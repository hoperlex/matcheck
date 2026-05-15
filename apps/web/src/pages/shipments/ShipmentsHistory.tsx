import type { MouseEvent } from 'react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button,
  Card,
  Input,
  Popconfirm,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Counterparty,
  Shipment,
  ShipmentKind,
  ShipmentListResponseSchema,
  Site,
  SourceDocumentListResponseSchema,
} from '@matcheck/contracts';
import type { z } from 'zod';
import { ApiError, api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { ListFilters, type ListFiltersValue } from '../../shared/ui/ListFilters';
import { matchText } from '../../shared/utils/matchText';

type List = z.infer<typeof ShipmentListResponseSchema>;
type Row = List['items'][number];
type SourceList = z.infer<typeof SourceDocumentListResponseSchema>;
type SourceRow = SourceList['items'][number];

const KIND_LABELS: Record<ShipmentKind, { label: string; color: string }> = {
  contractor: { label: 'Подрядчику', color: 'geekblue' },
  return: { label: 'Возврат', color: 'magenta' },
  transfer: { label: 'Перемещение', color: 'cyan' },
  writeoff: { label: 'Списание', color: 'volcano' },
};

const SELECT_WIDTH = 200;

export function ShipmentsHistory({ onOpen }: { onOpen: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [params, setParams] = useSearchParams();

  // tab/shipment/from принадлежат ShipmentPage — не трогаем их при апдейте фильтров.
  const filters: ListFiltersValue & { status: string | null; plate: string } = {
    contractorId: params.get('contractor'),
    supplierId: params.get('supplier'),
    siteId: params.get('site'),
    q: params.get('q') ?? '',
    status: params.get('status'),
    plate: params.get('plate') ?? '',
  };

  const updateFilters = (
    patch: Partial<ListFiltersValue & { status: string | null; plate: string }>,
  ) => {
    const next = new URLSearchParams(params);
    const apply = (key: string, val: string | null | undefined) => {
      if (val) next.set(key, val);
      else next.delete(key);
    };
    if ('contractorId' in patch) apply('contractor', patch.contractorId);
    if ('supplierId' in patch) apply('supplier', patch.supplierId);
    if ('siteId' in patch) apply('site', patch.siteId);
    if ('q' in patch) apply('q', patch.q);
    if ('status' in patch) apply('status', patch.status);
    if ('plate' in patch) apply('plate', patch.plate);
    setParams(next, { replace: true });
  };

  const list = useQuery({
    queryKey: ['shipments'],
    queryFn: () => api.get<List>('/shipments'),
  });

  const counterpartiesQuery = useQuery({
    queryKey: ['counterparties', 'all'],
    queryFn: () => api.get<{ items: Counterparty[]; total: number }>('/counterparties?limit=500'),
  });
  const sitesQuery = useQuery({
    queryKey: ['sites', 'all'],
    queryFn: () => api.get<{ items: Site[]; total: number }>('/sites?limit=500'),
  });
  // Резолв docNumber для поиска по q и опционального отображения.
  const sourceDocsQuery = useQuery({
    queryKey: ['source-documents', 'all', 'outbound'],
    queryFn: () =>
      api.get<SourceList>('/source-documents?direction=outbound&limit=1000'),
  });

  // Оптимистичное удаление с rollback и индикатором ошибки на строке —
  // см. эталон в apps/web/src/pages/inbox/Inbox.tsx.
  const del = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/shipments/${id}`),
    retry: (failureCount, err) => {
      if (failureCount >= 2) return false;
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
      return true;
    },
    onMutate: async (id: string) => {
      setDeleteErrors((prev) => {
        if (!(id in prev)) return prev;
        const { [id]: _removed, ...rest } = prev;
        return rest;
      });
      await queryClient.cancelQueries({ queryKey: ['shipments'] });
      const snapshots = queryClient.getQueriesData<List>({ queryKey: ['shipments'] });
      queryClient.setQueriesData<List>({ queryKey: ['shipments'] }, (old) => {
        if (!old || !Array.isArray(old.items)) return old;
        return { ...old, items: old.items.filter((x) => x.id !== id) };
      });
      message.success('Отгрузка удалена');
      return { snapshots };
    },
    onError: (err: Error, id, ctx) => {
      const snapshots = (ctx as { snapshots?: Array<[readonly unknown[], List | undefined]> } | undefined)
        ?.snapshots;
      if (snapshots) {
        for (const [key, value] of snapshots) {
          queryClient.setQueryData(key, value);
        }
      }
      setDeleteErrors((prev) => ({ ...prev, [id]: err.message }));
      message.error(err.message);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['shipments'] });
      void queryClient.invalidateQueries({ queryKey: ['source-documents'] });
    },
  });

  const counterpartiesMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of counterpartiesQuery.data?.items ?? []) m.set(c.id, c.name);
    return m;
  }, [counterpartiesQuery.data]);
  const sitesMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sitesQuery.data?.items ?? []) m.set(s.id, `${s.code} · ${s.name}`);
    return m;
  }, [sitesQuery.data]);
  const sourceDocsById = useMemo(() => {
    const m = new Map<string, SourceRow>();
    for (const s of sourceDocsQuery.data?.items ?? []) m.set(s.id, s);
    return m;
  }, [sourceDocsQuery.data]);

  const destinationLabel = (r: Shipment): string => {
    if (r.kind === 'contractor' || r.kind === 'return') {
      return r.receiverCounterpartyId
        ? counterpartiesMap.get(r.receiverCounterpartyId) ?? '—'
        : '—';
    }
    if (r.kind === 'transfer') {
      return r.destSiteId ? sitesMap.get(r.destSiteId) ?? '—' : '—';
    }
    return 'Списание';
  };
  // Подрядчик/Поставщик — это получатель груза для contractor/return; для transfer/writeoff
  // получателя как контрагента нет — пусто.
  const renderCounterpartyCol = (r: Row) => {
    if (r.kind !== 'contractor' && r.kind !== 'return') return '—';
    return r.receiverCounterpartyId
      ? counterpartiesMap.get(r.receiverCounterpartyId) ?? '—'
      : '—';
  };
  const resolveDocNumber = (r: Row): string | null => {
    const sd = r.sourceDocumentIds[0] ? sourceDocsById.get(r.sourceDocumentIds[0]) : null;
    return sd?.docNumber ?? null;
  };

  const items = list.data?.items ?? [];

  const statusOptions = useMemo(() => {
    const seen = new Map<string, { label: string }>();
    for (const r of items) {
      if (!seen.has(r.status.code)) seen.set(r.status.code, { label: r.status.label });
    }
    return Array.from(seen.entries()).map(([code, v]) => ({ value: code, label: v.label }));
  }, [items]);

  const filteredItems = useMemo(() => {
    return items.filter((r) => {
      // Для отгрузки «подрядчик» и «поставщик» — это receiverCounterpartyId с учётом kind.
      if (filters.contractorId && r.receiverCounterpartyId !== filters.contractorId) {
        return false;
      }
      if (filters.supplierId && r.receiverCounterpartyId !== filters.supplierId) {
        return false;
      }
      if (filters.siteId && r.siteId !== filters.siteId) return false;
      if (filters.status && r.status.code !== filters.status) return false;
      if (filters.plate.trim() && !matchText(r.vehiclePlate, filters.plate)) return false;
      if (filters.q.trim()) {
        const docNum = resolveDocNumber(r);
        if (!matchText(docNum, filters.q)) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    items,
    sourceDocsById,
    filters.contractorId,
    filters.supplierId,
    filters.siteId,
    filters.status,
    filters.plate,
    filters.q,
  ]);

  const renderDeleteButton = (r: Row) => {
    const errMsg = deleteErrors[r.id];
    return (
      <Space size={4} onClick={(e) => e.stopPropagation()}>
        {errMsg && (
          <Tooltip title={errMsg}>
            <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />
          </Tooltip>
        )}
        <Popconfirm
          title="Удалить отгрузку?"
          description="Запись, фото и связи с документами будут удалены."
          okText="Да, удалить"
          cancelText="Нет"
          okButtonProps={{ danger: true }}
          onConfirm={() => del.mutate(r.id)}
        >
          <Button danger size="small" shape="circle" icon={<DeleteOutlined />} />
        </Popconfirm>
      </Space>
    );
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <ListFilters
        value={filters}
        onChange={updateFilters}
        fields={['contractor', 'supplier', 'site', 'q']}
        counterparties={counterpartiesQuery.data?.items ?? []}
        sites={sitesQuery.data?.items ?? []}
        loading={counterpartiesQuery.isLoading || sitesQuery.isLoading}
        searchPlaceholder="Номер документа"
        extra={
          <>
            <Select<string>
              style={{ width: SELECT_WIDTH }}
              placeholder="Статус"
              value={filters.status ?? undefined}
              onChange={(v) => updateFilters({ status: v ?? null })}
              allowClear
              options={statusOptions}
            />
            <Input.Search
              style={{ width: 180 }}
              placeholder="Номер авто"
              value={filters.plate}
              allowClear
              onChange={(e) => updateFilters({ plate: e.target.value })}
            />
          </>
        }
      />
      <ResponsiveTable<Row>
        items={filteredItems}
        loading={list.isLoading}
        rowKey="id"
        onRowClick={(r) => onOpen(r.id)}
        emptyText="Нет отгрузок"
        columns={[
          {
            title: 'Статус',
            key: 'status',
            render: (_: unknown, r: Row) => (
              <Tag color={r.status.color ?? 'default'}>{r.status.label}</Tag>
            ),
          },
          {
            title: 'Вид',
            key: 'kind',
            render: (_: unknown, r: Row) => (
              <Tag color={KIND_LABELS[r.kind].color}>{KIND_LABELS[r.kind].label}</Tag>
            ),
          },
          {
            title: 'Откуда',
            key: 'site',
            render: (_: unknown, r: Row) => sitesMap.get(r.siteId) ?? '—',
          },
          {
            title: 'Куда',
            key: 'dest',
            render: (_: unknown, r: Row) => destinationLabel(r),
          },
          {
            title: 'Подрядчик/Поставщик',
            key: 'counterparty',
            render: (_: unknown, r: Row) => renderCounterpartyCol(r),
          },
          { title: 'Авто', dataIndex: 'vehiclePlate' },
          { title: 'Отгружено', dataIndex: 'shippedAt' },
          {
            title: 'Кол-во',
            key: 'itemsCount',
            render: (_: unknown, r: Row) => r.items?.length ?? 0,
          },
          {
            title: '',
            key: 'actions',
            width: 56,
            align: 'right' as const,
            onCell: () => ({
              onClick: (e: MouseEvent) => e.stopPropagation(),
            }),
            render: (_: unknown, r: Row) => renderDeleteButton(r),
          },
        ]}
        cardRender={(r) => (
          <Card style={{ width: '100%' }} size="small">
            <Space direction="vertical" size={4} style={{ width: '100%', position: 'relative' }}>
              <Space wrap>
                <Tag color={r.status.color ?? 'default'}>{r.status.label}</Tag>
                <Tag color={KIND_LABELS[r.kind].color}>{KIND_LABELS[r.kind].label}</Tag>
                <Typography.Text strong>{r.vehiclePlate ?? 'Без номера'}</Typography.Text>
              </Space>
              <Typography.Text type="secondary">
                {sitesMap.get(r.siteId) ?? '—'} → {destinationLabel(r)}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {renderCounterpartyCol(r)}
              </Typography.Text>
              <Typography.Text type="secondary">
                {r.shippedAt ?? '—'} · {r.items?.length ?? 0} стр.
              </Typography.Text>
              <div
                style={{ position: 'absolute', top: 0, right: 0 }}
                onClick={(e) => e.stopPropagation()}
              >
                {renderDeleteButton(r)}
              </div>
            </Space>
          </Card>
        )}
      />
    </Space>
  );
}
