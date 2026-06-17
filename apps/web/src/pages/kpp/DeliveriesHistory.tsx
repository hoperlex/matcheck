import type { MouseEvent, ReactNode, RefObject } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
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
  CustomerCounterparty,
  DeliveryListResponseSchema,
  Site,
  SourceDocumentListResponseSchema,
  Supplier,
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
import { operationsRowClass } from '../../shared/utils/operationsRowHighlight';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { ListFilters, type ListFiltersValue } from '../../shared/ui/ListFilters';
import { PageTabs, type PageTabItem } from '../../shared/ui/PageTabs';
import { useBulkSelection } from '../../shared/ui/useBulkSelection';
import { BulkActionInline } from '../../shared/ui/BulkActionInline';
import { DebouncedSearch } from '../../shared/ui/DebouncedSearch';
import { dateSorter, numberSorter, prioritySorter, stringSorter } from '../../shared/ui/tableSorters';
import { dateRangeColumnFilter } from '../../shared/ui/DateRangeFilter';
import { PendingDeletionTag } from '../../shared/ui/PendingDeletionTag';
import { matchText } from '../../shared/utils/matchText';
import { formatMoneyRu } from '../../shared/utils/formatRu';
import { shortenCounterpartyName } from '../../shared/utils/companyShortName';
import { parseCsvIds, toCsvIds } from '../../shared/utils/csvIds';
// directoryFilterMap (ИНН-маппинг customer_counterparties → operational
// counterparties) больше не нужен — фильтрация переехала на сервер.
import {
  FEATURE_VALUES,
  ShipmentFeatureFilters,
  type OperationFeature,
} from '../shipments/ShipmentFeatureFilters';
import { DeliveryViewModal, type DeliveryViewData } from './DeliveryViewModal';
import { useSyncGlobalFilters } from '../../shared/hooks/useSyncGlobalFilters';
import { ShareLinkModal } from '../../components/ShareLinkModal';
import { OperationsRowLegend } from '../operations/OperationsRowLegend';

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

export function DeliveriesHistory({
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
  // Если задан — bulk-actions рендерятся через React Portal в этот
  // внешний слот (напр., в header-row OperationsPage), а НЕ строкой
  // под фильтрами. Это убирает layout shift при выборе строк: таблица
  // больше не «прыгает» вниз при появлении панели. Если не задан —
  // поведение прежнее: actions рисуются под фильтрами (для других
  // страниц, где этот компонент используется без OperationsPage).
  bulkActionsPortalRef?: RefObject<HTMLElement | null>;
}) {
  const queryClient = useQueryClient();
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [reasonDraft, setReasonDraft] = useState<Record<string, string>>({});
  const [viewData, setViewData] = useState<DeliveryViewData | null>(null);
  const [shareId, setShareId] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const authUser = useAuthStore((s) => s.user);
  const isAdmin = authUser?.role === 'admin';

  // Slot для bulk-actions в внешнем header-row родителя. Отслеживаем
  // через state, потому что ref.current = null до commit phase — портал
  // на первом рендере не сработает иначе.
  const [bulkSlotEl, setBulkSlotEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setBulkSlotEl(bulkActionsPortalRef?.current ?? null);
  }, [bulkActionsPortalRef]);

  // Две вкладки: «Активные» (включая приёмки без УПД) и «Корзина».
  // URL: trash=1 — корзина. Поиск «Без документа» доступен через
  // селект «Статус» как псевдо-значение no_document.
  type View = 'active' | 'trash';
  const view: View = params.get('trash') === '1' ? 'trash' : 'active';
  const isTrash = view === 'trash';

  // «Признаки» в Принятых приёмках — повторяющиеся ?feature=A&feature=B.
  // Симметрично с ShipmentsHistory: повторяющиеся ключи через
  // URLSearchParams.getAll/append, CSV не использую (имена короткие, но
  // оставляем единообразие). Невалидные значения из URL отбрасываются.
  const FEATURE_SET = new Set<string>(FEATURE_VALUES);
  const urlFeatures = params.getAll('feature').filter((v): v is OperationFeature =>
    FEATURE_SET.has(v),
  );

  type ExtraFilters = {
    status: string | null;
    plate: string;
    features: OperationFeature[];
    // ?nophoto=1 — deep-link из дашборда «Статистика». В UI селекта нет,
    // ради единственного use-case городить отдельный псевдо-статус
    // (как было с no_document) избыточно. Сбрасывается ручной очисткой URL.
    nophoto: boolean;
  };
  const filters: ListFiltersValue & ExtraFilters = {
    contractorIds: parseCsvIds(params.get('contractor')),
    supplierIds: parseCsvIds(params.get('supplier')),
    siteIds: parseCsvIds(params.get('site')),
    q: params.get('q') ?? '',
    status: params.get('status'),
    plate: params.get('plate') ?? '',
    features: urlFeatures,
    nophoto: params.get('nophoto') === '1',
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
    if ('features' in patch) {
      next.delete('feature');
      for (const f of patch.features ?? []) next.append('feature', f);
    }
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
  // KppPage. Здесь читаем только URL для запроса /deliveries?trash=1.

  // ─── server-side pagination ─────────────────────────────────────────
  // page хранится в URL (?page=N) — переживает F5, можно share by link.
  // pageSize фиксированный 50 (см. ETAP 1 в plan-discussion). Стрелки
  // сортировки в колонках убраны: серверный ORDER BY displayId DESC
  // не должен спорить с visual hint «можно отсортировать»; на серверной
  // пагинации клиентская сортировка в рамках страницы стала бы
  // UX-ловушкой.
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

  // queryKey включает ВСЕ параметры, влияющие на серверный фильтр и
  // пагинацию. При смене любого — React Query делает новый запрос,
  // existing invalidateQueries({ queryKey: ['deliveries'] }) по префиксу
  // продолжит работать.
  const listQueryKey = [
    'deliveries',
    view,
    page,
    PAGE_SIZE,
    {
      contractor: filters.contractorIds.join(','),
      supplier: filters.supplierIds.join(','),
      site: filters.siteIds.join(','),
      q: filters.q,
      plate: filters.plate,
      features: filters.features.join(','),
      status: filters.status,
      nophoto: filters.nophoto,
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
      if (filters.features.length) qs.set('features', filters.features.join(','));
      if (filters.nophoto) qs.set('nophoto', '1');
      // status=no_document — псевдо-значение, мапится на server-side noDocument=true.
      if (filters.status === 'no_document') qs.set('noDocument', 'true');
      else if (filters.status) qs.set('status', filters.status);
      return api.get<List>(`/deliveries?${qs.toString()}`);
    },
    placeholderData: keepPreviousData,
  });

  // Операционная таблица counterparties — нужна для:
  //   1) резолва имён в колонках «Подрядчик»/«Поставщик» (FK операций
  //      ссылаются именно на неё);
  //   2) маппинга «id справочника заказчика → set операционных id по ИНН»,
  //      см. ниже directoryFilterMap.
  // Опции селектов фильтра берутся из заказчиковских справочников
  // (customer_counterparties / suppliers) — это то, что пользователь видит
  // на вкладках Справочников.
  const counterpartiesQuery = useQuery({
    queryKey: ['counterparties', 'all'],
    queryFn: () =>
      api.get<{ items: Counterparty[]; total: number }>('/counterparties?limit=5000'),
  });
  const customerCounterpartiesQuery = useQuery({
    queryKey: ['customer-counterparties', 'all'],
    queryFn: () =>
      api.get<{ items: CustomerCounterparty[]; total: number }>(
        '/customer-counterparties?limit=5000',
      ),
  });
  const suppliersQuery = useQuery({
    queryKey: ['suppliers', 'all'],
    queryFn: () =>
      api.get<{ items: Supplier[]; total: number }>('/suppliers?limit=5000'),
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
      void queryClient.invalidateQueries({ queryKey: ['reports', 'operations-counters'] });
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
      void queryClient.invalidateQueries({ queryKey: ['reports', 'operations-counters'] });
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
      void queryClient.invalidateQueries({ queryKey: ['reports', 'operations-counters'] });
    },
  });

  // Массовый выбор. Набор кнопок в bulk-bar зависит от вкладки:
  //  - Активные: «Пометить N на удаление»;
  //  - Удалённые (trash): «Восстановить N» + «Удалить N навсегда».
  // Bulk-bar живёт в PageTabs.tabBarExtraContent — занимает зарезервированное
  // место в шапке, не сдвигает таблицу при появлении/исчезновении.
  const bulk = useBulkSelection<Row>((r) => r.id);
  const handleBulkSuccess = (res: BulkDeleteResponse, okMsg: string) => {
    bulk.clear();
    if (res.deleted.length > 0) message.success(`${okMsg}: ${res.deleted.length}`);
    if (res.skipped.length > 0) {
      message.warning(`Пропущено ${res.skipped.length}: ${bulkSkipMessage(res.skipped)}`);
    }
    void queryClient.invalidateQueries({ queryKey: ['deliveries'] });
  };
  const bulkMark = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<BulkDeleteResponse>('/deliveries/bulk-mark-deletion', { ids }),
    onSuccess: (res) => handleBulkSuccess(res, 'Помечено на удаление'),
    onError: (err: Error) => message.error(err.message),
  });
  const bulkUnmark = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<BulkDeleteResponse>('/deliveries/bulk-unmark-deletion', { ids }),
    onSuccess: (res) => handleBulkSuccess(res, 'Восстановлено'),
    onError: (err: Error) => message.error(err.message),
  });
  const bulkHard = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<BulkDeleteResponse>('/deliveries/bulk-hard-delete', { ids }),
    onSuccess: (res) => handleBulkSuccess(res, 'Удалено навсегда'),
    onError: (err: Error) => message.error(err.message),
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

  // Опции селектов «Подрядчик»/«Поставщик» — берём из заказчиковских
  // справочников (того, что видно во вкладках Справочники → Контрагенты /
  // Поставщики). id в URL фильтра — это id записи справочника, не FK операций.
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
  // делает сервер в /deliveries (см. expandCustomerCounterpartyToOpIds
  // в apps/api/src/routes/deliveries.ts). На клиенте остался только
  // counterpartiesMap (для отображения имён в колонках), его строим выше.

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

  // Собираем готовый снимок для read-only Drawer: уже подставлены имена
  // подрядчика/объекта/поставщика и метаданные привязанного УПД. Drawer
  // сам не лезет в API — отрисовывает то, что мы передали.
  const buildViewData = (r: Row): DeliveryViewData => {
    const { id: contractorId } = resolveContractor(r);
    const { id: siteId } = resolveSite(r);
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
      delivery: r,
      contractorName: contractorId ? counterpartiesMap.get(contractorId) ?? null : null,
      supplierName: r.supplierId ? counterpartiesMap.get(r.supplierId) ?? null : null,
      siteName: siteId ? sitesMap.get(siteId) ?? null : null,
      docNumber: sd?.docNumber ?? null,
      docKindLabel: kindLabel,
      docTotalSum: totalSum,
    };
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

  // Клиентская filteredItems удалена — фильтрация полностью на сервере
  // (см. apps/api/src/routes/deliveries.ts: contractorIds/supplierIds/
  // siteIds/q/plate/features/nophoto/status в WHERE). items, что пришёл
  // из API уже отфильтрован и ограничен 50 строками текущей страницы.
  //
  // При смене любого фильтра — сбрасываем page=1 и selection (иначе
  // пользователь может «удалить выбранные строки» на странице 7,
  // забыв что они с прошлой выборки). useEffect ниже отслеживает
  // комбинированный ключ фильтров.
  const filterKey = `${filters.contractorIds.join(',')}|${filters.supplierIds.join(',')}|${filters.siteIds.join(',')}|${filters.q}|${filters.plate}|${filters.features.join(',')}|${filters.status ?? ''}|${filters.nophoto ? '1' : ''}|${view}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (page !== 1) setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

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

  // Две кнопки слева от привычного блока «Удалить/Восстановить»:
  // 👁 — лёгкий Drawer-просмотр (фото + материалы read-only),
  // ✏ — переход в полный редактор (тот же путь что был у клика по строке).
  // Клик по строке оставлен как был — иконки появляются как дополнительный
  // путь, чтобы не ломать мышечную память.
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
      <Tooltip title="Поделиться ссылкой">
        <Button
          size="small"
          shape="circle"
          icon={<ShareAltOutlined />}
          onClick={() => setShareId(r.id)}
        />
      </Tooltip>
    </>
  );

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
    const name = id ? sitesMap.get(id) ?? '—' : '—';
    // Truncate в одну строку через antd column ellipsis (колонка-уровень);
    // здесь оборачиваем в Tooltip, чтобы при наведении был виден полный
    // текст. Высота строки таблицы остаётся одинаковой для всех записей.
    return (
      <Tooltip title={name} placement="topLeft">
        <span>{name}</span>
      </Tooltip>
    );
  };
  const supplierName = (id: string | null | undefined) =>
    id ? shortenCounterpartyName(counterpartiesMap.get(id)) : '—';

  return (
    <>
    <StickyPageHeader
      header={
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          {/* Переключатель «Удалённые» теперь живёт в шапке KppPage рядом
              с Title (читается через URL ?trash=1) — это даёт постоянное
              место наверху и убирает «прыжок» контента при переключении
              вкладок Ожидаемые/Принятые. */}
          <ListFilters
            value={filters}
            onChange={updateFilters}
            fields={['contractor', 'supplier', 'site', 'q']}
            contractorOptions={contractorOptions}
            supplierOptions={supplierOptions}
            sites={sitesQuery.data?.items ?? []}
            loading={
              customerCounterpartiesQuery.isLoading ||
              suppliersQuery.isLoading ||
              sitesQuery.isLoading
            }
            searchPlaceholder="Номер документа"
            tail={
              // showPurpose=false → purpose-селект не рендерится, поэтому
              // purposes в onChange-patch'е никогда не приходят. Адаптер
              // прокидывает только features, чтобы не тащить shipment-
              // специфичные поля в delivery-фильтр.
              <ShipmentFeatureFilters
                value={{ purposes: [], features: filters.features }}
                onChange={(patch) => {
                  if ('features' in patch) {
                    updateFilters({ features: patch.features });
                  }
                }}
                showPurpose={false}
              />
            }
            // Инпуты «Статус» и «Номер авто» убраны по UX-запросу: оставлен
            // единый набор фильтров с вкладкой «Ожидаемые». Если фильтры всё
            // ещё в URL (от старой ссылки) — query тянет полный список, а
            // UI просто не подсвечивает их применёнными.
            extra={filtersExtra}
          />
          {(() => {
            // Bulk-actions: набор зависит от вкладки (Активные / Удалённые)
            // и роли (hard-delete только admin). Раньше блок рендерился
            // ТОЛЬКО внутри PageTabs.extra, поэтому при отсутствии tabs
            // (как в OperationsPage, где собственные табы Ожидаемые/
            // Принятые) кнопки «Удалить выбранные» / «Снять выбор» не
            // появлялись при массовом выборе. Теперь блок отдельный:
            // если есть tabs — переезжает в PageTabs.extra (как было);
            // иначе рисуется самостоятельной строкой справа от шапки.
            const actions = bulk.hasSelection ? (
              isTrash ? (
                <Space size={8}>
                  <Typography.Text type="secondary">
                    Выбрано: <b>{bulk.selectedCount}</b>
                  </Typography.Text>
                  <Popconfirm
                    title={`Восстановить ${bulk.selectedCount} ${pluralizeDelivery(bulk.selectedCount)}?`}
                    okText="Восстановить"
                    cancelText="Отмена"
                    onConfirm={() =>
                      bulkUnmark.mutate(Array.from(bulk.selectedIds))
                    }
                    placement="bottomRight"
                  >
                    <Button
                      icon={<UndoOutlined />}
                      loading={bulkUnmark.isPending}
                    >
                      Восстановить выбранные
                    </Button>
                  </Popconfirm>
                  {isAdmin && (
                    <Popconfirm
                      title={`Удалить ${bulk.selectedCount} ${pluralizeDelivery(bulk.selectedCount)} навсегда?`}
                      description="Восстановить будет невозможно."
                      okText="Удалить"
                      cancelText="Отмена"
                      okButtonProps={{ danger: true, loading: bulkHard.isPending }}
                      onConfirm={() =>
                        bulkHard.mutate(Array.from(bulk.selectedIds))
                      }
                      placement="bottomRight"
                    >
                      <Button
                        danger
                        icon={<DeleteOutlined />}
                        loading={bulkHard.isPending}
                      >
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
                  confirmTitle={`Пометить ${bulk.selectedCount} ${pluralizeDelivery(bulk.selectedCount)} на удаление?`}
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
            // Portal-режим: actions улетают в slot шапки OperationsPage,
            // под фильтрами ничего не рисуется → таблица не сдвигается.
            if (bulkActionsPortalRef) {
              return bulkSlotEl && actions ? createPortal(actions, bulkSlotEl) : null;
            }
            // Legacy inline для других страниц.
            return actions ? (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                {actions}
              </div>
            ) : null;
          })()}
        </Space>
      }
    >
      <ResponsiveTable<Row>
        items={items}
        loading={list.isLoading}
        rowKey="id"
        rowSelection={isAdmin || !isTrash ? bulk.selection : undefined}
        onRowClick={(r) => onOpen(r.id)}
        emptyText={view === 'trash' ? 'Корзина пуста' : 'Нет приёмок'}
        rowClassName={(r) =>
          operationsRowClass({ statusCode: r.status.code, dateIso: r.arrivedAt })
        }
        numberedOffset={offset}
        pagination={{
          // Server-side controlled: current/pageSize/total — антд сам
          // рендерит 1, 2, ... N. При смене страницы вызываем setPage,
          // queryFn делает новый запрос с offset=(page-1)*PAGE_SIZE.
          // Bulk-selection чистим при смене страницы — пользователь не
          // должен случайно удалить «невидимые» выбранные строки.
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
          // ─── sorter/dateRangeColumnFilter из колонок удалены ───
          // Server-side pagination несовместима с клиентской сортировкой
          // в рамках одной страницы (UX-ловушка «отсортировал только то
          // что вижу»). Бэк всегда возвращает ORDER BY displayId DESC
          // — свежие сверху. Фильтр по диапазону даты прибытия будет
          // добавлен отдельным UI-элементом (params: arrivedFrom/arrivedTo
          // уже принимаются сервером).
          {
            // Короткий человекочитаемый id — серверный авто-возрастающий
            // displayId (см. миграцию 0059). Помогает быстро находить
            // приёмку в разговоре «по id». В Ожидаемых не показывается
            // — там УПД (другая сущность с другой нумерацией).
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
            // Длинные имена обрезаются многоточием в одну строку (высота
            // строки таблицы не растёт), полный текст видно в Tooltip при
            // наведении — см. renderSite. Единое поведение во всех 4
            // таблицах раздела «Операции».
            ellipsis: { showTitle: false },
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
            render: (_: unknown, r: Row) => formatMoneyRu(deliveryItemsVatSum(r.items)),
          },
          {
            title: 'Сумма',
            key: 'totalSum',
            width: 130,
            render: (_: unknown, r: Row) => formatMoneyRu(deliveryItemsTotal(r.items)),
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
          <Card key={r.id} style={{ width: '100%' }} size="small">
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
    <DeliveryViewModal
      data={viewData}
      open={viewData !== null}
      onClose={() => setViewData(null)}
      onEdit={() => {
        if (!viewData) return;
        const id = viewData.delivery.id;
        setViewData(null);
        onOpen(id);
      }}
    />
    <ShareLinkModal
      entityType="delivery"
      entityId={shareId}
      open={shareId !== null}
      onClose={() => setShareId(null)}
      title="Поделиться приёмкой"
    />
    </>
  );
}

// Склонение «приёмка»: 1 приёмку / 2-4 приёмки / 5+ приёмок.
function pluralizeDelivery(n: number): string {
  const last = n % 10;
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'приёмок';
  if (last === 1) return 'приёмку';
  if (last >= 2 && last <= 4) return 'приёмки';
  return 'приёмок';
}

// Сообщение для toast о пропущенных строках — группирует по reason
// и переводит коды в человеческий текст.
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
