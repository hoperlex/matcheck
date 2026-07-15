import type { MouseEvent, ReactNode, RefObject } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Input,
  Popconfirm,
  Select,
  Space,
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
  CustomerCounterparty,
  Shipment,
  ShipmentListResponseSchema,
  Site,
  SourceDocumentListResponseSchema,
  Supplier,
} from '@matcheck/contracts';
import type { z } from 'zod';
import dayjs from 'dayjs';
import { ApiError, api } from '../../services/api';
import {
  hardDeleteShipment,
  markDeletion,
  unmarkDeletion,
} from '../../services/shipments';
import { useAuthStore } from '../../stores/auth';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StatusIconsCell, StatusLegend, ReviewStatusIcon } from '../../shared/ui/operationStatusIcon';
import { operationsRowClass } from '../../shared/utils/operationsRowHighlight';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { ListFilters, type ListFiltersValue } from '../../shared/ui/ListFilters';
import { PageTabs, type PageTabItem } from '../../shared/ui/PageTabs';
import { useBulkSelection } from '../../shared/ui/useBulkSelection';
import { BulkActionInline } from '../../shared/ui/BulkActionInline';
import { parseCsvIds, toCsvIds } from '../../shared/utils/csvIds';
import { useSyncGlobalFilters } from '../../shared/hooks/useSyncGlobalFilters';
import { ShareLinkModal } from '../../components/ShareLinkModal';
import { ShipmentViewModal, type ShipmentViewData } from './ShipmentViewModal';
import {
  FEATURE_VALUES,
  PURPOSE_VALUES,
  ShipmentFeatureFilters,
  type ShipmentFeature,
  type ShipmentPurpose,
} from './ShipmentFeatureFilters';
import { PendingDeletionTag } from '../../shared/ui/PendingDeletionTag';
import { formatDateTimeRu, formatMoneyRu } from '../../shared/utils/formatRu';
import { OperationsRowLegend } from '../operations/OperationsRowLegend';
// directoryFilterMap (ИНН-маппинг customer_counterparties → operational
// counterparties) больше не нужен — фильтрация переехала на сервер.

type List = z.infer<typeof ShipmentListResponseSchema>;
type Row = List['items'][number];
type SourceList = z.infer<typeof SourceDocumentListResponseSchema>;
type SourceRow = SourceList['items'][number];

// Σ qty × price по позициям, где price задан (зеркало deliveryItemsTotal
// в DeliveriesHistory). Если ни у одной позиции нет цены — null → UI «—».
function shipmentItemsTotal(items: Row['items'] | undefined): number | null {
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

function shipmentItemsVatSum(items: Row['items'] | undefined): number | null {
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

// Статусы, для которых вместо hard-delete показываем «Пометить на удаление».
const SOFT_DELETE_STATUSES = new Set(['filled', 'confirmed_mol']);

export function ShipmentsHistory({
  onOpen,
  tabs,
  activeTab,
  onTabChange,
  filtersExtra,
  bulkActionsPortalRef,
}: {
  onOpen: (id: string) => void;
  tabs?: PageTabItem[];
  activeTab?: string;
  onTabChange?: (key: string) => void;
  filtersExtra?: ReactNode;
  // См. комментарий-двойник в DeliveriesHistory: если задан — bulk-actions
  // улетают через React Portal в slot OperationsPage и не двигают таблицу.
  bulkActionsPortalRef?: RefObject<HTMLElement | null>;
}) {
  const queryClient = useQueryClient();
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [reasonDraft, setReasonDraft] = useState<Record<string, string>>({});
  const [shareId, setShareId] = useState<string | null>(null);
  const [viewData, setViewData] = useState<ShipmentViewData | null>(null);
  const [params, setParams] = useSearchParams();
  const authUser = useAuthStore((s) => s.user);
  const isAdmin = authUser?.role === 'admin';
  // Подрядчик: read-only + справочники закрыты — имена берём из DTO, фильтры/
  // действия записи скрыты, справочные запросы не грузим.
  const isContractor = authUser?.role === 'contractor';
  // Мониторинг: read-only на данные, видит все объекты, ставит отметку проверки.
  const isMonitor = authUser?.role === 'monitor';
  // Менеджмент видит отметку проверки: бейдж, фильтр «С замечаниями».
  const isManagement = isAdmin || authUser?.role === 'manager' || isMonitor;

  // См. комментарий в DeliveriesHistory: tracking внешнего slot для portal-
  // режима bulk-actions, чтобы не сдвигать таблицу при выборе строк.
  const [bulkSlotEl, setBulkSlotEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setBulkSlotEl(bulkActionsPortalRef?.current ?? null);
  }, [bulkActionsPortalRef]);

  // Две вкладки: «Активные» (включая отгрузки без УПД) и «Корзина».
  // URL: trash=1 — корзина. Поиск «Без документа» доступен через
  // селект «Статус» как псевдо-значение no_document.
  type View = 'active' | 'trash';
  const view: View = params.get('trash') === '1' ? 'trash' : 'active';
  const isTrash = view === 'trash';

  // Тип отгрузки и Признаки храним как повторяющиеся `?purpose=X&purpose=Y`
  // и `?feature=A&feature=B` — это нативно поддерживается URLSearchParams
  // и не требует кодирования запятых внутри значений вроде «Перемещение
  // на объект» (CSV сломало бы пробелы). Невалидные значения в URL
  // (например, ?purpose=Foo от старой закладки) игнорируются.
  const PURPOSE_SET = new Set<string>(PURPOSE_VALUES);
  const FEATURE_SET = new Set<string>(FEATURE_VALUES);
  const urlPurposes = params.getAll('purpose').filter((v): v is ShipmentPurpose =>
    PURPOSE_SET.has(v),
  );
  const urlFeatures = params.getAll('feature').filter((v): v is ShipmentFeature =>
    FEATURE_SET.has(v),
  );

  type ExtraFilters = {
    status: string | null;
    plate: string;
    purposes: ShipmentPurpose[];
    features: ShipmentFeature[];
    // ?nophoto=1 — deep-link из дашборда «Статистика». Симметрично с
    // DeliveriesHistory.
    nophoto: boolean;
    // Фильтр по отметке проверки (менеджмент): approved|issues|none.
    reviewState: string | null;
    // Диапазон даты отгрузки — дни (YYYY-MM-DD), пустая строка = граница не
    // задана. В URL это ?dfrom=/?dto=; конверсия в ISO-границы для сервера —
    // в queryFn (см. shippedFrom/shippedTo). Симметрично с DeliveriesHistory.
    dateFrom: string;
    dateTo: string;
  };
  const filters: ListFiltersValue & ExtraFilters = {
    contractorIds: parseCsvIds(params.get('contractor')),
    supplierIds: parseCsvIds(params.get('supplier')),
    siteIds: parseCsvIds(params.get('site')),
    q: params.get('q') ?? '',
    status: params.get('status'),
    plate: params.get('plate') ?? '',
    purposes: urlPurposes,
    features: urlFeatures,
    nophoto: params.get('nophoto') === '1',
    reviewState: params.get('review'),
    dateFrom: params.get('dfrom') ?? '',
    dateTo: params.get('dto') ?? '',
  };

  const updateFilters = (
    patch: Partial<ListFiltersValue & ExtraFilters>,
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
    if ('purposes' in patch) {
      next.delete('purpose');
      for (const p of patch.purposes ?? []) next.append('purpose', p);
    }
    if ('features' in patch) {
      next.delete('feature');
      for (const f of patch.features ?? []) next.append('feature', f);
    }
    if ('reviewState' in patch) apply('review', patch.reviewState);
    if ('dateFrom' in patch) apply('dfrom', patch.dateFrom);
    if ('dateTo' in patch) apply('dto', patch.dateTo);
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

  // ─── server-side pagination ─────────────────────────────────────────
  // page хранится в URL (?page=N). pageSize фиксированный 50. См.
  // подробный комментарий в DeliveriesHistory.tsx — там описаны принципы
  // (включая отказ от клиентской сортировки в рамках страницы).
  const PAGE_SIZE = 50;
  const pageRaw = Number.parseInt(params.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const setPage = (next: number) => {
    const np = new URLSearchParams(params);
    if (next <= 1) np.delete('page');
    else np.set('page', String(next));
    setParams(np, { replace: true });
  };
  const offset = (page - 1) * PAGE_SIZE;

  const listQueryKey = [
    'shipments',
    view,
    page,
    PAGE_SIZE,
    {
      contractor: filters.contractorIds.join(','),
      supplier: filters.supplierIds.join(','),
      site: filters.siteIds.join(','),
      q: filters.q,
      plate: filters.plate,
      purposes: filters.purposes.join(','),
      features: filters.features.join(','),
      status: filters.status,
      nophoto: filters.nophoto,
      review: filters.reviewState,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
    },
  ] as const;
  const list = useQuery({
    queryKey: listQueryKey,
    queryFn: () => {
      const qs = new URLSearchParams();
      qs.set('limit', String(PAGE_SIZE));
      qs.set('offset', String(offset));
      if (view === 'trash') qs.set('trash', '1');
      if (filters.contractorIds.length) qs.set('contractorIds', filters.contractorIds.join(','));
      if (filters.supplierIds.length) qs.set('supplierIds', filters.supplierIds.join(','));
      if (filters.siteIds.length) qs.set('siteIds', filters.siteIds.join(','));
      if (filters.q.trim()) qs.set('q', filters.q.trim());
      if (filters.plate.trim()) qs.set('plate', filters.plate.trim());
      if (filters.purposes.length) qs.set('purposes', filters.purposes.join(','));
      if (filters.features.length) qs.set('features', filters.features.join(','));
      if (filters.nophoto) qs.set('nophoto', '1');
      if (filters.status === 'no_document') qs.set('noDocument', 'true');
      else if (filters.status) qs.set('status', filters.status);
      if (filters.reviewState) qs.set('reviewState', filters.reviewState);
      // Дни → ISO-границы. Сервер сравнивает shipped_at >= shippedFrom AND
      // shipped_at < shippedTo, поэтому верхняя граница — начало СЛЕДУЮЩЕГО
      // дня: иначе записи выбранного конечного дня выпали бы из выдачи.
      if (filters.dateFrom) {
        qs.set('shippedFrom', dayjs(filters.dateFrom).startOf('day').toISOString());
      }
      if (filters.dateTo) {
        qs.set('shippedTo', dayjs(filters.dateTo).add(1, 'day').startOf('day').toISOString());
      }
      return api.get<List>(`/shipments?${qs.toString()}`);
    },
    placeholderData: keepPreviousData,
  });

  // Операционные counterparties — для резолва имён в колонке «Получатель»
  // и для маппинга «id справочника заказчика → set операционных id по ИНН».
  // Опции селектов фильтра приходят из заказчиковских справочников.
  const counterpartiesQuery = useQuery({
    queryKey: ['counterparties', 'all'],
    queryFn: () => api.get<{ items: Counterparty[]; total: number }>('/counterparties?limit=5000'),
    enabled: !isContractor,
  });
  const customerCounterpartiesQuery = useQuery({
    queryKey: ['customer-counterparties', 'all'],
    queryFn: () =>
      api.get<{ items: CustomerCounterparty[]; total: number }>(
        '/customer-counterparties?limit=5000',
      ),
    enabled: !isContractor,
  });
  const suppliersQuery = useQuery({
    queryKey: ['suppliers', 'all'],
    queryFn: () =>
      api.get<{ items: Supplier[]; total: number }>('/suppliers?limit=5000'),
    enabled: !isContractor,
  });
  const sitesQuery = useQuery({
    queryKey: ['sites', 'all'],
    queryFn: () => api.get<{ items: Site[]; total: number }>('/sites?limit=500'),
    enabled: !isContractor,
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

  // Опции/маппинг для фильтров «Подрядчик» (получатель) и «Поставщик» —
  // из заказчиковских справочников customer_counterparties / suppliers
  // (то, что видно во вкладках Справочников). buildInnMatchMap нормализует
  // ИНН и пропускает плейсхолдеры — см. shared/utils/directoryFilterMap.
  const contractorOptions = useMemo(
    () =>
      (customerCounterpartiesQuery.data?.items ?? []).map((c) => ({
        value: c.id,
        label: c.name,
      })),
    [customerCounterpartiesQuery.data],
  );
  const supplierOptions = useMemo(
    () =>
      (suppliersQuery.data?.items ?? []).map((s) => ({
        value: s.id,
        label: s.name,
      })),
    [suppliersQuery.data],
  );
  // Раньше тут было buildInnMatchMap клиента — теперь ИНН-маппинг
  // делает сервер в /shipments (см. expandCustomerCounterpartyToOpIds
  // в apps/api/src/routes/shipments.ts). На клиенте остался только
  // counterpartiesMap (для отображения имён в колонках).

  const destinationLabel = (r: Shipment): string => {
    if (r.kind === 'contractor' || r.kind === 'return') {
      // DTO-имя получателя (сервер резолвит через JOIN) — работает без
      // справочника /counterparties, закрытого для роли contractor.
      if (r.receiverName) return r.receiverName;
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
    // Для contractor/return показываем контрагента-получателя; для transfer
    // — объект-приёмник (destinationLabel вернёт его имя); для writeoff —
    // «Списание». Это симметрично с колонкой «Поставщик» приёмки: всегда
    // показываем самую информативную для этого kind точку «куда / кому».
    if (r.kind === 'contractor' || r.kind === 'return') {
      if (r.receiverName) return r.receiverName;
      return r.receiverCounterpartyId
        ? counterpartiesMap.get(r.receiverCounterpartyId) ?? '—'
        : '—';
    }
    return destinationLabel(r);
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

  // Клиентская filteredItems удалена — фильтрация полностью на сервере
  // (см. shipments.ts: contractorIds/supplierIds/siteIds/q/plate/features/
  // purposes/nophoto/status в WHERE). При смене любого фильтра — сброс
  // page=1 и очистка selection.
  const filterKey = `${filters.contractorIds.join(',')}|${filters.supplierIds.join(',')}|${filters.siteIds.join(',')}|${filters.q}|${filters.plate}|${filters.purposes.join(',')}|${filters.features.join(',')}|${filters.status ?? ''}|${filters.nophoto ? '1' : ''}|${filters.reviewState ?? ''}|${filters.dateFrom}|${filters.dateTo}|${view}`;
  useEffect(() => {
    if (page !== 1) setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

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
      r.receiverName ??
      (r.receiverCounterpartyId ? counterpartiesMap.get(r.receiverCounterpartyId) ?? null : null);
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
      siteName: r.siteName ?? sitesMap.get(r.siteId) ?? null,
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
      {/* Подрядчик и мониторинг — read-only: правка недоступна. */}
      {!isContractor && !isMonitor && (
        <Tooltip title="Редактировать">
          <Button
            size="small"
            shape="circle"
            icon={<EditOutlined />}
            onClick={() => onOpen(r.id)}
          />
        </Tooltip>
      )}
    </>
  );

  const renderActions = (r: Row) => {
    // Подрядчик и мониторинг — read-only: удаление/пометка/восстановление недоступны.
    if (isContractor || isMonitor) return null;
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
    <StatusIconsCell
      code={r.status.code}
      label={r.status.label}
      color={r.status.color}
      noDocument={r.sourceDocumentIds.length === 0}
      extra={
        <>
          {/* Значок проверки — приходит в DTO только менеджменту (иначе null →
              значка нет). Расшифровка — в легенде сверху (showReview). */}
          <ReviewStatusIcon state={r.reviewState} />
          {isTrash ? (
            <PendingDeletionTag
              at={r.pendingDeletionAt}
              byEmail={r.pendingDeletionByUserEmail}
              reason={r.pendingDeletionReason}
            />
          ) : null}
        </>
      }
    />
  );

  // Легенда значков статуса — из реальных статусов данных (см. Deliveries).
  const legendStatuses = useMemo(() => {
    const seen = new Map<string, { code: string; label: string; color: string | null }>();
    for (const r of items) {
      if (!seen.has(r.status.code)) {
        seen.set(r.status.code, {
          code: r.status.code,
          label: r.status.label,
          color: r.status.color,
        });
      }
    }
    return Array.from(seen.values());
  }, [items]);

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
            // Подрядчик видит один свой срез — справочные фильтры скрыты.
            // Поиск, авто и даты работают внутри его среза.
            fields={
              isContractor
                ? ['q', 'plate', 'dates']
                : ['contractor', 'supplier', 'site', 'q', 'plate', 'dates']
            }
            contractorOptions={contractorOptions}
            supplierOptions={supplierOptions}
            sites={sitesQuery.data?.items ?? []}
            loading={
              customerCounterpartiesQuery.isLoading ||
              suppliersQuery.isLoading ||
              sitesQuery.isLoading
            }
            searchPlaceholder="Номер документа"
            plate={filters.plate}
            onPlateChange={(v) => updateFilters({ plate: v })}
            dateRange={[
              filters.dateFrom ? dayjs(filters.dateFrom) : null,
              filters.dateTo ? dayjs(filters.dateTo) : null,
            ]}
            onDateRangeChange={(r) =>
              updateFilters({
                dateFrom: r?.[0]?.format('YYYY-MM-DD') ?? '',
                dateTo: r?.[1]?.format('YYYY-MM-DD') ?? '',
              })
            }
            datesPlaceholder={['Отгружено с', 'по']}
            // Инпут «Статус» убран по UX-запросу: старый ?status= в URL
            // продолжает фильтровать, но UI его не выставляет.
            tail={
              <>
                <ShipmentFeatureFilters
                  value={{ purposes: filters.purposes, features: filters.features }}
                  onChange={updateFilters}
                />
                {/* Фильтр по отметке проверки — только менеджменту. */}
                {isManagement && (
                  <Select
                    size="small"
                    style={{ minWidth: 150 }}
                    value={filters.reviewState ?? 'all'}
                    onChange={(v) => updateFilters({ reviewState: v === 'all' ? null : v })}
                    options={[
                      { value: 'all', label: 'Проверка: все' },
                      { value: 'issues', label: 'С замечаниями' },
                      { value: 'approved', label: 'Проверено' },
                      { value: 'none', label: 'Не проверено' },
                    ]}
                  />
                )}
              </>
            }
            extra={filtersExtra}
          />
          {(() => {
            // См. комментарий-двойник в DeliveriesHistory: если есть tabs —
            // bulk-actions переезжают в PageTabs.extra; иначе рисуются
            // независимой строкой справа от шапки (OperationsPage не
            // передаёт tabs).
            const actions = bulk.hasSelection ? (
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
            ) : null;

            if (tabs && activeTab && onTabChange) {
              return (
                <PageTabs
                  items={tabs}
                  activeKey={activeTab}
                  onChange={onTabChange}
                  extra={actions}
                />
              );
            }
            // См. DeliveriesHistory: portal-режим — actions улетают в
            // шапку OperationsPage, таблица не сдвигается. Без ref —
            // legacy inline-рендер (для других страниц).
            if (bulkActionsPortalRef) {
              return bulkSlotEl && actions ? createPortal(actions, bulkSlotEl) : null;
            }
            return actions ? (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                {actions}
              </div>
            ) : null;
          })()}
          <StatusLegend statuses={legendStatuses} showReview={isManagement} />
        </Space>
      }
    >
      {/* Ошибка ЗАМЕНЯЕТ таблицу — см. тот же комментарий в
          DeliveriesHistory: `list.data?.items ?? []` иначе рисует
          «Нет отгрузок» поверх упавшего запроса. */}
      {list.isError ? (
        <Alert
          type="error"
          showIcon
          message="Не удалось загрузить отгрузки"
          description={list.error instanceof Error ? list.error.message : String(list.error)}
          action={
            <Button size="small" danger onClick={() => void list.refetch()}>
              Повторить
            </Button>
          }
        />
      ) : (
      <ResponsiveTable<Row>
        items={items}
        loading={list.isLoading}
        rowKey="id"
        rowSelection={
          (isAdmin || !isTrash) && !isContractor && !isMonitor ? bulk.selection : undefined
        }
        // monitor — read-only: клик по строке открывает просмотр (там же —
        // отметка проверки), а не редактор.
        onRowClick={(r) => (isMonitor ? setViewData(buildViewData(r)) : onOpen(r.id))}
        emptyText={view === 'trash' ? 'Корзина пуста' : 'Нет отгрузок'}
        rowClassName={(r) =>
          operationsRowClass({ statusCode: r.status.code, dateIso: r.shippedAt })
        }
        numberedOffset={offset}
        pagination={{
          // Server-side controlled pagination, симметрично DeliveriesHistory.
          current: page,
          pageSize: PAGE_SIZE,
          total: list.data?.total ?? 0,
          showSizeChanger: false,
          onChange: (next) => {
            bulk.clear();
            setPage(next);
          },
          showTotal: () => <OperationsRowLegend />,
        }}
        columns={[
          // sorter/dateRangeColumnFilter удалены — серверная пагинация
          // с фиксированной сортировкой ORDER BY displayId DESC.
          // Симметрия с DeliveriesHistory: тот же порядок — id, Статус,
          // Авто, дата, Получатель (зеркало Поставщика приёмки), Объект,
          // Фото, Сумма НДС, Сумма, Действия.
          {
            // Короткий displayId — отдельная нумерация для отгрузок (см.
            // миграцию 0059). В Ожидаемых не показывается — там УПД.
            title: 'id',
            key: 'displayId',
            width: 80,
            dataIndex: 'displayId',
          },
          {
            title: 'Статус',
            key: 'status',
            render: (_: unknown, r: Row) => renderStatusCell(r),
          },
          {
            title: 'Авто',
            dataIndex: 'vehiclePlate',
          },
          {
            title: 'Отгружено',
            dataIndex: 'shippedAt',
            render: (v: string | null) => formatDateTimeRu(v),
          },
          {
            // Зеркало «Поставщик» в Приёмке: внешний контрагент в начале
            // цепочки. Для shipment внешний — это получатель. Для transfer
            // показываем объект-приёмник через destinationLabel.
            title: 'Получатель',
            key: 'receiver',
            render: (_: unknown, r: Row) => renderCounterpartyCol(r),
          },
          {
            title: 'Объект',
            key: 'site',
            // Длинные имена («АЛ13 · ЖК АЛИЯ, БЛОКИ 13А, 13В») обрезаются
            // многоточием в одну строку (высота строки таблицы не растёт),
            // полный текст видно в Tooltip при наведении. Единое поведение
            // во всех 4 таблицах раздела «Операции» — best practice antd.
            ellipsis: { showTitle: false },
            render: (_: unknown, r: Row) => {
              const name = r.siteName ?? sitesMap.get(r.siteId) ?? '—';
              return (
                <Tooltip title={name} placement="topLeft">
                  <span>{name}</span>
                </Tooltip>
              );
            },
          },
          {
            title: 'Фото',
            key: 'photos',
            width: 80,
            // Суммарное количество фото обоих этапов (stage='before' + 'after')
            // — поле stage у shipment_photos добавлено миграцией 0048.
            render: (_: unknown, r: Row) => r.photos?.length ?? 0,
          },
          {
            title: 'Сумма НДС',
            key: 'vatSum',
            width: 120,
            render: (_: unknown, r: Row) => formatMoneyRu(shipmentItemsVatSum(r.items)),
          },
          {
            title: 'Сумма',
            key: 'totalSum',
            width: 130,
            render: (_: unknown, r: Row) => formatMoneyRu(shipmentItemsTotal(r.items)),
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
                <Typography.Text strong>{r.vehiclePlate ?? 'Без номера'}</Typography.Text>
              </Space>
              <Typography.Text type="secondary">
                {r.siteName ?? sitesMap.get(r.siteId) ?? '—'} → {destinationLabel(r)}
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
      )}
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
