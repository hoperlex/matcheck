import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  App,
  Button,
  Card,
  Drawer,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ESTIMAT_APPROVAL_STATES,
  ESTIMAT_SOURCING_STATUSES,
  type EstimatApprovalState,
  type EstimatOrderDetail,
  type EstimatOrderEvent,
  type EstimatOrderItemsResponse,
  type EstimatOrderListItem,
  type EstimatOrderListResponse,
  type EstimatSyncRun,
  type EstimatSyncStatus,
  type EstimatSyncTriggerResponse,
  type Site,
} from '@matcheck/contracts';
import { api } from '../../services/api';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { DebouncedSearch } from '../../shared/ui/DebouncedSearch';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { formatMoneyRu } from '../../shared/utils/formatRu';
import { SupplierOrderDetails } from '../shared/SupplierOrderDetails';
import {
  APPROVAL_STATE_COLORS,
  APPROVAL_STATE_LABELS,
  approvalText,
  contractorsText,
  formatMsk,
  stageLabel,
} from '../../shared/utils/estimatOrder';

const PAGE_SIZE = 50;
/** Ширина фильтров фиксированная: панель не прыгает от выбора и загрузки опций. */
const FILTER_WIDTH = 220;

const DELETION_REASONS: Record<string, string> = {
  scope_unconfirmed: 'не удалось подтвердить доступ токена',
  scope_changed: 'доступ токена изменился во время обновления',
  invalid_rows_no_id: 'часть строк EstiMat не разобрана',
  mass_disappearance: 'пропало слишком много заказов сразу — нужна проверка',
};

const EVENT_LABELS: Record<EstimatOrderEvent['kind'], string> = {
  first_seen: 'Заказ загружен',
  approved: 'Согласован',
  approval_revoked: 'Согласование снято',
  reapproved: 'Согласован повторно',
  status_changed: 'Стадия изменилась',
  deleted: 'Удалён в EstiMat',
  restored: 'Снова есть в EstiMat',
  delivery_linked: 'Привязан к приёмке',
  delivery_unlinked: 'Отвязан от приёмки',
};

function runSummary(run: EstimatSyncRun): string {
  const seconds = run.durationMs !== null ? Math.max(1, Math.round(run.durationMs / 1000)) : null;
  return `заказов ${run.ordersSeen}${seconds !== null ? `, за ${seconds} с` : ''}`;
}

function eventText(e: EstimatOrderEvent): string {
  const base = EVENT_LABELS[e.kind];
  if (e.kind === 'status_changed') return `${base}: ${stageLabel(e.fromValue ?? '')} → ${stageLabel(e.toValue ?? '')}`;
  if (e.kind === 'approved' || e.kind === 'reapproved') return `${base} ${formatMsk(e.toValue)}`;
  if (e.kind === 'delivery_linked' || e.kind === 'delivery_unlinked') {
    const displayId = (e.details as { deliveryDisplayId?: number } | null)?.deliveryDisplayId;
    const mismatch = (e.details as { siteMismatch?: boolean } | null)?.siteMismatch;
    return `${base}${displayId ? ` ${displayId}` : ''}${mismatch ? ' (другой объект)' : ''}`;
  }
  return base;
}

/** Шапка: когда обновлялось, ошибка, доступ токена, кнопка «Обновить». */
function SyncHeader({ status, canSync }: { status: EstimatSyncStatus | undefined; canSync: boolean }) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const sync = useMutation({
    mutationFn: () => api.post<EstimatSyncTriggerResponse>('/estimat/sync'),
    onSuccess: (r) => {
      message.info(r.status === 'queued' ? 'Обновление запущено' : 'Обновление уже идёт или стоит в очереди');
      void queryClient.invalidateQueries({ queryKey: ['estimat-sync-status'] });
    },
    onError: (err: Error) => message.error(err.message),
  });
  if (!status) return null;
  const last = status.lastRun;
  const done = status.lastCompleted;
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Space wrap size="middle">
        {!status.enabled ? (
          <Typography.Text type="secondary">Синхронизация выключена: {status.reason}</Typography.Text>
        ) : status.running ? (
          <Typography.Text>Идёт обновление из EstiMat… начато {formatMsk(status.running.startedAt)}</Typography.Text>
        ) : done ? (
          <Typography.Text type="secondary">
            Обновлено {formatMsk(done.finishedAt)} (МСК): {runSummary(done)}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">Заказы ещё не загружались</Typography.Text>
        )}
        {done && (
          <Typography.Text type="secondary">
            Доступ токена: {done.tokenProjectId ? 'только один объект EstiMat' : 'все объекты'}
          </Typography.Text>
        )}
        {canSync && status.enabled && (
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={sync.isPending || !!status.running}
            onClick={() => sync.mutate()}
          >
            Обновить
          </Button>
        )}
      </Space>
      {last && last.outcome === 'error' && (
        <Alert
          type="error"
          showIcon
          message={`Последнее обновление ${formatMsk(last.startedAt)} закончилось ошибкой${last.errorCode ? ` (${last.errorCode})` : ''}`}
          description={
            <>
              {last.errorMessage}
              {last.requestId ? ` · requestId ${last.requestId}` : ''}
            </>
          }
        />
      )}
      {last && last.outcome === 'skipped' && last.errorCode === 'auth_blocked' && (
        <Alert type="error" showIcon message={last.errorMessage ?? 'Токен EstiMat отклонён — нужен новый токен'} />
      )}
      {done?.deletionSkippedReason && (
        <Alert
          type="warning"
          showIcon
          message={`Удалённые в EstiMat заказы не помечались: ${DELETION_REASONS[done.deletionSkippedReason] ?? done.deletionSkippedReason}`}
        />
      )}
    </Space>
  );
}

function OrderDrawer({ orderId, onClose }: { orderId: string | null; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ['estimat-supplier-order', orderId],
    queryFn: () => api.get<EstimatOrderDetail>(`/estimat/supplier-orders/${orderId}`),
    enabled: !!orderId,
  });
  const items = useQuery({
    queryKey: ['estimat-supplier-order-items', orderId],
    queryFn: () => api.get<EstimatOrderItemsResponse>(`/estimat/supplier-orders/${orderId}/items`),
    enabled: !!orderId,
    staleTime: 60_000,
    retry: false,
  });
  const o = detail.data;
  return (
    <Drawer open={!!orderId} onClose={onClose} width="min(900px, 96vw)" title={o ? `Заказ ${o.number}` : 'Заказ'}>
      {detail.isError && <Alert type="error" showIcon message="Не удалось загрузить заказ" />}
      {o && (
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <SupplierOrderDetails order={o} items={items} />
          <div>
            <Typography.Title level={5}>Журнал</Typography.Title>
            <Space direction="vertical" size={2}>
              {o.events.map((e) => (
                <Typography.Text key={e.id}>
                  <Typography.Text type="secondary">{formatMsk(e.createdAt)}</Typography.Text> {eventText(e)}
                  {e.userEmail ? ` · ${e.userEmail}` : ''}
                </Typography.Text>
              ))}
            </Space>
          </div>
        </Space>
      )}
    </Drawer>
  );
}

/**
 * Справочники → «Заказы»: заказы поставщикам из EstiMat (только чтение).
 * Все фильтры и сортировка — на сервере, состояние фильтров — в адресе.
 */
export default function SupplierOrders() {
  const { hasCapability } = usePermissions();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);

  const q = params.get('q') ?? '';
  const siteId = params.get('site') ?? undefined;
  const status = params.get('status') ?? undefined;
  const approvalRaw = params.get('approval');
  const approval = (ESTIMAT_APPROVAL_STATES as readonly string[]).includes(approvalRaw ?? '')
    ? (approvalRaw as EstimatApprovalState)
    : undefined;
  const includeDeleted = params.get('deleted') === '1';
  const pageRaw = Number.parseInt(params.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const offset = (page - 1) * PAGE_SIZE;

  /** Любая смена фильтра сбрасывает страницу. */
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

  const syncStatus = useQuery({
    queryKey: ['estimat-sync-status'],
    queryFn: () => api.get<EstimatSyncStatus>('/estimat/sync-status'),
    // Пока обход идёт — часто, иначе раз в минуту: обход по расписанию тоже
    // должен отразиться без перезагрузки страницы.
    refetchInterval: (query) => (query.state.data?.running ? 5000 : 60_000),
  });
  const sites = useQuery({
    queryKey: ['sites', { activeOnly: true, limit: 200 }],
    queryFn: () => api.get<{ items: Site[]; total: number }>('/sites?activeOnly=true&limit=200'),
  });

  const listParams = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (q) listParams.set('q', q);
  if (siteId) listParams.set('siteId', siteId);
  if (status) listParams.set('status', status);
  if (approval) listParams.set('approval', approval);
  if (includeDeleted) listParams.set('includeDeleted', 'true');
  const list = useQuery({
    queryKey: ['estimat-supplier-orders', listParams.toString()],
    queryFn: () => api.get<EstimatOrderListResponse>(`/estimat/supplier-orders?${listParams.toString()}`),
  });

  // Закончился обход (по кнопке или по расписанию) — перечитать список и карточку.
  const lastCompletedAt = syncStatus.data?.lastCompleted?.finishedAt ?? null;
  const seenCompletedAt = useRef(lastCompletedAt);
  useEffect(() => {
    if (lastCompletedAt && seenCompletedAt.current && lastCompletedAt !== seenCompletedAt.current) {
      void queryClient.invalidateQueries({ queryKey: ['estimat-supplier-orders'] });
      void queryClient.invalidateQueries({ queryKey: ['estimat-supplier-order'] });
    }
    seenCompletedAt.current = lastCompletedAt;
  }, [lastCompletedAt, queryClient]);

  const items = list.data?.items ?? [];
  return (
    <StickyPageHeader
      header={
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space align="baseline" wrap>
            <Typography.Title level={3} style={{ margin: 0 }}>
              Заказы
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              заказы поставщикам из EstiMat · только чтение
            </Typography.Text>
          </Space>
          <SyncHeader status={syncStatus.data} canSync={hasCapability('references.supplier_orders.sync')} />
          <Space wrap size={8}>
            <DebouncedSearch
              placeholder="Номер, поставщик, подрядчик, ИНН"
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
            <Select<string>
              allowClear
              placeholder="Стадия"
              value={status}
              onChange={(v) => setFilter('status', v)}
              style={{ width: FILTER_WIDTH }}
              options={ESTIMAT_SOURCING_STATUSES.map((s) => ({ value: s, label: stageLabel(s) }))}
            />
            <Select<string>
              allowClear
              placeholder="Виза"
              value={approval}
              onChange={(v) => setFilter('approval', v)}
              style={{ width: FILTER_WIDTH }}
              options={ESTIMAT_APPROVAL_STATES.filter((s) => s !== 'unknown').map((s) => ({
                value: s,
                label: APPROVAL_STATE_LABELS[s],
              }))}
            />
            <Space size={6}>
              <Switch
                checked={includeDeleted}
                onChange={(v) => setFilter('deleted', v ? '1' : undefined)}
                aria-label="Показывать удалённые"
              />
              <Typography.Text>Удалённые</Typography.Text>
            </Space>
          </Space>
        </Space>
      }
    >
      {list.isError && <Alert type="error" showIcon message="Не удалось загрузить заказы" />}
      <ResponsiveTable<EstimatOrderListItem>
        items={items}
        loading={list.isLoading}
        rowKey="id"
        scrollX={1300}
        onRowClick={(r) => setOpenOrderId(r.id)}
        emptyText="Заказов нет"
        numberedOffset={offset}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: list.data?.total ?? 0,
          showSizeChanger: false,
          onChange: setPage,
        }}
        columns={[
          { title: '№', key: 'number', width: 110, render: (_v, r) => <Typography.Text strong>{r.number}</Typography.Text> },
          {
            title: 'Объект',
            key: 'site',
            width: 150,
            render: (_v, r) =>
              r.siteCode ?? (
                <Tooltip title={`Код объекта в EstiMat «${r.projectCode ?? '—'}» не найден среди объектов портала`}>
                  <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                    {r.projectCode ?? 'без кода'} · не найден
                  </Tag>
                </Tooltip>
              ),
          },
          { title: 'Подрядчик', key: 'contractors', width: 220, render: (_v, r) => contractorsText(r) },
          {
            title: 'Поставщик',
            key: 'supplier',
            width: 240,
            render: (_v, r) => (r.supplierName ? `${r.supplierName}${r.supplierInn ? `, ИНН ${r.supplierInn}` : ''}` : '— не выбран —'),
          },
          { title: 'Сумма', key: 'amount', width: 140, align: 'right', render: (_v, r) => formatMoneyRu(r.amount) },
          { title: 'Стадия', key: 'stage', width: 160, render: (_v, r) => stageLabel(r.sourcingStatus) },
          {
            title: 'Виза',
            key: 'approval',
            width: 220,
            // Короткое состояние тегом, подробности (дата визы, когда сняли) —
            // второй строкой: длинная фраза в теге обрезалась бы шириной колонки.
            render: (_v, r) => (
              <Space direction="vertical" size={0}>
                <Tag color={APPROVAL_STATE_COLORS[r.approvalState]} style={{ marginInlineEnd: 0 }}>
                  {APPROVAL_STATE_LABELS[r.approvalState]}
                </Tag>
                {(r.approvalState === 'approved' ||
                  (r.approvalState === 'pending' && r.lastApprovalRevokedAt)) && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {approvalText(r)}
                  </Typography.Text>
                )}
              </Space>
            ),
          },
          { title: 'Приёмки', key: 'deliveries', width: 90, align: 'right', render: (_v, r) => r.linkedDeliveriesCount || '—' },
        ]}
        cardRender={(r) => (
          <Card style={{ width: '100%' }} size="small" onClick={() => setOpenOrderId(r.id)}>
            <Space direction="vertical" size={4}>
              <Space wrap size={6}>
                <Typography.Text strong>{r.number}</Typography.Text>
                <Tag color={APPROVAL_STATE_COLORS[r.approvalState]} style={{ marginInlineEnd: 0 }}>
                  {APPROVAL_STATE_LABELS[r.approvalState]}
                </Tag>
              </Space>
              <Typography.Text type="secondary">
                {r.siteCode ?? r.projectCode ?? '—'} · {stageLabel(r.sourcingStatus)}
              </Typography.Text>
              <Typography.Text>{r.supplierName ?? '— поставщик не выбран —'}</Typography.Text>
              <Typography.Text>{formatMoneyRu(r.amount)}</Typography.Text>
            </Space>
          </Card>
        )}
      />
      <OrderDrawer orderId={openOrderId} onClose={() => setOpenOrderId(null)} />
    </StickyPageHeader>
  );
}
