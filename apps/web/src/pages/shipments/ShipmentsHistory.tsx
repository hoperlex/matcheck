import type { MouseEvent } from 'react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button,
  Card,
  Input,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, ExclamationCircleOutlined, UndoOutlined } from '@ant-design/icons';
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
import {
  hardDeleteShipment,
  markDeletion,
  unmarkDeletion,
} from '../../services/shipments';
import { useAuthStore } from '../../stores/auth';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { ListFilters, type ListFiltersValue } from '../../shared/ui/ListFilters';
import { PendingDeletionTag } from '../../shared/ui/PendingDeletionTag';
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
// Статусы, для которых вместо hard-delete показываем «Пометить на удаление».
const SOFT_DELETE_STATUSES = new Set(['filled', 'confirmed_mol']);

export function ShipmentsHistory({ onOpen }: { onOpen: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [reasonDraft, setReasonDraft] = useState<Record<string, string>>({});
  const [params, setParams] = useSearchParams();
  const authUser = useAuthStore((s) => s.user);
  const isAdmin = authUser?.role === 'admin';

  // Две вкладки: «Активные» (включая отгрузки без УПД) и «Корзина».
  // URL: trash=1 — корзина. Поиск «Без документа» доступен через
  // селект «Статус» как псевдо-значение no_document.
  type View = 'active' | 'trash';
  const view: View = params.get('trash') === '1' ? 'trash' : 'active';
  const isTrash = view === 'trash';

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

  const setView = (next: View) => {
    const params2 = new URLSearchParams(params);
    params2.delete('trash');
    params2.delete('view');
    if (next === 'trash') params2.set('trash', '1');
    setParams(params2, { replace: true });
  };

  const list = useQuery({
    queryKey: ['shipments', view],
    queryFn: () =>
      api.get<List>(view === 'trash' ? '/shipments?trash=1' : '/shipments'),
  });

  const counterpartiesQuery = useQuery({
    queryKey: ['counterparties', 'all'],
    queryFn: () => api.get<{ items: Counterparty[]; total: number }>('/counterparties?limit=500'),
  });
  const sitesQuery = useQuery({
    queryKey: ['sites', 'all'],
    queryFn: () => api.get<{ items: Site[]; total: number }>('/sites?limit=500'),
  });
  const sourceDocsQuery = useQuery({
    queryKey: ['source-documents', 'all', 'outbound'],
    queryFn: () =>
      api.get<SourceList>('/source-documents?direction=outbound&limit=1000'),
  });

  const clearErr = (id: string) => {
    setDeleteErrors((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _removed, ...rest } = prev;
      return rest;
    });
  };

  const hardDel = useMutation({
    mutationFn: (id: string) => hardDeleteShipment(id),
    retry: (failureCount, err) => {
      if (failureCount >= 2) return false;
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
      return true;
    },
    onMutate: async (id: string) => {
      clearErr(id);
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

  const markDel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string | null }) =>
      markDeletion(id, reason),
    onMutate: async ({ id }) => {
      clearErr(id);
      await queryClient.cancelQueries({ queryKey: ['shipments', 'active'] });
      const prev = queryClient.getQueryData<List>(['shipments', 'active']);
      queryClient.setQueryData<List>(['shipments', 'active'], (old) => {
        if (!old || !Array.isArray(old.items)) return old;
        return { ...old, items: old.items.filter((x) => x.id !== id) };
      });
      message.success('Помечено на удаление');
      return { prev };
    },
    onError: (err: Error, { id }, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['shipments', 'active'], ctx.prev);
      setDeleteErrors((prev) => ({ ...prev, [id]: err.message }));
      message.error(err.message);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['shipments'] });
    },
  });

  const unmarkDel = useMutation({
    mutationFn: (id: string) => unmarkDeletion(id),
    onMutate: async (id) => {
      clearErr(id);
      await queryClient.cancelQueries({ queryKey: ['shipments', 'trash'] });
      const prev = queryClient.getQueryData<List>(['shipments', 'trash']);
      queryClient.setQueryData<List>(['shipments', 'trash'], (old) => {
        if (!old || !Array.isArray(old.items)) return old;
        return { ...old, items: old.items.filter((x) => x.id !== id) };
      });
      message.success('Пометка снята');
      return { prev };
    },
    onError: (err: Error, id, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['shipments', 'trash'], ctx.prev);
      setDeleteErrors((prev) => ({ ...prev, [id]: err.message }));
      message.error(err.message);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['shipments'] });
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

  // Опции селекта «Статус» собираем из реальных данных и добавляем
  // псевдо-опцию «Без документа» — это не код статуса в БД, а способ
  // отфильтровать отгрузки с пустым sourceDocumentIds.
  const statusOptions = useMemo(() => {
    const seen = new Map<string, { label: string }>();
    for (const r of items) {
      if (!seen.has(r.status.code)) seen.set(r.status.code, { label: r.status.label });
    }
    const opts = Array.from(seen.entries()).map(([code, v]) => ({
      value: code,
      label: v.label,
    }));
    opts.push({ value: 'no_document', label: 'Без документа' });
    return opts;
  }, [items]);

  const filteredItems = useMemo(() => {
    return items.filter((r) => {
      if (filters.contractorId && r.receiverCounterpartyId !== filters.contractorId) {
        return false;
      }
      if (filters.supplierId && r.receiverCounterpartyId !== filters.supplierId) {
        return false;
      }
      if (filters.siteId && r.siteId !== filters.siteId) return false;
      if (filters.status === 'no_document') {
        if (r.sourceDocumentIds.length !== 0) return false;
      } else if (filters.status && r.status.code !== filters.status) {
        return false;
      }
      if (filters.plate.trim() && !matchText(r.vehiclePlate, filters.plate)) return false;
      if (filters.q.trim()) {
        const docNum = resolveDocNumber(r);
        if (!matchText(docNum, filters.q)) return false;
      }
      return true;
    });
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

  const renderActions = (r: Row) => {
    const errMsg = deleteErrors[r.id];
    const errIcon = errMsg ? (
      <Tooltip title={errMsg}>
        <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />
      </Tooltip>
    ) : null;

    if (isTrash) {
      const canUnmark = isAdmin || authUser?.id === r.pendingDeletionByUserId;
      return (
        <Space size={4} onClick={(e) => e.stopPropagation()}>
          {errIcon}
          {canUnmark && (
            <Tooltip title="Восстановить">
              <Button
                size="small"
                shape="circle"
                icon={<UndoOutlined />}
                onClick={() => unmarkDel.mutate(r.id)}
              />
            </Tooltip>
          )}
          {isAdmin && (
            <Popconfirm
              title="Удалить навсегда?"
              description="Запись, фото и связи с документами будут стёрты."
              okText="Да, удалить"
              cancelText="Нет"
              okButtonProps={{ danger: true }}
              onConfirm={() => hardDel.mutate(r.id)}
            >
              <Tooltip title="Удалить навсегда">
                <Button danger size="small" shape="circle" icon={<DeleteOutlined />} />
              </Tooltip>
            </Popconfirm>
          )}
        </Space>
      );
    }

    if (SOFT_DELETE_STATUSES.has(r.status.code)) {
      return (
        <Space size={4} onClick={(e) => e.stopPropagation()}>
          {errIcon}
          <Popconfirm
            title="Пометить на удаление?"
            description={
              <Input.TextArea
                placeholder="Причина (необязательно)"
                rows={2}
                maxLength={500}
                value={reasonDraft[r.id] ?? ''}
                onChange={(e) =>
                  setReasonDraft((prev) => ({ ...prev, [r.id]: e.target.value }))
                }
              />
            }
            okText="Пометить"
            cancelText="Нет"
            onConfirm={() => {
              const reason = (reasonDraft[r.id] ?? '').trim() || null;
              markDel.mutate({ id: r.id, reason });
              setReasonDraft((prev) => {
                const { [r.id]: _removed, ...rest } = prev;
                return rest;
              });
            }}
          >
            <Tooltip title="Пометить на удаление">
              <Button danger size="small" shape="circle" icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      );
    }

    return (
      <Space size={4} onClick={(e) => e.stopPropagation()}>
        {errIcon}
        <Popconfirm
          title="Удалить отгрузку?"
          description="Запись, фото и связи с документами будут удалены."
          okText="Да, удалить"
          cancelText="Нет"
          okButtonProps={{ danger: true }}
          onConfirm={() => hardDel.mutate(r.id)}
        >
          <Button danger size="small" shape="circle" icon={<DeleteOutlined />} />
        </Popconfirm>
      </Space>
    );
  };

  const renderStatusCell = (r: Row) => (
    <Space size={4} wrap>
      <Tag color={r.status.color ?? 'default'}>{r.status.label}</Tag>
      {r.sourceDocumentIds.length === 0 && <Tag color="gold">Без документа</Tag>}
      {isTrash && (
        <PendingDeletionTag
          at={r.pendingDeletionAt}
          byEmail={r.pendingDeletionByUserEmail}
          reason={r.pendingDeletionReason}
        />
      )}
    </Space>
  );

  return (
    <StickyPageHeader
      header={
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Segmented
            value={view}
            onChange={(v) => setView(v as View)}
            options={[
              { label: 'Активные', value: 'active' },
              { label: 'Корзина', value: 'trash' },
            ]}
          />
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
        </Space>
      }
    >
      <ResponsiveTable<Row>
        items={filteredItems}
        loading={list.isLoading}
        rowKey="id"
        numbered
        onRowClick={(r) => onOpen(r.id)}
        emptyText={view === 'trash' ? 'Корзина пуста' : 'Нет отгрузок'}
        columns={[
          {
            title: 'Статус',
            key: 'status',
            render: (_: unknown, r: Row) => renderStatusCell(r),
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
            width: 88,
            align: 'right' as const,
            onCell: () => ({
              onClick: (e: MouseEvent) => e.stopPropagation(),
            }),
            render: (_: unknown, r: Row) => renderActions(r),
          },
        ]}
        cardRender={(r) => (
          <Card style={{ width: '100%' }} size="small">
            <Space direction="vertical" size={4} style={{ width: '100%', position: 'relative' }}>
              <Space wrap>
                {renderStatusCell(r)}
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
                {renderActions(r)}
              </div>
            </Space>
          </Card>
        )}
      />
    </StickyPageHeader>
  );
}
