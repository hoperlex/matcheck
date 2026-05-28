import type { MouseEvent, ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button,
  Card,
  Input,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, ExclamationCircleOutlined, UndoOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Counterparty,
  DeliveryListResponseSchema,
  Site,
  SourceDocumentListResponseSchema,
} from '@matcheck/contracts';
import type { z } from 'zod';
import { ApiError, api } from '../../services/api';
import {
  hardDeleteDelivery,
  markDeletion,
  unmarkDeletion,
} from '../../services/deliveries';
import { useAuthStore } from '../../stores/auth';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { ListFilters, type ListFiltersValue } from '../../shared/ui/ListFilters';
import { PageTabs, type PageTabItem } from '../../shared/ui/PageTabs';
import { PendingDeletionTag } from '../../shared/ui/PendingDeletionTag';
import { matchText } from '../../shared/utils/matchText';

type List = z.infer<typeof DeliveryListResponseSchema>;
type Row = List['items'][number];
type SourceList = z.infer<typeof SourceDocumentListResponseSchema>;
type SourceRow = SourceList['items'][number];

const SELECT_WIDTH = 200;
// Статусы, для которых вместо hard-delete показываем «Пометить на удаление».
const SOFT_DELETE_STATUSES = new Set(['filled', 'confirmed_mol']);

const ARRIVAL_DATE_FMT = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatArrival(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return ARRIVAL_DATE_FMT.format(d).replace(',', '');
}

// Σ qty × price по позициям, где price задан. Если ни у одной позиции нет
// цены — возвращаем null, чтобы UI показал «—», а не нолик.
function deliveryItemsTotal(items: Row['items'] | undefined): number | null {
  if (!items?.length) return null;
  let sum = 0;
  let hasAny = false;
  for (const it of items) {
    const price = it.price !== null && it.price !== '' ? Number(it.price) : null;
    if (price === null || !Number.isFinite(price)) continue;
    const qtyRaw = it.qtyActual ?? it.qtyPlanned;
    const qty = qtyRaw !== null && qtyRaw !== '' ? Number(qtyRaw) : null;
    if (qty === null || !Number.isFinite(qty)) continue;
    sum += qty * price;
    hasAny = true;
  }
  return hasAny ? sum : null;
}

function deliveryItemsVatSum(items: Row['items'] | undefined): number | null {
  if (!items?.length) return null;
  let sum = 0;
  let hasAny = false;
  for (const it of items) {
    if (it.vatSum === null || it.vatSum === '') continue;
    const v = Number(it.vatSum);
    if (!Number.isFinite(v)) continue;
    sum += v;
    hasAny = true;
  }
  return hasAny ? sum : null;
}

function formatMoney(n: number | null): string {
  return n === null ? '—' : n.toFixed(2);
}

export function DeliveriesHistory({
  onOpen,
  tabs,
  activeTab,
  onTabChange,
  filtersExtra,
}: {
  onOpen: (id: string) => void;
  tabs?: PageTabItem[];
  activeTab?: string;
  onTabChange?: (key: string) => void;
  filtersExtra?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [reasonDraft, setReasonDraft] = useState<Record<string, string>>({});
  const [params, setParams] = useSearchParams();
  const authUser = useAuthStore((s) => s.user);
  const isAdmin = authUser?.role === 'admin';

  // Две вкладки: «Активные» (включая приёмки без УПД) и «Корзина».
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
    queryKey: ['deliveries', view],
    queryFn: () =>
      api.get<List>(view === 'trash' ? '/deliveries?trash=1' : '/deliveries'),
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
  const sourceDocsQuery = useQuery({
    queryKey: ['source-documents', 'all', 'inbound'],
    queryFn: () =>
      api.get<SourceList>('/source-documents?direction=inbound&limit=1000'),
  });

  const clearErr = (id: string) => {
    setDeleteErrors((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _removed, ...rest } = prev;
      return rest;
    });
  };

  // Окончательное удаление: оптимистично убираем строку из активного списка (для draft/not_filled)
  // или из корзины (для уже помеченных). Откат — при ошибке.
  const hardDel = useMutation({
    mutationFn: (id: string) => hardDeleteDelivery(id),
    retry: (failureCount, err) => {
      if (failureCount >= 2) return false;
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
      return true;
    },
    onMutate: async (id: string) => {
      clearErr(id);
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

  // Пометить на удаление: на активной вкладке убираем строку (она «уехала» в корзину),
  // полную инвалидизацию делаем в onSettled.
  const markDel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string | null }) =>
      markDeletion(id, reason),
    onMutate: async ({ id }) => {
      clearErr(id);
      await queryClient.cancelQueries({ queryKey: ['deliveries', 'active'] });
      const prev = queryClient.getQueryData<List>(['deliveries', 'active']);
      queryClient.setQueryData<List>(['deliveries', 'active'], (old) => {
        if (!old || !Array.isArray(old.items)) return old;
        return { ...old, items: old.items.filter((x) => x.id !== id) };
      });
      message.success('Помечено на удаление');
      return { prev };
    },
    onError: (err: Error, { id }, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['deliveries', 'active'], ctx.prev);
      setDeleteErrors((prev) => ({ ...prev, [id]: err.message }));
      message.error(err.message);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['deliveries'] });
    },
  });

  // Восстановить: из корзины убираем строку, активная вкладка дополнит её при invalidate.
  const unmarkDel = useMutation({
    mutationFn: (id: string) => unmarkDeletion(id),
    onMutate: async (id) => {
      clearErr(id);
      await queryClient.cancelQueries({ queryKey: ['deliveries', 'trash'] });
      const prev = queryClient.getQueryData<List>(['deliveries', 'trash']);
      queryClient.setQueryData<List>(['deliveries', 'trash'], (old) => {
        if (!old || !Array.isArray(old.items)) return old;
        return { ...old, items: old.items.filter((x) => x.id !== id) };
      });
      message.success('Пометка снята');
      return { prev };
    },
    onError: (err: Error, id, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['deliveries', 'trash'], ctx.prev);
      setDeleteErrors((prev) => ({ ...prev, [id]: err.message }));
      message.error(err.message);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['deliveries'] });
    },
  });

  const items = list.data?.items ?? [];

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

  const resolveContractor = (r: Row): { id: string | null; inherited: boolean } => {
    if (r.contractorId) return { id: r.contractorId, inherited: false };
    const sd = r.sourceDocumentIds[0] ? sourceDocsById.get(r.sourceDocumentIds[0]) : null;
    return { id: sd?.contractorId ?? null, inherited: !!sd?.contractorId };
  };
  const resolveSite = (r: Row): { id: string | null; inherited: boolean } => {
    return { id: r.siteId, inherited: false };
  };
  const resolveDocNumber = (r: Row): string | null => {
    const sd = r.sourceDocumentIds[0] ? sourceDocsById.get(r.sourceDocumentIds[0]) : null;
    return sd?.docNumber ?? null;
  };

  // Опции селекта «Статус» собираем из реальных данных и добавляем
  // псевдо-опцию «Без документа» — это не код статуса в БД, а способ
  // отфильтровать приёмки с пустым sourceDocumentIds.
  const statusOptions = useMemo(() => {
    const seen = new Map<string, { label: string; color: string | null }>();
    for (const r of items) {
      if (!seen.has(r.status.code)) {
        seen.set(r.status.code, { label: r.status.label, color: r.status.color });
      }
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
      const c = resolveContractor(r);
      const s = resolveSite(r);
      if (filters.contractorId && c.id !== filters.contractorId) return false;
      if (filters.supplierId && r.supplierId !== filters.supplierId) return false;
      if (filters.siteId && s.id !== filters.siteId) return false;
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

  // Возвращает блок кнопок действий в зависимости от вкладки, статуса и прав.
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
              description="Запись, фото и связи с УПД будут стёрты. УПД вернётся в «Ожидаемые»."
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

    // Активная вкладка.
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

    // draft / not_filled — старое поведение hard-delete.
    return (
      <Space size={4} onClick={(e) => e.stopPropagation()}>
        {errIcon}
        <Popconfirm
          title="Удалить приёмку?"
          description="Запись, фото и связи с УПД будут удалены. УПД вернётся в «Ожидаемые»."
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
    <StickyPageHeader
      header={
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Space align="center">
            <Typography.Text strong>Активные</Typography.Text>
            <Space size={6} align="center" style={{ marginLeft: 24 }}>
              <Switch
                checked={view === 'trash'}
                onChange={(checked) => setView(checked ? 'trash' : 'active')}
              />
              <Typography.Text type={view === 'trash' ? undefined : 'secondary'}>
                Удалённые
              </Typography.Text>
            </Space>
          </Space>
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
                {filtersExtra}
              </>
            }
          />
          {tabs && activeTab && onTabChange && (
            <PageTabs items={tabs} activeKey={activeTab} onChange={onTabChange} />
          )}
        </Space>
      }
    >
      <ResponsiveTable<Row>
        items={filteredItems}
        loading={list.isLoading}
        rowKey="id"
        numbered
        onRowClick={(r) => onOpen(r.id)}
        emptyText={view === 'trash' ? 'Корзина пуста' : 'Нет приёмок'}
        columns={[
          {
            title: 'Статус',
            key: 'status',
            render: (_: unknown, r: Row) => renderStatusCell(r),
          },
          { title: 'Авто', dataIndex: 'vehiclePlate' },
          {
            title: 'Прибытие',
            dataIndex: 'arrivedAt',
            render: (v: string | null) => formatArrival(v),
          },
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
            title: 'Фото',
            key: 'photos',
            width: 80,
            // Суммарное количество фото обоих этапов (stage='before' + 'after').
            // r.photos уже агрегирован сервером — отдельно по stage не считаем.
            render: (_: unknown, r: Row) => r.photos?.length ?? 0,
          },
          {
            title: 'Сумма НДС',
            key: 'vatSum',
            width: 120,
            render: (_: unknown, r: Row) => formatMoney(deliveryItemsVatSum(r.items)),
          },
          {
            title: 'Сумма',
            key: 'totalSum',
            width: 130,
            render: (_: unknown, r: Row) => formatMoney(deliveryItemsTotal(r.items)),
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
            <Space
              direction="vertical"
              size={4}
              style={{ width: '100%', position: 'relative' }}
            >
              <Space wrap>
                {renderStatusCell(r)}
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
                {renderActions(r)}
              </div>
            </Space>
          </Card>
        )}
      />
    </StickyPageHeader>
  );
}
