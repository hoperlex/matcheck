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
  DeliveryListResponseSchema,
  Site,
  SourceDocumentListResponseSchema,
} from '@matcheck/contracts';
import type { z } from 'zod';
import { ApiError, api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { ListFilters, type ListFiltersValue } from '../../shared/ui/ListFilters';
import { matchText } from '../../shared/utils/matchText';

type List = z.infer<typeof DeliveryListResponseSchema>;
type Row = List['items'][number];
type SourceList = z.infer<typeof SourceDocumentListResponseSchema>;
type SourceRow = SourceList['items'][number];

const SELECT_WIDTH = 200;

export function DeliveriesHistory({ onOpen }: { onOpen: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [params, setParams] = useSearchParams();

  const filters: ListFiltersValue & { status: string | null; plate: string } = {
    contractorId: params.get('contractor'),
    supplierId: params.get('supplier'),
    siteId: params.get('site'),
    q: params.get('q') ?? '',
    status: params.get('status'),
    plate: params.get('plate') ?? '',
  };

  // Обновляем только переданные ключи. tab/delivery/from других страниц
  // не трогаем (replace: true чтобы не плодить history).
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
    queryKey: ['deliveries'],
    queryFn: () => api.get<List>('/deliveries'),
  });

  const counterpartiesQuery = useQuery({
    queryKey: ['counterparties', 'all'],
    queryFn: () =>
      api.get<{ items: Counterparty[]; total: number }>('/counterparties?limit=500'),
  });
  const sitesQuery = useQuery({
    queryKey: ['sites', 'all'],
    queryFn: () =>
      api.get<{ items: Site[]; total: number }>('/sites?activeOnly=true&limit=200'),
  });
  // Резолв docNumber и «унаследованных» из УПД contractorId/siteId.
  // Используется и для столбцов (fallback), и для серверного поиска по q.
  const sourceDocsQuery = useQuery({
    queryKey: ['source-documents', 'all', 'inbound'],
    queryFn: () =>
      api.get<SourceList>('/source-documents?direction=inbound&limit=1000'),
  });

  // Оптимистичное удаление с rollback и индикатором ошибки на строке —
  // см. эталон в apps/web/src/pages/inbox/Inbox.tsx.
  const del = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/deliveries/${id}`),
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
      await queryClient.cancelQueries({ queryKey: ['deliveries'] });
      const snapshots = queryClient.getQueriesData<List>({ queryKey: ['deliveries'] });
      queryClient.setQueriesData<List>({ queryKey: ['deliveries'] }, (old) => {
        if (!old || !Array.isArray(old.items)) return old;
        return { ...old, items: old.items.filter((x) => x.id !== id) };
      });
      message.success('Приёмка удалена');
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
      void queryClient.invalidateQueries({ queryKey: ['deliveries'] });
      void queryClient.invalidateQueries({ queryKey: ['source-documents'] });
    },
  });

  const items = list.data?.items ?? [];

  // Карта source-document → строка (для fallback contractor/site и резолва docNumber).
  const sourceDocsById = useMemo(() => {
    const m = new Map<string, SourceRow>();
    for (const s of sourceDocsQuery.data?.items ?? []) m.set(s.id, s);
    return m;
  }, [sourceDocsQuery.data]);

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

  // Для строки приёмки берём contractorId / siteId; при null fallback на первый УПД.
  // Помечаем, является ли значение «унаследованным» — UI делает его приглушённым.
  const resolveContractor = (r: Row): { id: string | null; inherited: boolean } => {
    if (r.contractorId) return { id: r.contractorId, inherited: false };
    const sd = r.sourceDocumentIds[0] ? sourceDocsById.get(r.sourceDocumentIds[0]) : null;
    return { id: sd?.contractorId ?? null, inherited: !!sd?.contractorId };
  };
  const resolveSite = (r: Row): { id: string | null; inherited: boolean } => {
    // siteId у delivery непустой (uuid), но может ссылаться на SYSTEM_SITE_ID
    // («Без объекта») — fallback не нужен, его пользователь сам сменит.
    return { id: r.siteId, inherited: false };
  };
  const resolveDocNumber = (r: Row): string | null => {
    const sd = r.sourceDocumentIds[0] ? sourceDocsById.get(r.sourceDocumentIds[0]) : null;
    return sd?.docNumber ?? null;
  };

  // Доступные статусы для фильтра — собираем из текущей выдачи.
  // Если приёмок ещё нет, селект пустой — это ожидаемо.
  const statusOptions = useMemo(() => {
    const seen = new Map<string, { label: string; color: string | null }>();
    for (const r of items) {
      if (!seen.has(r.status.code)) {
        seen.set(r.status.code, { label: r.status.label, color: r.status.color });
      }
    }
    return Array.from(seen.entries()).map(([code, v]) => ({ value: code, label: v.label }));
  }, [items]);

  const filteredItems = useMemo(() => {
    return items.filter((r) => {
      const c = resolveContractor(r);
      const s = resolveSite(r);
      if (filters.contractorId && c.id !== filters.contractorId) return false;
      if (filters.supplierId && r.supplierId !== filters.supplierId) return false;
      if (filters.siteId && s.id !== filters.siteId) return false;
      if (filters.status && r.status.code !== filters.status) return false;
      if (filters.plate.trim() && !matchText(r.vehiclePlate, filters.plate)) return false;
      if (filters.q.trim()) {
        const docNum = resolveDocNumber(r);
        if (!matchText(docNum, filters.q)) return false;
      }
      return true;
    });
    // resolve* функции зависят от sourceDocsById; список зависимостей через items + Map.
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
          title="Удалить приёмку?"
          description="Запись, фото и связи с УПД будут удалены. УПД вернётся в «Ожидаемые»."
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

  const renderContractor = (r: Row) => {
    const { id, inherited } = resolveContractor(r);
    if (!id) return '—';
    const name = counterpartiesMap.get(id) ?? '—';
    return inherited ? (
      <Typography.Text type="secondary">{name}</Typography.Text>
    ) : (
      name
    );
  };
  const renderSite = (r: Row) => {
    const { id } = resolveSite(r);
    if (!id) return '—';
    return sitesMap.get(id) ?? '—';
  };
  const supplierName = (id: string | null | undefined) =>
    id ? counterpartiesMap.get(id) ?? '—' : '—';

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
        emptyText="Нет приёмок"
        columns={[
          {
            title: 'Статус',
            key: 'status',
            render: (_: unknown, r: Row) => (
              <Tag color={r.status.color ?? 'default'}>{r.status.label}</Tag>
            ),
          },
          { title: 'Авто', dataIndex: 'vehiclePlate' },
          { title: 'Прибытие', dataIndex: 'arrivedAt' },
          {
            title: 'Поставщик',
            key: 'supplier',
            render: (_: unknown, r: Row) => supplierName(r.supplierId),
          },
          {
            title: 'Подрядчик',
            key: 'contractor',
            render: (_: unknown, r: Row) => renderContractor(r),
          },
          {
            title: 'Объект',
            key: 'site',
            render: (_: unknown, r: Row) => renderSite(r),
          },
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
            <Space
              direction="vertical"
              size={4}
              style={{ width: '100%', position: 'relative' }}
            >
              <Space>
                <Tag color={r.status.color ?? 'default'}>{r.status.label}</Tag>
                <Typography.Text strong>{r.vehiclePlate ?? 'Без номера'}</Typography.Text>
              </Space>
              <Typography.Text type="secondary">
                {supplierName(r.supplierId)} · {r.items?.length ?? 0} стр.
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {renderContractor(r)} · {renderSite(r)}
              </Typography.Text>
              <Typography.Text type="secondary">{r.arrivedAt ?? '—'}</Typography.Text>
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
