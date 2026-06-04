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
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  EyeOutlined,
  ShareAltOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BulkDeleteResponse,
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
import { PageTabs, type PageTabItem } from '../../shared/ui/PageTabs';
import { useBulkSelection } from '../../shared/ui/useBulkSelection';
import { BulkActionInline } from '../../shared/ui/BulkActionInline';
import { DebouncedSearch } from '../../shared/ui/DebouncedSearch';
import { parseCsvIds, toCsvIds } from '../../shared/utils/csvIds';
import { useSyncGlobalFilters } from '../../shared/hooks/useSyncGlobalFilters';
import { ShareLinkModal } from '../../components/ShareLinkModal';
import { ShipmentViewModal, type ShipmentViewData } from './ShipmentViewModal';
import { dateSorter, numberSorter, prioritySorter, stringSorter } from '../../shared/ui/tableSorters';
import { dateRangeColumnFilter } from '../../shared/ui/DateRangeFilter';
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

export function ShipmentsHistory({
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
  const [shareId, setShareId] = useState<string | null>(null);
  const [viewData, setViewData] = useState<ShipmentViewData | null>(null);
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
    contractorIds: parseCsvIds(params.get('contractor')),
    supplierIds: parseCsvIds(params.get('supplier')),
    siteIds: parseCsvIds(params.get('site')),
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
    if ('contractorIds' in patch) apply('contractor', toCsvIds(patch.contractorIds));
    if ('supplierIds' in patch) apply('supplier', toCsvIds(patch.supplierIds));
    if ('siteIds' in patch) apply('site', toCsvIds(patch.siteIds));
    if ('q' in patch) apply('q', patch.q);
    if ('status' in patch) apply('status', patch.status);
    if ('plate' in patch) apply('plate', patch.plate);
    setParams(next, { replace: true });
  };

  // «Липкие» фильтры между разделами — см. useSyncGlobalFilters.
  useSyncGlobalFilters({
    current: {
      contractorIds: filters.contractorIds,
      supplierIds: filters.supplierIds,
      siteIds: filters.siteIds,
    },
    apply: (next) =>
      updateFilters({
        contractorIds: next.contractorIds,
        supplierIds: next.supplierIds,
        siteIds: next.siteIds,
      }),
  });

  // setView был выпилен — переключатель «Удалённые» теперь живёт в шапке
  // ShipmentPage. Здесь читаем только URL для запроса /shipments?trash=1.

  const list = useQuery({
    queryKey: ['shipments', view],
    queryFn: () =>
      api.get<List>(view === 'trash' ? '/shipments?trash=1' : '/shipments'),
    placeholderData: keepPreviousData,
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
      void queryClient.invalidateQueries({ queryKey: ['reports', 'operations-counters'] });
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
      void queryClient.invalidateQueries({ queryKey: ['reports', 'operations-counters'] });
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
      void queryClient.invalidateQueries({ queryKey: ['reports', 'operations-counters'] });
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

  // Массовый выбор + три bulk-мутации. Набор кнопок в bulk-bar
  // переключается по isTrash, как в DeliveriesHistory.
  const bulk = useBulkSelection<Row>((r) => r.id);
  const handleBulkSuccess = (res: BulkDeleteResponse, okMsg: string) => {
    bulk.clear();
    if (res.deleted.length > 0) message.success(`${okMsg}: ${res.deleted.length}`);
    if (res.skipped.length > 0) {
      message.warning(`Пропущено ${res.skipped.length}: ${bulkSkipMessage(res.skipped)}`);
    }
    void queryClient.invalidateQueries({ queryKey: ['shipments'] });
  };
  const bulkMark = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<BulkDeleteResponse>('/shipments/bulk-mark-deletion', { ids }),
    onSuccess: (res) => handleBulkSuccess(res, 'Помечено на удаление'),
    onError: (err: Error) => message.error(err.message),
  });
  const bulkUnmark = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<BulkDeleteResponse>('/shipments/bulk-unmark-deletion', { ids }),
    onSuccess: (res) => handleBulkSuccess(res, 'Восстановлено'),
    onError: (err: Error) => message.error(err.message),
  });
  const bulkHard = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<BulkDeleteResponse>('/shipments/bulk-hard-delete', { ids }),
    onSuccess: (res) => handleBulkSuccess(res, 'Удалено навсегда'),
    onError: (err: Error) => message.error(err.message),
  });

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
      if (filters.contractorIds.length > 0 && (!r.receiverCounterpartyId || !filters.contractorIds.includes(r.receiverCounterpartyId))) {
        return false;
      }
      if (filters.supplierIds.length > 0 && (!r.receiverCounterpartyId || !filters.supplierIds.includes(r.receiverCounterpartyId))) {
        return false;
      }
      if (filters.siteIds.length > 0 && (!r.siteId || !filters.siteIds.includes(r.siteId))) return false;
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
    filters.contractorIds,
    filters.supplierIds,
    filters.siteIds,
    filters.status,
    filters.plate,
    filters.q,
  ]);

  // Иконка «Поделиться» — показывается всегда, даже в корзине, чтобы
  // можно было создать публичную ссылку и без перехода в edit-режим.
  const shareIcon = (r: Row) => (
    <Tooltip title="Поделиться ссылкой">
      <Button
        size="small"
        shape="circle"
        icon={<ShareAltOutlined />}
        onClick={() => setShareId(r.id)}
      />
    </Tooltip>
  );

  // Снимок для read-only ShipmentViewModal: подставляем имена получателя
  // (counterparty/destSite в зависимости от kind), объекта и краткие
  // метаданные привязанного УПД. Модалка сама не лезет в API.
  const buildViewData = (r: Row): ShipmentViewData => {
    const receiverName =
      r.receiverCounterpartyId
        ? counterpartiesMap.get(r.receiverCounterpartyId) ?? null
        : null;
    const destSiteName = r.destSiteId ? sitesMap.get(r.destSiteId) ?? null : null;
    const sd = r.sourceDocumentIds[0] ? sourceDocsById.get(r.sourceDocumentIds[0]) : null;
    const kindLabel = sd
      ? sd.kind === 'upd'
        ? 'УПД'
        : sd.kind === 'transport_waybill' || sd.kind === 'os2_transfer'
          ? 'Накладная'
          : sd.kind === 'request'
            ? 'Заявка'
            : null
      : null;
    const totalSum =
      sd?.totalSum != null && sd.totalSum !== '' && Number.isFinite(Number(sd.totalSum))
        ? Number(sd.totalSum)
        : null;
    return {
      shipment: r,
      receiverName,
      siteName: sitesMap.get(r.siteId) ?? null,
      destSiteName,
      docNumber: sd?.docNumber ?? null,
      docKindLabel: kindLabel,
      docTotalSum: totalSum,
    };
  };

  // 👁 Просмотр + ✏ Редактор — слева от Поделиться/Удалить. Зеркало
  // DeliveriesHistory.renderViewEdit: клик по строке открывает edit как
  // раньше, иконки — дополнительные пути.
  const renderViewEdit = (r: Row) => (
    <>
      <Tooltip title="Просмотр">
        <Button
          size="small"
          shape="circle"
          icon={<EyeOutlined />}
          onClick={() => setViewData(buildViewData(r))}
        />
      </Tooltip>
      <Tooltip title="Редактировать">
        <Button
          size="small"
          shape="circle"
          icon={<EditOutlined />}
          onClick={() => onOpen(r.id)}
        />
      </Tooltip>
    </>
  );

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
          {shareIcon(r)}
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
          {shareIcon(r)}
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
    <>
    <StickyPageHeader
      header={
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          {/* Переключатель «Удалённые» теперь живёт в шапке ShipmentPage
              рядом с Title (читается через URL ?trash=1) — это даёт
              постоянное место наверху и убирает «прыжок» контента при
              переключении вкладок Ожидаемые/Принятые. */}
          <ListFilters
            value={filters}
            onChange={updateFilters}
            fields={['contractor', 'supplier', 'site', 'q']}
            counterparties={counterpartiesQuery.data?.items ?? []}
            sites={sitesQuery.data?.items ?? []}
            loading={counterpartiesQuery.isLoading || sitesQuery.isLoading}
            searchPlaceholder="Номер документа"
            // Инпуты «Статус» и «Номер авто» убраны по UX-запросу: единый
            // набор фильтров с вкладкой «Ожидаемые» (Подрядчик/Поставщик/
            // Объект/Номер документа). Старый ?status=/?plate= в URL
            // продолжает фильтровать, но UI его не выставляет.
            extra={filtersExtra}
          />
          {tabs && activeTab && onTabChange && (
            <PageTabs
              items={tabs}
              activeKey={activeTab}
              onChange={onTabChange}
              extra={
                bulk.hasSelection ? (
                  isTrash ? (
                    <Space size={8}>
                      <Typography.Text type="secondary">
                        Выбрано: <b>{bulk.selectedCount}</b>
                      </Typography.Text>
                      <Popconfirm
                        title={`Восстановить ${bulk.selectedCount} ${pluralizeShipment(bulk.selectedCount)}?`}
                        okText="Восстановить"
                        cancelText="Отмена"
                        onConfirm={() =>
                          bulkUnmark.mutate(Array.from(bulk.selectedIds))
                        }
                        placement="bottomRight"
                      >
                        <Button icon={<UndoOutlined />} loading={bulkUnmark.isPending}>
                          Восстановить выбранные
                        </Button>
                      </Popconfirm>
                      {isAdmin && (
                        <Popconfirm
                          title={`Удалить ${bulk.selectedCount} ${pluralizeShipment(bulk.selectedCount)} навсегда?`}
                          description="Восстановить будет невозможно."
                          okText="Удалить"
                          cancelText="Отмена"
                          okButtonProps={{ danger: true, loading: bulkHard.isPending }}
                          onConfirm={() =>
                            bulkHard.mutate(Array.from(bulk.selectedIds))
                          }
                          placement="bottomRight"
                        >
                          <Button danger icon={<DeleteOutlined />} loading={bulkHard.isPending}>
                            Удалить навсегда
                          </Button>
                        </Popconfirm>
                      )}
                      <Button onClick={bulk.clear} disabled={bulkUnmark.isPending || bulkHard.isPending}>
                        Снять выбор
                      </Button>
                    </Space>
                  ) : (
                    <BulkActionInline
                      selectedCount={bulk.selectedCount}
                      onClear={bulk.clear}
                      onDelete={() => bulkMark.mutate(Array.from(bulk.selectedIds))}
                      deleting={bulkMark.isPending}
                      confirmTitle={`Пометить ${bulk.selectedCount} ${pluralizeShipment(bulk.selectedCount)} на удаление?`}
                    />
                  )
                ) : null
              }
            />
          )}
        </Space>
      }
    >
      <ResponsiveTable<Row>
        items={filteredItems}
        loading={list.isLoading}
        rowKey="id"
        numbered
        rowSelection={isAdmin || !isTrash ? bulk.selection : undefined}
        onRowClick={(r) => onOpen(r.id)}
        emptyText={view === 'trash' ? 'Корзина пуста' : 'Нет отгрузок'}
        columns={[
          {
            title: 'Статус',
            key: 'status',
            sorter: prioritySorter<Row, string>(
              (r) => r.status.code,
              ['draft', 'not_filled', 'filled', 'confirmed_mol', 'shipped', 'archived'],
            ),
            render: (_: unknown, r: Row) => renderStatusCell(r),
          },
          {
            title: 'Вид',
            key: 'kind',
            sorter: stringSorter<Row>((r) => KIND_LABELS[r.kind].label),
            render: (_: unknown, r: Row) => (
              <Tag color={KIND_LABELS[r.kind].color}>{KIND_LABELS[r.kind].label}</Tag>
            ),
          },
          {
            title: 'Откуда',
            key: 'site',
            sorter: stringSorter<Row>((r) => sitesMap.get(r.siteId) ?? null),
            render: (_: unknown, r: Row) => sitesMap.get(r.siteId) ?? '—',
          },
          {
            title: 'Куда',
            key: 'dest',
            sorter: stringSorter<Row>((r) => destinationLabel(r)),
            render: (_: unknown, r: Row) => destinationLabel(r),
          },
          {
            title: 'Подрядчик/Поставщик',
            key: 'counterparty',
            sorter: stringSorter<Row>((r) => {
              const cp = r.receiverCounterpartyId
                ? counterpartiesMap.get(r.receiverCounterpartyId)
                : null;
              return cp ?? null;
            }),
            render: (_: unknown, r: Row) => renderCounterpartyCol(r),
          },
          {
            title: 'Авто',
            dataIndex: 'vehiclePlate',
            sorter: stringSorter<Row>((r) => r.vehiclePlate),
          },
          {
            title: 'Отгружено',
            dataIndex: 'shippedAt',
            // defaultSortOrder убран: иначе при каждой перемонтировке
            // сортировка возвращалась принудительно. Сервер отдаёт
            // /shipments по updated_at desc — свежие сверху и без явной
            // сортировки.
            sorter: dateSorter<Row>((r) => r.shippedAt),
            ...dateRangeColumnFilter<Row>((r) => r.shippedAt),
          },
          {
            title: 'Кол-во',
            key: 'itemsCount',
            sorter: numberSorter<Row>((r) => r.items?.length ?? 0),
            render: (_: unknown, r: Row) => r.items?.length ?? 0,
          },
          {
            title: 'Действия',
            key: 'actions',
            width: 200,
            align: 'right' as const,
            onCell: () => ({
              onClick: (e: MouseEvent) => e.stopPropagation(),
            }),
            render: (_: unknown, r: Row) => (
              <Space size={4}>
                {renderViewEdit(r)}
                {renderActions(r)}
              </Space>
            ),
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
                <Space size={4}>
                  {renderViewEdit(r)}
                  {renderActions(r)}
                </Space>
              </div>
            </Space>
          </Card>
        )}
      />
    </StickyPageHeader>
    <ShareLinkModal
      entityType="shipment"
      entityId={shareId}
      open={shareId !== null}
      onClose={() => setShareId(null)}
      title="Поделиться отгрузкой"
    />
    <ShipmentViewModal
      data={viewData}
      open={viewData !== null}
      onClose={() => setViewData(null)}
      onEdit={() => {
        if (!viewData) return;
        const id = viewData.shipment.id;
        setViewData(null);
        onOpen(id);
      }}
    />
    </>
  );
}

// Склонение «отгрузка»: 1 отгрузку / 2-4 отгрузки / 5+ отгрузок.
function pluralizeShipment(n: number): string {
  const last = n % 10;
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'отгрузок';
  if (last === 1) return 'отгрузку';
  if (last >= 2 && last <= 4) return 'отгрузки';
  return 'отгрузок';
}

function bulkSkipMessage(skipped: BulkDeleteResponse['skipped']): string {
  const counts = new Map<string, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  const labels: Record<string, string> = {
    not_found: 'не найдены',
    already_pending: 'уже на удалении',
    not_pending: 'не помечены на удаление',
    wrong_status: 'статус не позволяет',
    must_mark_first: 'нужно сначала пометить',
    forbidden: 'нет прав',
    has_references: 'есть привязки',
    system_readonly: 'системные записи',
    internal_error: 'другая ошибка',
  };
  return Array.from(counts.entries())
    .map(([reason, n]) => `${n} — ${labels[reason] ?? reason}`)
    .join('; ');
}
