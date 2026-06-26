import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
} from 'antd';
import type { TableProps, UploadProps } from 'antd';
import {
  ArrowLeftOutlined,
  CameraOutlined,
  DeleteOutlined,
  DownloadOutlined,
  PlusOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Counterparty,
  ResponsiblePerson,
  Delivery,
  DeliveryPhoto,
  DeliveryStatusCode,
  Site,
  SourceDocument,
  SourceDocumentDetail,
  Status,
} from '@matcheck/contracts';
import { api, apiDownload } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { SYSTEM_SITE_ID } from '../../lib/db';
import { capturePhoto } from '../../services/photoPipeline';
import {
  applyLocalEdit,
  effectiveState,
  enqueueMutation,
  getDelivery,
  hardDeleteDelivery,
  markDeletion as markDeliveryDeletion,
  unmarkDeletion as unmarkDeliveryDeletion,
  upsertServerSnapshot,
} from '../../services/deliveries';
import { PendingDeletionTag } from '../../shared/ui/PendingDeletionTag';
import { runSync } from '../../services/sync';
import { db } from '../../lib/db';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { InlineEditChip } from '../../shared/ui/InlineEditChip';
import { FlagChip } from '../../shared/ui/FlagChip';
import { useBreakpoint } from '../../shared/hooks/useBreakpoint';
import { DeliveriesHistory } from './DeliveriesHistory';
import { ExpectedUpds } from './ExpectedUpds';
import { PhotoGallery } from './PhotoGallery';
import { formatStageTime } from './stageTime';
import { SupplierChip, useSupplierDisplayName } from '../shared/SupplierChip';
import { LinkSourceDocumentModal } from '../shared/LinkSourceDocumentModal';
import { LinkOutlined } from '@ant-design/icons';
import { parseDeliveryComment } from '../../shared/utils/parseDeliveryComment';
import {
  formatMoneyRu,
  inputNumberFormatterRu,
  inputNumberParserRu,
} from '../../shared/utils/formatRu';
import { PageTabs, type PageTabItem } from '../../shared/ui/PageTabs';
import { UnitSelect } from '../../shared/ui/UnitSelect';

type DraftItem = {
  clientKey: string;
  // id строки на сервере (delivery_items.id). null — строка только что
  // добавлена в UI и ещё не сохранена. Используется кнопкой удаления для
  // выбора UX-режима: для несохранённых — удаляем сразу, для сохранённых
  // — через Popconfirm. Сам id в save-payload не передаётся (бэк wipes
  // and reinserts по deliveryId, генерирует новые UUID).
  serverId: string | null;
  lineNo: number;
  nameRaw: string;
  qtyPlanned: string | null;
  qtyActual: string | null;
  unit: string;
  materialId: string | null;
  // Поддержка ОС в позициях; стикер AssetTag отображается при itemKind='asset'.
  itemKind: 'material' | 'asset';
  assetId: string | null;
  inventoryNumber: string | null;
  serialNumber: string | null;
  volumeM3: string | null;
  massKg: string | null;
  // Финансовый снимок из УПД. vatSum пересчитывается на лету при сохранении
  // из (qtyActual ?? qtyPlanned) × price × vatRate / 100.
  price: string | null;
  vatRate: string | null;
  vatSum: string | null;
  volumeConfidence: 'low' | 'medium' | 'high' | null;
  groupName: string | null;
};

function toNum(v: string | null): number | null {
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function computeVatSum(it: {
  qtyActual: string | null;
  qtyPlanned: string | null;
  price: string | null;
  vatRate: string | null;
}): number | null {
  const qty = toNum(it.qtyActual) ?? toNum(it.qtyPlanned);
  const price = toNum(it.price);
  const rate = toNum(it.vatRate);
  if (qty === null || price === null || rate === null) return null;
  return (qty * price * rate) / 100;
}

type ListTab = 'expected' | 'accepted';

const trimQty = (s: string) =>
  s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;

function formatMolDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

function newKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Компактный inline-label для полей шапки. Мелкий шрифт, серый цвет —
 * заметен, но не съедает место как antd Form.Item label или Card title.
 */
function FieldLabel({
  children,
  required,
}: {
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <Typography.Text
      style={{ fontSize: 11, color: '#8c8c8c', display: 'block', marginBottom: 2 }}
    >
      {children}
      {required && <span style={{ color: '#ff4d4f' }}> *</span>}
    </Typography.Text>
  );
}

/**
 * Edit-режим приёмки. Прежде это была отдельная страница `/kpp?delivery=…`,
 * сейчас может рендериться внутри большой `<Modal>` на `/operations`
 * (см. OperationsPage). Пропс `embedded=true` скрывает внутренний
 * заголовок (Title + back-button) — Modal рисует свой.
 *
 * Списочный режим переехал в OperationsPage; KppPage без edit-параметров
 * редиректит сюда через KppGuard в router.tsx.
 */
export default function KppPage({ embedded = false }: { embedded?: boolean }) {
  const navigate = useNavigate();
  const isDesktop = useBreakpoint() === 'desktop';
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const deliveryId = params.get('delivery');
  const fromAccepted = params.get('from') === 'accepted';
  const tab: ListTab = params.get('tab') === 'accepted' ? 'accepted' : 'expected';
  // Режим «новой несохранённой формы»: запись в IDB/БД ещё не создана.
  // UUID лежит в deliveryId, а флаг new=1 отключает deliveryQuery и активирует
  // ветку creation в save-mutation (первый «Сохранить» создаёт документ filled).
  const isNew = params.get('new') === '1';
  const updIdFromUrl = params.get('upd');

  // Для inspector_kpp объект фиксирован значением из БД; селект блокируется,
  // а сервер всё равно перепишет siteId в запросе на сохранение.
  const authUser = useAuthStore((s) => s.user);
  const isInspector = authUser?.role === 'inspector_kpp';
  const inspectorSiteId = isInspector ? (authUser?.siteId ?? null) : null;
  const inspectorWithoutSite = isInspector && !inspectorSiteId;

  const [items, setItems] = useState<DraftItem[]>([]);
  // Inline-edit названия материала: clientKey строки в режиме редактирования.
  // Клик по тексту → инпут с autoFocus; blur/Enter → обратно в текст.
  // Для позиций из справочника материалов (materialId !== null) редактирование
  // отключено — название берётся из материала и не должно править в приёмке.
  const [editingNameKey, setEditingNameKey] = useState<string | null>(null);
  const [plate, setPlate] = useState('');
  const [comment, setComment] = useState('');
  const [siteId, setSiteId] = useState<string | null>(inspectorSiteId);
  // Получатель приёмки: подрядчик ИЛИ МОЛ собственной бригады. CHECK на сервере
  // не позволяет заполнить оба одновременно. Переключатель — Segmented в карточке.
  const [recipientKind, setRecipientKind] = useState<'counterparty' | 'mol'>('counterparty');
  const [contractorId, setContractorId] = useState<string | null>(null);
  const [recipientMolId, setRecipientMolId] = useState<string | null>(null);
  const [selectedUpd, setSelectedUpd] = useState<SourceDocument | null>(null);
  const [linkUpdOpen, setLinkUpdOpen] = useState(false);
  const [linkUpdError, setLinkUpdError] = useState<string | null>(null);

  // Эти хуки должны быть ДО любых early-return'ов ниже по компоненту
  // (см. строки `if (deliveryId && !loadedDelivery) return …` и
  // `if (deliveryId) return …`). Иначе порядок хуков меняется между
  // list- и edit-режимом и React даёт error #310 (Rendered fewer hooks
  // than during the previous render). `trashOn` / `isAdminUser` —
  // derived, не хуки, но логически живут вместе с useEffect ниже.
  const [exporting, setExporting] = useState(false);
  const trashOn = params.get('trash') === '1';
  const isAdminUser = authUser?.role === 'admin';
  // Корзина — только для admin. Если manager введёт ?trash=1 в URL руками,
  // сбрасываем параметр (DeliveriesHistory читает trash из URL).
  useEffect(() => {
    if (!isAdminUser && trashOn) {
      const p = new URLSearchParams(params);
      p.delete('trash');
      setParams(p, { replace: true });
    }
  }, [isAdminUser, trashOn, params, setParams]);

  // ID приёмки, для которой уже выполнили первичную гидратацию формы из server data.
  // Защищает локальные правки (plate/comment/items) от затирания при рефетче
  // ['deliveries', id] — рефетч происходит, например, после загрузки/удаления фото.
  const hydratedIdRef = useRef<string | null>(null);

  // Сбрасываем локальное состояние при выходе из формы. Для inspector_kpp
  // siteId восстанавливается из назначенного объекта (не очищается).
  useEffect(() => {
    if (!deliveryId) {
      setItems([]);
      setPlate('');
      setComment('');
      setSiteId(inspectorSiteId);
      setRecipientKind('counterparty');
      setContractorId(null);
      setRecipientMolId(null);
      setSelectedUpd(null);
      hydratedIdRef.current = null;
    }
  }, [deliveryId, inspectorSiteId]);

  const sitesQuery = useQuery({
    queryKey: ['sites', 'all'],
    queryFn: () => api.get<{ items: Site[]; total: number }>('/sites?activeOnly=true&limit=200'),
  });

  const counterpartiesQuery = useQuery({
    queryKey: ['counterparties', 'contractor'],
    queryFn: () =>
      api.get<{ items: Counterparty[]; total: number }>(
        '/counterparties?limit=500&role=contractor',
      ),
  });
  // source=fot — берём только тех МОЛ, что синхронизированы из внешней
  // БД ФОТ (см. /api/v1/mol + domain/mol/syncFotMol.ts). Это тот же
  // набор, что отображается в Справочники → МОЛ; ручной локальный
  // справочник в выпадающем списке Получатель не показываем.
  const responsiblePersonsQuery = useQuery({
    queryKey: ['responsible-persons', 'active', 'fot'],
    queryFn: () =>
      api.get<{ items: ResponsiblePerson[]; total: number }>(
        '/responsible-persons?activeOnly=true&source=fot&limit=500',
      ),
  });

  const sites = sitesQuery.data?.items ?? [];
  const counterparties = counterpartiesQuery.data?.items ?? [];
  const responsiblePersons = responsiblePersonsQuery.data?.items ?? [];

  const deliveryQuery = useQuery({
    queryKey: ['deliveries', deliveryId],
    queryFn: async (): Promise<Delivery> => {
      if (!deliveryId) throw new Error('no delivery id');
      try {
        const remote = await api.get<Delivery>(`/deliveries/${deliveryId}`);
        await upsertServerSnapshot([remote]);
        return remote;
      } catch (err) {
        // Offline или 404 — отдаём локальный snapshot, если он есть
        const local = await getDelivery(deliveryId);
        const eff = local ? effectiveState(local) : null;
        if (eff) return eff;
        throw err;
      }
    },
    // В режиме isNew записи на сервере и в IDB ещё нет — запрос дал бы 404
    // и завис бы в isLoading. Форма работает только с локальным state.
    enabled: !!deliveryId && !isNew,
    // Пока форма приёмки открыта — поллим каждые 5 сек. Это гарантированный
    // fallback к SSE-инвалидации (см. services/invalidation.ts): в проде
    // events-stream может молчать из-за прокси/буферизации/cookie, а ждать
    // 60-секундный syncLoop для прихода stage2-комментария, обновлённых
    // материалов или статуса confirmed_mol от мобильного — слишком долго.
    // Запросы /deliveries/:id лёгкие; react-query сам остановит polling,
    // когда вкладка скрыта (refetchIntervalInBackground=false по умолчанию).
    refetchInterval: 5000,
  });

  // Лёгкие count-запросы для счётчиков на вкладках Ожидаемые/Принятые.
  // ОБЯЗАТЕЛЬНО объявляются вместе с остальными хуками — выше любых early
  // return'ов формы. Иначе при переходе между списком и карточкой меняется
  // количество вызванных хуков (React error #300). limit=1 — сервер вернёт
  // только total, тело ответа крошечное.
  const expectedCountQuery = useQuery({
    queryKey: ['source-documents', 'unaccepted-upd-count', 'inbound'],
    queryFn: () =>
      api.get<{ total: number }>(
        '/source-documents?kind=upd,transport_waybill,os2_transfer&direction=inbound&unaccepted=true&limit=1',
      ),
  });
  const acceptedCountQuery = useQuery({
    queryKey: ['deliveries', 'count', 'active'],
    queryFn: () => api.get<{ total: number }>('/deliveries?limit=1'),
  });

  // Детали УПД для преднаполнения формы в режиме isNew. Сначала пробуем IndexedDB
  // (его наполняет pullSync), при пустом кеше — серверный fallback. Грузится один
  // раз на updIdFromUrl, после чего гидратация заполняет items/contractor/site.
  const newFromUpdQuery = useQuery({
    queryKey: ['source-document-detail', updIdFromUrl],
    queryFn: async (): Promise<SourceDocumentDetail> => {
      if (!updIdFromUrl) throw new Error('no upd id');
      const dbi = await db();
      const cached = await dbi.get('source_documents', updIdFromUrl);
      if (cached) return cached;
      return await api.get<SourceDocumentDetail>(`/source-documents/${updIdFromUrl}`);
    },
    enabled: isNew && !!updIdFromUrl,
  });

  // Производное значение: react-query — единственный источник истины для
  // загруженной приёмки. Использование useState + setLoadedDelivery в useEffect
  // приводило к гонке рендера (data уже есть, isLoading=false, но state ещё null).
  // В режиме isNew серверной записи ещё нет — собираем «виртуальный» Delivery
  // из дефолтов, чтобы существующий JSX (status, photos, version и т. д.) работал
  // без переписки. Фактические items/plate/comment живут в локальном state формы.
  const virtualDelivery: Delivery | null = useMemo(() => {
    if (!isNew || !deliveryId) return null;
    // До первого «Сохранить» статус виртуальной приёмки — not_filled
    // независимо от наличия УПД. Признак «без документа» отображается
    // отдельным тегом и вычисляется из sourceDocumentIds.
    const initialStatus: Status = {
      id: '',
      entityType: 'delivery',
      code: 'not_filled',
      label: 'Не оформлена',
      color: 'orange',
      sortOrder: 10,
    };
    return {
      id: deliveryId,
      // displayId назначается БД при INSERT через sequence (см. миграцию
      // 0059). У виртуальной (ещё не сохранённой) приёмки его нет;
      // ставим 0 как маркер «не присвоено», UI просто не показывает
      // «#0» в заголовке для isNew (см. OperationsPage title).
      displayId: 0,
      status: initialStatus,
      siteId: inspectorSiteId ?? SYSTEM_SITE_ID,
      supplierId: null,
      contractorId: null,
      recipientMolId: null,
      vehiclePlate: null,
      driverName: null,
      arrivedAt: null,
      inspectorId: authUser?.id ?? null,
      comment: null,
      inTransit: false,
      isAssets: false,
      confirmedByMolUserId: null,
      confirmedByMolUserEmail: null,
      confirmedByMolAt: null,
      pendingDeletionAt: null,
      pendingDeletionByUserId: null,
      pendingDeletionByUserEmail: null,
      pendingDeletionReason: null,
      version: 0,
      sourceDocumentIds: updIdFromUrl ? [updIdFromUrl] : [],
      sourceShipmentId: null,
      sourceShipmentShippedAt: null,
      sourceShipmentSiteId: null,
      sourceShipmentSiteCode: null,
      items: [],
      photos: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }, [isNew, deliveryId, inspectorSiteId, updIdFromUrl, authUser?.id]);
  const loadedDelivery: Delivery | null = virtualDelivery ?? deliveryQuery.data ?? null;

  // Локальные IDB-записи фото для приёмки. Параллельно с серверным delivery.photos:
  // свежеснятое фото появляется в IDB немедленно (через capturePhoto), а в delivery.photos —
  // только после S3-upload + следующего pullSync. Чтобы превью не «пропадало» между этими
  // моментами, мерджим оба источника по id.
  const localPhotosQuery = useQuery({
    queryKey: ['photos-local', 'delivery', deliveryId],
    queryFn: async (): Promise<DeliveryPhoto[]> => {
      if (!deliveryId) return [];
      const dbi = await db();
      const all = await dbi
        .transaction('photos')
        .store.index('byDelivery')
        .getAll(deliveryId);
      return all
        .filter((p) => p.operationKind === 'delivery')
        .map((p) => ({
          id: p.id,
          kind: p.kind,
          stage: p.stage,
          s3Key: p.s3Key ?? '',
          thumbS3Key: p.thumbS3Key ?? null,
          contentHash: p.contentHash ?? null,
          takenAt: new Date(p.takenAt).toISOString(),
          // Локальное фото отображается из IDB blob, поэтому считаем его
          // «подтверждённым» с точки зрения PhotoThumb — иначе показался бы
          // оверлей «Загружается…», хотя превью уже есть.
          uploadedAt: new Date(p.takenAt).toISOString(),
        }));
    },
    enabled: !!deliveryId,
  });

  // В статусе confirmed_mol приёмка фактически read-only от мобилы —
  // юзер на портале её не редактирует. Поэтому при любом серверном
  // обновлении (поллинг ловит новый updatedAt) безопасно пересинхронизировать
  // local state: items/comment/plate/получатель. Без этого после Завершить
  // 2 Этап в мобиле материалы на портале «замораживались» до F5, хотя фото
  // и распарсенный comment подхватывались автоматически.
  const lastSyncedUpdatedAtRef = useRef<string | null>(null);

  useEffect(() => {
    const d = deliveryQuery.data;
    if (!d) return;

    // Условие гидратации:
    // 1) первая загрузка приёмки (deliveryId сменился);
    // 2) приёмка в confirmed_mol И серверный updatedAt сдвинулся —
    //    мобила что-то изменила (items, comment, поля), нужно подхватить.
    const isFirstHydration = hydratedIdRef.current !== d.id;
    const isReadOnlyConfirmed = d.status.code === 'confirmed_mol';
    const hasNewServerSnapshot =
      isReadOnlyConfirmed && lastSyncedUpdatedAtRef.current !== d.updatedAt;

    if (isFirstHydration || hasNewServerSnapshot) {
      hydratedIdRef.current = d.id;
      lastSyncedUpdatedAtRef.current = d.updatedAt;
      setPlate(d.vehiclePlate ?? '');
      setComment(d.comment ?? '');
      // siteId/contractorId подхватываются один раз — последующее редактирование
      // ведётся через локальный state. Для inspector_kpp siteId всегда фиксирован
      // на назначенном объекте.
      if (isInspector) {
        setSiteId(inspectorSiteId);
      } else {
        setSiteId((prev) => prev ?? (d.siteId === SYSTEM_SITE_ID ? null : d.siteId));
      }
      // Восстановление получателя: если в БД заполнен recipientMolId — это МОЛ,
      // иначе counterparty (даже если contractorId = null).
      if (d.recipientMolId) {
        setRecipientKind('mol');
        setRecipientMolId((prev) => prev ?? d.recipientMolId);
        setContractorId(null);
      } else {
        setRecipientKind('counterparty');
        setContractorId((prev) => prev ?? d.contractorId ?? null);
        setRecipientMolId(null);
      }
      setItems(
        d.items.map((it, idx) => ({
          clientKey: newKey(),
          serverId: it.id,
          lineNo: idx + 1,
          nameRaw: it.nameRaw,
          qtyPlanned: it.qtyPlanned,
          qtyActual: it.qtyActual,
          unit: it.unit,
          materialId: it.materialId,
          itemKind: it.itemKind,
          assetId: it.assetId,
          inventoryNumber: it.inventoryNumber,
          serialNumber: it.serialNumber,
          volumeM3: it.volumeM3 ?? null,
          massKg: it.massKg ?? null,
          price: it.price ?? null,
          vatRate: it.vatRate ?? null,
          vatSum: it.vatSum ?? null,
          volumeConfidence: it.volumeConfidence ?? null,
          groupName: it.groupName ?? null,
        })),
      );
    }
    // Подгрузка выбранного УПД идемпотентна по флагу !selectedUpd — оставляем
    // вне условия гидратации, чтобы она сработала и после первого получения данных,
    // и после смены selectedUpd.
    if (d.sourceDocumentIds.length > 0 && !selectedUpd) {
      api
        .get<SourceDocument>(`/source-documents/${d.sourceDocumentIds[0]}`)
        .then(setSelectedUpd)
        .catch(() => undefined);
    }
  }, [deliveryQuery.data, selectedUpd, isInspector, inspectorSiteId]);

  // Гидратация формы в режиме isNew по выбранному УПД. items/contractorId/siteId
  // подставляются из SourceDocumentDetail один раз — далее редактирование идёт
  // через локальный state. hydratedIdRef защищает от повторного затирания
  // пользовательских правок при рефетче (тот же приём, что и для серверного d).
  useEffect(() => {
    if (!isNew || !deliveryId) return;
    const detail = newFromUpdQuery.data;
    if (!detail) return;
    if (hydratedIdRef.current === deliveryId) return;
    hydratedIdRef.current = deliveryId;
    setSelectedUpd(detail);
    if (!isInspector) {
      setSiteId((prev) => prev ?? (detail.siteId === SYSTEM_SITE_ID ? null : detail.siteId));
    }
    // Получатель из УПД (диспетчер указал при загрузке): МОЛ имеет приоритет
    // над контрагентом, симметрично восстановлению из БД выше.
    if (detail.recipientMolId) {
      setRecipientKind('mol');
      setRecipientMolId((prev) => prev ?? detail.recipientMolId);
      setContractorId(null);
    } else {
      setContractorId((prev) => prev ?? detail.contractorId ?? null);
    }
    setItems(
      detail.items.map((it, idx) => ({
        clientKey: newKey(),
        // Это items УПД (sourceDocument), а не БД-строки приёмки.
        // На момент prefill приёмки эти строки ещё не сохранены как
        // delivery_items — serverId=null до первого сохранения.
        serverId: null,
        lineNo: idx + 1,
        nameRaw: it.nameRaw,
        qtyPlanned: it.qty,
        qtyActual: it.qty,
        unit: it.unit,
        materialId: it.materialId ?? null,
        itemKind: 'material' as const,
        assetId: null,
        inventoryNumber: null,
        serialNumber: null,
        volumeM3: it.volumeM3 ?? null,
        massKg: it.massKg ?? null,
        price: it.price ?? null,
        vatRate: it.vatRate ?? null,
        vatSum: it.vatSum ?? null,
        volumeConfidence: it.volumeConfidence ?? null,
        groupName: it.groupName ?? null,
      })),
    );
  }, [isNew, deliveryId, newFromUpdQuery.data, isInspector]);

  /**
   * Открывает форму новой пустой приёмки. UUID генерируется клиентом и кладётся в URL
   * под флагом new=1. Запись в IndexedDB и на сервере появится только при первом
   * нажатии «Сохранить» — до этого момента форма существует только как React state.
   */
  const createBlank = () => {
    if (inspectorWithoutSite) {
      message.error('Объект не назначен — обратитесь к администратору');
      return;
    }
    const id = crypto.randomUUID();
    navigate(`/operations?type=delivery&delivery=${id}&new=1`);
  };

  /**
   * Открывает форму новой приёмки, преднаполненной из выбранного УПД. Детали УПД
   * (items, supplierId, contractorId) подгружаются уже внутри формы по флагу new=1
   * и updIdFromUrl. Черновик в IDB/БД до явного «Сохранить» не создаётся.
   */
  const createFromUpd = (upd: SourceDocument) => {
    if (inspectorWithoutSite) {
      message.error('Объект не назначен — обратитесь к администратору');
      return;
    }
    const id = crypto.randomUUID();
    navigate(`/operations?type=delivery&delivery=${id}&new=1&upd=${upd.id}`);
  };

  // Фабрика photoProps под конкретный stage ('before' = 1 Этап,
  // 'after' = 2 Этап). Веб даёт менеджеру явный выбор этапа, чтобы он
  // мог добавить фото в правильный раздел независимо от статуса
  // приёмки (раньше stage маппился по status.code — но это путало,
  // если статус приёмки ещё не дошёл до confirmed_mol, а нужно
  // дослать фото 2 Этапа после фактической подписи МОЛ).
  const makePhotoProps = (stage: 'before' | 'after'): UploadProps => ({
    accept: 'image/*',
    capture: 'environment',
    showUploadList: false,
    beforeUpload: async (file) => {
      if (!deliveryId) return false;
      try {
        const { uploadPromise } = await capturePhoto(
          'delivery',
          deliveryId,
          file,
          // Тип по этапу, симметрично мобиле: 1 Этап (before) — «cargo»
          // (груз/документ), 2 Этап (after) — «vehicle» (машина). Это же
          // включает подпись «Груз/машина» в галерее 2 Этапа (showLabels).
          stage === 'after' ? 'vehicle' : 'cargo',
          stage,
        );
        message.success(`Фото добавлено к ${stage === 'before' ? '1 Этапу' : '2 Этапу'}`);
        // Локальный список фото перечитывается сразу из IDB, серверный delivery.photos —
        // после S3-upload + следующего pullSync. Галерея мерджит оба источника по id.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['photos-local', 'delivery', deliveryId] }),
          queryClient.invalidateQueries({ queryKey: ['deliveries', deliveryId] }),
        ]);
        // После завершения upload IDB-id фото меняется на server-id (см.
        // photoPipeline.uploadPhoto). Без повторного invalidate galery читает
        // запись по old-id и зависает на «Загружается…».
        void uploadPromise.then(() => {
          void queryClient.invalidateQueries({
            queryKey: ['photos-local', 'delivery', deliveryId],
          });
          void queryClient.invalidateQueries({ queryKey: ['deliveries', deliveryId] });
        });
        void runSync();
      } catch (err) {
        message.error(`Не удалось добавить фото: ${(err as Error).message}`);
      }
      return false;
    },
  });

  const photoPropsStage1 = makePhotoProps('before');
  const photoPropsStage2 = makePhotoProps('after');
  // Кнопка «Добавить фото: 2 этап» доступна, как только 1 Этап оформлен
  // (status filled), и остаётся доступной после подтверждения МОЛ
  // (confirmed_mol). Это даёт менеджеру дослать фото 2 Этапа с портала
  // (например, «машина уже уехала»), не дожидаясь подписи МОЛ. В not_filled
  // (1 Этап ещё не сдан) кнопка остаётся заблокированной.
  const stage2Enabled =
    loadedDelivery?.status.code === 'filled' ||
    loadedDelivery?.status.code === 'confirmed_mol';

  const updateField = (key: string, patch: Partial<DraftItem>) => {
    setItems((prev) => prev.map((it) => (it.clientKey === key ? { ...it, ...patch } : it)));
  };

  // Удаление строки материала из локального state. Сохранение приёмки
  // (POST /deliveries) делает wipe-and-reinsert по deliveryId, поэтому
  // удаление здесь автоматически прорастает на сервер при следующем save.
  // Для несохранённых (serverId=null) строк удаляется сразу — у пользователя
  // нет данных, которые он мог бы потерять. Для сохранённых вызывающий код
  // обязан показать Popconfirm (см. ниже в колонке actions).
  const removeItem = (key: string) => {
    setItems((prev) => prev.filter((it) => it.clientKey !== key));
  };

  const addItem = () => {
    setItems((prev) => [
      ...prev,
      {
        clientKey: newKey(),
        serverId: null,
        lineNo: prev.length + 1,
        nameRaw: '',
        qtyPlanned: null,
        qtyActual: null,
        unit: 'шт',
        materialId: null,
        itemKind: 'material',
        assetId: null,
        inventoryNumber: null,
        serialNumber: null,
        volumeM3: null,
        massKg: null,
        price: null,
        vatRate: null,
        vatSum: null,
        volumeConfidence: null,
        groupName: null,
      },
    ]);
  };

  const buildPatch = (nextCode: DeliveryStatusCode): Partial<Delivery> => {
    if (!loadedDelivery) throw new Error('Приёмка ещё не загружена');
    const nextStatus: Status = { ...loadedDelivery.status, code: nextCode };
    // Если серверный comment структурирован (multiline «1 Этап:…/2 Этап:…»
    // от мобильного клиента), отправляем его как есть, минуя local state.
    // Иначе мы рискуем затереть свежее обновление от мобилы (2 Этап,
    // дописанный после открытия страницы): refetch не обновляет local
    // state, save отправил бы устаревший текст.
    const serverComment = loadedDelivery.comment ?? '';
    const serverParsed = parseDeliveryComment(serverComment);
    const effectiveComment = serverParsed.hasStructure
      ? serverComment || null
      : (comment || null);
    return {
      status: nextStatus,
      siteId: siteId ?? loadedDelivery.siteId,
      supplierId: selectedUpd?.supplierId ?? loadedDelivery.supplierId ?? null,
      contractorId: recipientKind === 'counterparty' ? contractorId : null,
      recipientMolId: recipientKind === 'mol' ? recipientMolId : null,
      vehiclePlate: plate || null,
      arrivedAt: loadedDelivery.arrivedAt ?? new Date().toISOString(),
      comment: effectiveComment,
      sourceDocumentIds: selectedUpd
        ? [selectedUpd.id]
        : loadedDelivery.sourceDocumentIds,
      items: items
        .filter((i) => i.nameRaw.trim().length > 0)
        .map((i) => {
          const computed = computeVatSum(i);
          return {
            id: crypto.randomUUID(),
            itemKind: i.itemKind,
            materialId: i.itemKind === 'asset' ? null : i.materialId,
            assetId: i.itemKind === 'asset' ? i.assetId : null,
            inventoryNumber: i.inventoryNumber,
            serialNumber: i.serialNumber,
            nameRaw: i.nameRaw,
            qtyPlanned: i.qtyPlanned,
            qtyActual: i.qtyActual,
            unit: i.unit,
            comment: null,
            lineNo: i.lineNo,
            volumeM3: i.volumeM3,
            massKg: i.massKg,
            price: i.price,
            vatRate: i.vatRate,
            vatSum: computed !== null ? computed.toFixed(2) : (i.vatSum ?? null),
            volumeConfidence: i.volumeConfidence,
            groupName: i.groupName,
          };
        }),
    };
  };

  const persistStatus = async (nextCode: DeliveryStatusCode) => {
    if (!loadedDelivery) throw new Error('Приёмка ещё не загружена');
    await applyLocalEdit(loadedDelivery.id, buildPatch(nextCode));
    await enqueueMutation({
      id: crypto.randomUUID(),
      kind: 'delivery_upsert',
      entityId: loadedDelivery.id,
      baseVersion: loadedDelivery.version,
      payload: null,
    });
    // Ждём пока mutation физически уйдёт на сервер и придёт свежий
    // snapshot через pullSync. Без await invalidateQueries в onSuccess
    // делает refetch /deliveries раньше, чем mutation push доехал, и
    // таблица показывает старый siteId/contractorId до F5.
    await runSync();
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!loadedDelivery) throw new Error('Приёмка ещё не загружена');
      // Обычное «Сохранить» не должно «понижать» подтверждённый документ.
      // Без УПД оформить как filled нельзя — сервер всё равно понизит,
      // но локальный optimistic-state должен совпадать.
      const currentCode = loadedDelivery.status.code as DeliveryStatusCode;
      const nextCode: DeliveryStatusCode =
        currentCode === 'confirmed_mol'
          ? 'confirmed_mol'
          : selectedUpd
            ? 'filled'
            : 'not_filled';
      await persistStatus(nextCode);
    },
    onSuccess: () => {
      message.success('Приёмка сохранена');
      void queryClient.invalidateQueries({ queryKey: ['deliveries'] });
      void queryClient.invalidateQueries({ queryKey: ['reports', 'operations-counters'] });
      navigate('/operations?type=delivery&tab=accepted');
    },
    onError: (err: Error) => message.error(err.message),
  });

  const confirmMol = useMutation({
    mutationFn: async () => {
      await persistStatus('confirmed_mol');
    },
    onSuccess: () => {
      message.success('Приёмка подтверждена МОЛ');
      void queryClient.invalidateQueries({ queryKey: ['deliveries'] });
      void queryClient.invalidateQueries({ queryKey: ['reports', 'operations-counters'] });
      navigate('/operations?type=delivery&tab=accepted');
    },
    onError: (err: Error) => message.error(err.message),
  });

  // Ручная привязка УПД к существующей приёмке (только admin/manager).
  // Использует выделенный endpoint POST /deliveries/:id/link-source —
  // он атомарно (1) INSERT в delivery_sources и (2) MERGE items УПД к
  // существующим (с дедупом по nameRaw+unit+qty), НЕ удаляя ручные
  // материалы и НЕ меняя статус приёмки (важно для приёмок, уже
  // подтверждённых МОЛ через мобильное приложение). Старый путь POST
  // /deliveries с items:[] делал destructive replace и сбрасывал
  // подтверждение МОЛ — это уничтожало строки, добавленные в мобиле
  // на 1/2 этапах. IDB не трогаем: операция на портале, локальный
  // snapshot инспектора обновится при следующем pullSync.
  const linkUpd = useMutation({
    mutationFn: async (upd: SourceDocument): Promise<Delivery> => {
      if (!loadedDelivery) throw new Error('Приёмка ещё не загружена');
      return await api.post<Delivery>(
        `/deliveries/${loadedDelivery.id}/link-source`,
        { sourceDocumentId: upd.id },
      );
    },
    onSuccess: async (dto) => {
      await upsertServerSnapshot([dto]);
      message.success('УПД привязана');
      setLinkUpdOpen(false);
      setLinkUpdError(null);
      hydratedIdRef.current = null;
      void queryClient.invalidateQueries({ queryKey: ['deliveries', deliveryId] });
      void queryClient.invalidateQueries({ queryKey: ['deliveries'] });
      void queryClient.invalidateQueries({ queryKey: ['reports', 'operations-counters'] });
      void queryClient.invalidateQueries({ queryKey: ['source-documents'] });
    },
    onError: (err: Error) => {
      setLinkUpdError(err.message);
    },
  });

  // Точечный PATCH флагов inTransit/isAssets через
  // /api/v1/deliveries/:id/flags (backend меняет ТОЛЬКО эти поля и
  // updated_at). НЕ запускает items wipe-and-reinsert, как полный
  // POST /deliveries, и не зависит от local-state appearance items.
  const patchFlags = useMutation({
    mutationFn: async (patch: { inTransit?: boolean; isAssets?: boolean }) => {
      if (!loadedDelivery) throw new Error('Приёмка ещё не загружена');
      return api.patch<Delivery>(`/deliveries/${loadedDelivery.id}/flags`, patch);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['deliveries', deliveryId] });
      void queryClient.invalidateQueries({ queryKey: ['deliveries'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const markDel = useMutation({
    mutationFn: async (reason: string | null) => {
      if (!loadedDelivery) throw new Error('Приёмка ещё не загружена');
      return markDeliveryDeletion(loadedDelivery.id, reason);
    },
    onSuccess: () => {
      message.success('Помечено на удаление');
      void queryClient.invalidateQueries({ queryKey: ['deliveries', deliveryId] });
      void queryClient.invalidateQueries({ queryKey: ['deliveries'] });
      void queryClient.invalidateQueries({ queryKey: ['reports', 'operations-counters'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const unmarkDel = useMutation({
    mutationFn: async () => {
      if (!loadedDelivery) throw new Error('Приёмка ещё не загружена');
      return unmarkDeliveryDeletion(loadedDelivery.id);
    },
    onSuccess: () => {
      message.success('Пометка снята');
      void queryClient.invalidateQueries({ queryKey: ['deliveries', deliveryId] });
      void queryClient.invalidateQueries({ queryKey: ['deliveries'] });
      void queryClient.invalidateQueries({ queryKey: ['reports', 'operations-counters'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const hardDel = useMutation({
    mutationFn: async () => {
      if (!loadedDelivery) throw new Error('Приёмка ещё не загружена');
      return hardDeleteDelivery(loadedDelivery.id);
    },
    onSuccess: () => {
      message.success('Приёмка удалена');
      void queryClient.invalidateQueries({ queryKey: ['deliveries'] });
      void queryClient.invalidateQueries({ queryKey: ['reports', 'operations-counters'] });
      void queryClient.invalidateQueries({ queryKey: ['source-documents'] });
      navigate('/operations?type=delivery&tab=accepted&trash=1');
    },
    onError: (err: Error) => message.error(err.message),
  });

  const [markReason, setMarkReason] = useState('');

  // Мерджим серверные photos и локальные IDB-записи по id. Это покрывает оба сценария:
  // (а) черновик ещё не на сервере — фото есть только локально;
  // (б) фото только что снято и ещё не подтянуто очередным pullSync.
  const mergedPhotos: DeliveryPhoto[] = useMemo(() => {
    const server = loadedDelivery?.photos ?? [];
    const local = localPhotosQuery.data ?? [];
    return [
      ...server,
      ...local.filter((lp) => !server.some((sp) => sp.id === lp.id)),
    ];
  }, [loadedDelivery?.photos, localPhotosQuery.data]);
  const photosCount = mergedPhotos.length;
  // Разделение «До» (1-й этап на КПП) / «После» (после подтверждения МОЛ).
  // Источник истины — поле stage, проставляемое мобильным клиентом при
  // загрузке. Старые фото и фото с веба без явного этапа считаем «До».
  const beforePhotos = useMemo(
    () => mergedPhotos.filter((p) => p.stage !== 'after'),
    [mergedPhotos],
  );
  const afterPhotos = useMemo(
    () => mergedPhotos.filter((p) => p.stage === 'after'),
    [mergedPhotos],
  );
  // Имя поставщика (counterparty.name) для чипа в шапке. Хук вызывается
  // безусловно — это требование React rules-of-hooks. Получает supplierId
  // у delivery (null до загрузки) и список counterparties для лукапа.
  const supplierDisplayName = useSupplierDisplayName(
    loadedDelivery?.supplierId ?? null,
    counterparties,
  );
  const verifyReason: string | null = (() => {
    const reasons: string[] = [];
    if (!siteId) reasons.push('Выберите объект');
    if (!plate.trim()) reasons.push('Заполните госномер');
    if (photosCount === 0) reasons.push('Сделайте хотя бы одно фото');
    return reasons.length ? reasons.join(' · ') : null;
  })();

  type Column = NonNullable<TableProps<DraftItem>['columns']>[number];
  const columns: Column[] = useMemo(
    () => [
      {
        title: '№',
        key: 'idx',
        width: 56,
        render: (_: unknown, __: DraftItem, idx: number) => idx + 1,
      },
      {
        title: 'Название',
        dataIndex: 'nameRaw',
        render: (_: unknown, r: DraftItem) => {
          const locked = !!r.materialId;
          if (!locked && editingNameKey === r.clientKey) {
            return (
              <Input.TextArea
                autoSize={{ minRows: 1, maxRows: 4 }}
                autoFocus
                value={r.nameRaw}
                placeholder="Наименование"
                onChange={(e) => updateField(r.clientKey, { nameRaw: e.target.value })}
                onBlur={() => setEditingNameKey(null)}
              />
            );
          }
          return (
            <div
              onClick={() => {
                if (!locked) setEditingNameKey(r.clientKey);
              }}
              style={{
                cursor: locked ? 'default' : 'text',
                whiteSpace: 'pre-wrap',
                minHeight: 22,
                padding: '4px 0',
              }}
            >
              {r.nameRaw || (
                <Typography.Text type="secondary">— нажмите, чтобы заполнить —</Typography.Text>
              )}
            </div>
          );
        },
      },
      {
        title: 'План',
        width: 110,
        render: (_: unknown, r: DraftItem) => (
          <InputNumber
            size="small"
            min={0}
            style={{ width: '100%' }}
            value={r.qtyPlanned !== null && r.qtyPlanned !== '' ? Number(r.qtyPlanned) : null}
            onChange={(v) =>
              updateField(r.clientKey, {
                qtyPlanned: v !== null && v !== undefined ? String(v) : null,
              })
            }
          />
        ),
      },
      {
        title: 'Факт',
        width: 130,
        render: (_: unknown, r: DraftItem) => (
          <InputNumber
            size="small"
            min={0}
            style={{ width: '100%' }}
            value={r.qtyActual !== null && r.qtyActual !== '' ? Number(r.qtyActual) : null}
            onChange={(v) =>
              updateField(r.clientKey, {
                qtyActual: v !== null && v !== undefined ? String(v) : null,
              })
            }
          />
        ),
      },
      {
        title: 'Ед.',
        width: 100,
        render: (_: unknown, r: DraftItem) => (
          <UnitSelect
            value={r.unit}
            onChange={(v) => updateField(r.clientKey, { unit: v ?? '' })}
            style={{ width: '100%' }}
          />
        ),
      },
      {
        title: 'Цена',
        width: 160,
        render: (_: unknown, r: DraftItem) => (
          <InputNumber
            size="small"
            min={0}
            style={{ width: '100%' }}
            value={r.price !== null && r.price !== '' ? Number(r.price) : null}
            onChange={(v) =>
              updateField(r.clientKey, {
                price: v !== null && v !== undefined ? String(v) : null,
              })
            }
            decimalSeparator=","
            formatter={inputNumberFormatterRu}
            parser={inputNumberParserRu}
            addonAfter="₽"
          />
        ),
      },
      {
        title: 'Сумма НДС',
        width: 170,
        render: (_: unknown, r: DraftItem) => {
          // По умолчанию значение — auto-compute (qty × price × vatRate / 100).
          // Если пользователь ввёл руками — value сохраняется в r.vatSum и
          // показывается как override. При очистке поля (null) возвращается
          // к computed на следующем рендере.
          const stored = r.vatSum !== null && r.vatSum !== '' ? Number(r.vatSum) : null;
          const value = stored ?? computeVatSum(r);
          return (
            <InputNumber
              size="small"
              min={0}
              style={{ width: '100%' }}
              value={value}
              onChange={(v) =>
                updateField(r.clientKey, {
                  vatSum: v !== null && v !== undefined ? String(v) : null,
                })
              }
              decimalSeparator=","
              formatter={inputNumberFormatterRu}
              parser={inputNumberParserRu}
              addonAfter="₽"
            />
          );
        },
      },
      {
        // Сумма (без НДС) = qty × price. Только read-only отображение, чтобы
        // пользователь видел итог по строке как в Истории поступлений.
        // Редактируется через qty/price, не отдельно.
        title: 'Сумма',
        width: 140,
        align: 'right' as const,
        render: (_: unknown, r: DraftItem) => {
          const qty = toNum(r.qtyActual) ?? toNum(r.qtyPlanned);
          const price = toNum(r.price);
          if (qty === null || price === null) return '—';
          return formatMoneyRu(qty * price);
        },
      },
      {
        // Удаление строки материала. Для несохранённых строк (serverId=null,
        // только что добавлены через «+ Материал» или прилетели из УПД-prefill)
        // — удаление сразу, без подтверждения: пользователь не теряет данных.
        // Для сохранённых строк (есть serverId из БД) — Popconfirm, потому
        // что удаление можно «закрепить» только повторным сохранением, и
        // случайный клик стоит дороже.
        title: '',
        key: 'actions',
        width: 56,
        align: 'center' as const,
        render: (_: unknown, r: DraftItem) => {
          const btn = (
            <Button
              type="text"
              danger
              size="small"
              icon={<DeleteOutlined />}
              aria-label="Удалить строку"
            />
          );
          if (r.serverId) {
            return (
              <Popconfirm
                title="Удалить строку?"
                description="Изменение применится после сохранения приёмки."
                okText="Удалить"
                cancelText="Отмена"
                okButtonProps={{ danger: true }}
                onConfirm={() => removeItem(r.clientKey)}
              >
                {btn}
              </Popconfirm>
            );
          }
          return (
            <Button
              type="text"
              danger
              size="small"
              icon={<DeleteOutlined />}
              aria-label="Удалить строку"
              onClick={() => removeItem(r.clientKey)}
            />
          );
        },
      },
    ],
    [editingNameKey],
  );

  const cardRender = (r: DraftItem) => {
    const priceNum = toNum(r.price);
    const vatNum = computeVatSum(r);
    const locked = !!r.materialId;
    const isEditing = !locked && editingNameKey === r.clientKey;
    return (
      <div style={{ width: '100%' }}>
        <Typography.Text strong>№{r.lineNo}</Typography.Text>
        {isEditing ? (
          <Input.TextArea
            autoSize={{ minRows: 1, maxRows: 4 }}
            autoFocus
            value={r.nameRaw}
            placeholder="Наименование"
            onChange={(e) => updateField(r.clientKey, { nameRaw: e.target.value })}
            onBlur={() => setEditingNameKey(null)}
            style={{ marginTop: 4 }}
          />
        ) : (
          <div
            onClick={() => {
              if (!locked) setEditingNameKey(r.clientKey);
            }}
            style={{
              marginTop: 4,
              cursor: locked ? 'default' : 'text',
              whiteSpace: 'pre-wrap',
              minHeight: 22,
            }}
          >
            {r.nameRaw || (
              <Typography.Text type="secondary">— нажмите, чтобы заполнить —</Typography.Text>
            )}
          </div>
        )}
        <Row gutter={[8, 8]} style={{ marginTop: 8 }}>
          <Col span={8}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              План
            </Typography.Text>
            <div>{r.qtyPlanned !== null && r.qtyPlanned !== '' ? trimQty(r.qtyPlanned) : '—'}</div>
          </Col>
          <Col span={10}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Факт
            </Typography.Text>
            <InputNumber
              min={0}
              style={{ width: '100%' }}
              value={r.qtyActual !== null && r.qtyActual !== '' ? Number(r.qtyActual) : null}
              onChange={(v) =>
                updateField(r.clientKey, {
                  qtyActual: v !== null && v !== undefined ? String(v) : null,
                })
              }
            />
          </Col>
          <Col span={6}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Ед.
            </Typography.Text>
            <Input
              value={r.unit}
              onChange={(e) => updateField(r.clientKey, { unit: e.target.value })}
            />
          </Col>
        </Row>
        <Row gutter={[8, 8]} style={{ marginTop: 8 }}>
          <Col span={12}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Цена
            </Typography.Text>
            <div>{formatMoneyRu(priceNum)}</div>
          </Col>
          <Col span={12}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Сумма НДС
            </Typography.Text>
            <div>{formatMoneyRu(vatNum)}</div>
          </Col>
        </Row>
      </div>
    );
  };

  // ──────────── список / форма ────────────

  if (deliveryId && !loadedDelivery) {
    if (deliveryQuery.isError) {
      return (
        <Alert
          type="error"
          showIcon
          message="Не удалось загрузить приёмку"
          description={(deliveryQuery.error as Error)?.message ?? 'Неизвестная ошибка'}
        />
      );
    }
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
        <Spin size="large" />
      </div>
    );
  }

  // === Режим формы (открыта приёмка) ===
  if (deliveryId) {
    const pendingAt = loadedDelivery?.pendingDeletionAt ?? null;
    const isPending = pendingAt !== null;
    const isAdmin = authUser?.role === 'admin';
    const canUnmark =
      isAdmin || authUser?.id === (loadedDelivery?.pendingDeletionByUserId ?? null);
    return (
      <Space direction="vertical" size="middle" style={{ width: '100%', paddingBottom: isDesktop ? 0 : 96 }}>
        {!embedded && (
          <Space style={{ width: '100%' }} align="center">
            {fromAccepted && (
              <Button
                type="text"
                icon={<ArrowLeftOutlined />}
                onClick={() => navigate('/operations?type=delivery&tab=accepted')}
              />
            )}
            <Typography.Title level={3} style={{ margin: 0 }}>
              {isNew ? 'Новая приёмка' : 'Приёмка'}
            </Typography.Title>
            {isPending && loadedDelivery && (
              <PendingDeletionTag
                at={loadedDelivery.pendingDeletionAt}
                byEmail={loadedDelivery.pendingDeletionByUserEmail}
                reason={loadedDelivery.pendingDeletionReason}
              />
            )}
          </Space>
        )}
        {/* Внутри модалки тоже нужен PendingDeletionTag, если документ на
            удалении — Modal сам рисует общий заголовок, но статус «помечен
            на удаление» важно показать рядом с формой. */}
        {embedded && isPending && loadedDelivery && (
          <PendingDeletionTag
            at={loadedDelivery.pendingDeletionAt}
            byEmail={loadedDelivery.pendingDeletionByUserEmail}
            reason={loadedDelivery.pendingDeletionReason}
          />
        )}

        {isPending && loadedDelivery && (
          <Alert
            type="warning"
            showIcon
            message="Документ помечен на удаление"
            description={
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Typography.Text>
                  Пометил: {loadedDelivery.pendingDeletionByUserEmail ?? '—'} ·{' '}
                  {formatMolDate(loadedDelivery.pendingDeletionAt)}
                </Typography.Text>
                {loadedDelivery.pendingDeletionReason && (
                  <Typography.Text type="secondary">
                    Причина: {loadedDelivery.pendingDeletionReason}
                  </Typography.Text>
                )}
                <Space wrap>
                  {canUnmark && (
                    <Button
                      icon={<UndoOutlined />}
                      loading={unmarkDel.isPending}
                      onClick={() => unmarkDel.mutate()}
                    >
                      Восстановить
                    </Button>
                  )}
                  {isAdmin && (
                    <Popconfirm
                      title="Удалить навсегда?"
                      description="Запись, фото и связи с УПД будут стёрты. УПД вернётся в «Ожидаемые»."
                      okText="Да, удалить"
                      cancelText="Нет"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => hardDel.mutate()}
                    >
                      <Button danger icon={<DeleteOutlined />} loading={hardDel.isPending}>
                        Удалить навсегда
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              </Space>
            }
          />
        )}

        {/* Inline-шапка из чипов: визуально как в read-only ViewModal'е,
            но клик по чипу открывает Popover с редактором (Select/Input).
            Экономит ~50-80px вертикально по сравнению с grid + label —
            больше места под Фото и Материалы. */}
        {(() => {
          const siteLabel = (() => {
            const s = sites.find((x) => x.id === siteId);
            return s ? `${s.code} · ${s.name}` : null;
          })();
          const recipientLabel = (() => {
            if (recipientKind === 'counterparty') {
              const c = counterparties.find((x) => x.id === contractorId);
              return c ? `Подрядчик: ${c.name}` : null;
            }
            const m = responsiblePersons.find((x) => x.id === recipientMolId);
            return m ? `МОЛ: ${m.fullName}` : null;
          })();
          return (
            <Space wrap size={[6, 6]} style={{ marginBottom: 8 }}>
              <InlineEditChip
                label="Объект"
                value={siteLabel}
                required
                disabled={isInspector}
                width={320}
              >
                {(close) => (
                  <Select<string>
                    autoFocus
                    style={{ width: '100%' }}
                    placeholder="Выберите объект"
                    value={siteId ?? undefined}
                    onChange={(v) => {
                      setSiteId(v);
                      close();
                    }}
                    showSearch
                    optionFilterProp="label"
                    loading={sitesQuery.isLoading}
                    options={sites.map((s) => ({
                      value: s.id,
                      label: `${s.code} · ${s.name}`,
                    }))}
                    notFoundContent={
                      <Typography.Text type="secondary">
                        Объектов нет — заведите в Справочниках
                      </Typography.Text>
                    }
                  />
                )}
              </InlineEditChip>

              <InlineEditChip
                label="Получатель"
                value={recipientLabel}
                width={320}
              >
                {(close) => (
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    <Segmented
                      block
                      size="small"
                      options={[
                        { label: 'Подрядчик', value: 'counterparty' },
                        { label: 'МОЛ', value: 'mol' },
                      ]}
                      value={recipientKind}
                      onChange={(v) => {
                        const next = v as 'counterparty' | 'mol';
                        setRecipientKind(next);
                        if (next === 'counterparty') setRecipientMolId(null);
                        else setContractorId(null);
                      }}
                    />
                    {recipientKind === 'counterparty' ? (
                      <Select<string>
                        autoFocus
                        style={{ width: '100%' }}
                        placeholder="— не указан —"
                        value={contractorId ?? undefined}
                        onChange={(v) => {
                          setContractorId(v ?? null);
                          close();
                        }}
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        loading={counterpartiesQuery.isLoading}
                        options={counterparties.map((c) => ({
                          value: c.id,
                          label: c.name,
                        }))}
                      />
                    ) : (
                      <Select<string>
                        autoFocus
                        style={{ width: '100%' }}
                        placeholder="— не указан —"
                        value={recipientMolId ?? undefined}
                        onChange={(v) => {
                          setRecipientMolId(v ?? null);
                          close();
                        }}
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        loading={responsiblePersonsQuery.isLoading}
                        options={responsiblePersons.map((m) => ({
                          value: m.id,
                          label: m.fullName,
                        }))}
                      />
                    )}
                  </Space>
                )}
              </InlineEditChip>

              {/* Чип «Поставщик»: симметрично с отгрузкой. Если у приёмки
                  привязана УПД (sourceDocumentIds.length > 0), чип
                  read-only — имя поставщика приходит из УПД (приоритет
                  УПД, см. бэк endpoint /supplier-from-directory).
                  Иначе менеджер выбирает из Справочника → Поставщики. */}
              {loadedDelivery && deliveryId && (
                <SupplierChip
                  entity="delivery"
                  entityId={deliveryId}
                  hasUpd={(loadedDelivery.sourceDocumentIds?.length ?? 0) > 0}
                  displayName={supplierDisplayName}
                  invalidateQueryKey={['deliveries', deliveryId]}
                  disabled={isInspector}
                />
              )}

              <InlineEditChip
                label="Госномер"
                value={plate || null}
                placeholder="— не указан —"
                width={200}
              >
                {(close) => (
                  <Input
                    autoFocus
                    size="small"
                    placeholder="А123ВВ77"
                    value={plate}
                    onChange={(e) => setPlate(e.target.value.toUpperCase())}
                    onPressEnter={close}
                    onBlur={close}
                    autoCapitalize="characters"
                  />
                )}
              </InlineEditChip>

              {/* УПД / Перемещение — read-only чип: значение приходит из УПД
                  (либо при создании, либо после привязки), inline-редактирования
                  тут нет. Tag-стиль как у read-only ViewModal. */}
              {loadedDelivery?.sourceShipmentId ? (
                <>
                  <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      Перемещение:
                    </Typography.Text>{' '}
                    <Typography.Text strong style={{ fontSize: 12 }}>
                      с объекта {loadedDelivery.sourceShipmentSiteCode ?? '—'}
                    </Typography.Text>
                  </Tag>
                  <Tag style={{ marginInlineEnd: 0 }}>
                    Отгружено: {formatMolDate(loadedDelivery.sourceShipmentShippedAt)}
                  </Tag>
                  <Tag style={{ marginInlineEnd: 0 }}>
                    Принято: {formatMolDate(loadedDelivery.arrivedAt)}
                  </Tag>
                </>
              ) : selectedUpd ? (
                <>
                  <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      УПД:
                    </Typography.Text>{' '}
                    <Typography.Text strong style={{ fontSize: 12 }}>
                      {selectedUpd.docNumber ?? '— без номера —'}
                    </Typography.Text>
                  </Tag>
                  {selectedUpd.docDate && (
                    <Tag style={{ marginInlineEnd: 0 }}>
                      Дата документа: {selectedUpd.docDate}
                    </Tag>
                  )}
                  {selectedUpd.expectedDate && (
                    <Tag style={{ marginInlineEnd: 0 }}>
                      Дата поставки: {selectedUpd.expectedDate}
                    </Tag>
                  )}
                  {selectedUpd.totalSum && (
                    <Tag style={{ marginInlineEnd: 0 }}>
                      Сумма: {selectedUpd.totalSum} ₽
                    </Tag>
                  )}
                </>
              ) : (
                <Tag style={{ marginInlineEnd: 0 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    — без УПД —
                  </Typography.Text>
                  {!isInspector &&
                    loadedDelivery?.sourceDocumentIds.length === 0 &&
                    !isNew && (
                      <Button
                        type="link"
                        size="small"
                        icon={<LinkOutlined />}
                        style={{ padding: '0 4px', fontSize: 12 }}
                        onClick={() => {
                          setLinkUpdError(null);
                          setLinkUpdOpen(true);
                        }}
                      >
                        Привязать
                      </Button>
                    )}
                </Tag>
              )}
              {/* Транзит — admin/manager могут поставить/снять прямо
                  с портала (PATCH /deliveries/:id/flags). Inspector_kpp
                  видит только цветной чип при true (как раньше), править
                  не может — для него поле редактируется чекбоксом «Транзит»
                  на 1 этапе в мобиле. См. миграцию 0051 + новый FlagChip. */}
              {loadedDelivery && (
                <FlagChip
                  label="Транзит"
                  emoji="🚚"
                  color="orange"
                  value={loadedDelivery.inTransit}
                  disabled={isInspector || patchFlags.isPending}
                  loading={patchFlags.isPending}
                  onChange={(next) => patchFlags.mutate({ inTransit: next })}
                />
              )}
              {/* ОС — флаг «основные средства», рядом с Транзитом.
                  Источник на 1 этапе мобилы — чекбокс «ОС». См. миграцию
                  0065. Менеджер правит ошибочные значения с портала. */}
              {loadedDelivery && (
                <FlagChip
                  label="ОС"
                  emoji="📦"
                  color="purple"
                  value={loadedDelivery.isAssets}
                  disabled={isInspector || patchFlags.isPending}
                  loading={patchFlags.isPending}
                  onChange={(next) => patchFlags.mutate({ isAssets: next })}
                />
              )}
            </Space>
          );
        })()}

        <LinkSourceDocumentModal
          open={linkUpdOpen}
          onCancel={() => {
            if (!linkUpd.isPending) setLinkUpdOpen(false);
          }}
          onPick={(upd) => linkUpd.mutate(upd)}
          direction="inbound"
          siteId={loadedDelivery?.siteId === SYSTEM_SITE_ID ? null : loadedDelivery?.siteId ?? null}
          busy={linkUpd.isPending}
          error={linkUpdError}
        />

        {/* Отдельная карточка «Дата поставки» убрана: значение теперь
            показывается inline под УПД (см. шапку выше). Дата поставки —
            атрибут УПД, в edit-режиме приёмки она read-only. */}

        <Collapse
          size="small"
          // Если фото уже есть — свёрнут, экономит экранное пространство.
          // Если нет — раскрыт, чтобы пользователь сразу увидел «Снять фото»
          // (без этого Save disabled и не понятно почему — фото обязательно).
          defaultActiveKey={photosCount === 0 ? ['photos'] : []}
          items={[
            {
              key: 'photos',
              label: `Фото${photosCount ? ` (${photosCount})` : ''}`,
              children: (
                <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                  <Space wrap>
                    <Upload {...photoPropsStage1}>
                      <Button size="large" icon={<CameraOutlined />}>
                        Добавить фото: 1 этап
                      </Button>
                    </Upload>
                    {/* 2 этап — доступен с момента, как 1 Этап оформлен
                        (status filled), и далее в confirmed_mol. Заблокирован
                        только пока приёмка не оформлена (not_filled). Подсказку
                        в tooltip оставляем видимой, чтобы было понятно, почему
                        кнопка disabled. */}
                    <Tooltip
                      title={
                        stage2Enabled
                          ? null
                          : '2 Этап доступен после оформления 1 этапа'
                      }
                    >
                      <Upload {...photoPropsStage2} disabled={!stage2Enabled}>
                        <Button
                          size="large"
                          icon={<CameraOutlined />}
                          disabled={!stage2Enabled}
                        >
                          Добавить фото: 2 этап
                        </Button>
                      </Upload>
                    </Tooltip>
                    {photosCount === 0 && (
                      <Typography.Text type="secondary">
                        Хотя бы одно фото нужно для сохранения.
                      </Typography.Text>
                    )}
                  </Space>
                  {deliveryId && loadedDelivery && (
                    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                      <div>
                        <Typography.Text strong>
                          1 Этап {beforePhotos.length > 0 && `(${beforePhotos.length})`}
                        </Typography.Text>
                        {/* Время этапа справа от подписи. Берётся от фото
                            машины/груза (то время, что отображается на
                            watermark кадра); если фото машины нет — от
                            последнего документа. См. stageTime.ts. */}
                        {(() => {
                          const t = formatStageTime(beforePhotos);
                          return t ? (
                            <Typography.Text type="secondary" style={{ marginInlineStart: 8 }}>
                              Время: {t}
                            </Typography.Text>
                          ) : null;
                        })()}
                        <div style={{ marginTop: 8 }}>
                          {beforePhotos.length > 0 ? (
                            <PhotoGallery
                              deliveryId={deliveryId}
                              photos={beforePhotos}
                            />
                          ) : (
                            <Typography.Text type="secondary">
                              Фото 1-го этапа ещё нет.
                            </Typography.Text>
                          )}
                        </div>
                      </div>
                      <div>
                        <Typography.Text strong>
                          2 Этап {afterPhotos.length > 0 && `(${afterPhotos.length})`}
                        </Typography.Text>
                        {(() => {
                          const t = formatStageTime(afterPhotos);
                          return t ? (
                            <Typography.Text type="secondary" style={{ marginInlineStart: 8 }}>
                              Время: {t}
                            </Typography.Text>
                          ) : null;
                        })()}
                        <div style={{ marginTop: 8 }}>
                          {afterPhotos.length > 0 ? (
                            <PhotoGallery
                              deliveryId={deliveryId}
                              photos={afterPhotos}
                            />
                          ) : (
                            <Typography.Text type="secondary">
                              {loadedDelivery.status.code === 'confirmed_mol'
                                ? 'Фото 2-го этапа ещё нет.'
                                : 'МОЛ ещё не подтвердил приёмку.'}
                            </Typography.Text>
                          )}
                        </div>
                      </div>
                    </Space>
                  )}
                </Space>
              ),
            },
          ]}
        />

        <Card
          size="small"
          title={`Материалы${items.length ? ` (${items.length})` : ''}`}
          extra={
            <Button size="small" icon={<PlusOutlined />} onClick={addItem}>
              Материал
            </Button>
          }
          styles={{ body: { padding: 0 } }}
        >
          {items.length === 0 ? (
            <div style={{ padding: 16 }}>
              <Typography.Text type="secondary">
                Материалы можно не добавлять — приёмка сохранится со статусом «Не оформлена».
                Чтобы оформить, добавьте строки вручную или выберите УПД.
              </Typography.Text>
            </div>
          ) : (
            <ResponsiveTable<DraftItem>
              items={items}
              columns={columns}
              rowKey="clientKey"
              cardRender={cardRender}
            />
          )}
        </Card>

        {(() => {
          // Мобильный пишет comment как multiline с маркерами «1 Этап: "…"»,
          // «2 Этап: "…"», «Примечание: …» (см. parseDeliveryComment). Если
          // маркеры найдены — рендерим read-only-секции по этапам. Иначе
          // (приёмка, созданная/правленая с веба) — оставляем общий textarea.
          //
          // Источник для парсинга — серверный loadedDelivery.comment (он
          // обновляется при refetch каждые 5 сек), а не local state `comment`:
          // последний фиксируется при первой гидратации и не подтягивает
          // обновления от мобилы (например 2 Этап, дописанный после
          // открытия страницы — иначе появляется только после F5).
          const sourceComment =
            loadedDelivery?.comment !== undefined && loadedDelivery?.comment !== null
              ? loadedDelivery.comment
              : comment;
          const parsed = parseDeliveryComment(sourceComment);
          if (parsed.hasStructure) {
            const empty = (
              <Typography.Text type="secondary">— нет —</Typography.Text>
            );
            return (
              <Collapse
                size="small"
                // Свёрнут по умолчанию, как и Фото — экономия места в Modal.
                defaultActiveKey={[]}
                items={[
                  {
                    key: 'comment',
                    label: 'Комментарий',
                    children: (
                      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                        <div>
                          <Typography.Text strong>1 Этап</Typography.Text>
                          <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>
                            {parsed.stage1 ?? empty}
                          </div>
                        </div>
                        <div>
                          <Typography.Text strong>2 Этап</Typography.Text>
                          <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>
                            {parsed.stage2 ?? empty}
                          </div>
                        </div>
                        {parsed.note !== null && (
                          <div>
                            <Typography.Text strong>Примечание</Typography.Text>
                            <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>
                              {parsed.note}
                            </div>
                          </div>
                        )}
                      </Space>
                    ),
                  },
                ]}
              />
            );
          }
          return (
            <Collapse
              size="small"
              items={[
                {
                  key: 'comment',
                  label: 'Комментарий',
                  children: (
                    <Input.TextArea
                      rows={3}
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                    />
                  ),
                },
              ]}
            />
          );
        })()}

        {(() => {
          const isConfirmed = loadedDelivery.status.code === 'confirmed_mol';
          const confirmTooltip = isNew
            ? 'Сначала сохраните приёмку, затем можно подтверждать МОЛ'
            : isConfirmed
              ? `Подтверждено: ${loadedDelivery.confirmedByMolUserEmail ?? '—'}, ${formatMolDate(loadedDelivery.confirmedByMolAt)}`
              : (verifyReason ?? 'Подтвердить документ как МОЛ');
          // Помеченный документ — read-only: блокируем Save и Подтвердить МОЛ.
          const saveDisabled = !!verifyReason || isPending;
          // В режиме isNew подтверждение МОЛ недоступно — сначала должна
          // появиться сохранённая запись со статусом filled.
          const confirmDisabled = isNew || isConfirmed || !!verifyReason || isPending;
          // «Удалить» в UI = soft-delete (mark-deletion на бэке): запись
          // уходит в корзину, можно восстановить. Доступно для filled/
          // confirmed_mol в активном режиме.
          const canMarkDeletion =
            !isPending &&
            (loadedDelivery.status.code === 'filled' ||
              loadedDelivery.status.code === 'confirmed_mol');
          const markBlock = canMarkDeletion ? (
            <Popconfirm
              title="Удалить?"
              description={
                <Input.TextArea
                  placeholder="Причина (необязательно)"
                  rows={2}
                  maxLength={500}
                  value={markReason}
                  onChange={(e) => setMarkReason(e.target.value)}
                />
              }
              okText="Удалить"
              okButtonProps={{ danger: true }}
              cancelText="Нет"
              onConfirm={() => {
                const reason = markReason.trim() || null;
                markDel.mutate(reason);
                setMarkReason('');
              }}
            >
              <Button danger icon={<DeleteOutlined />} loading={markDel.isPending}>
                Удалить
              </Button>
            </Popconfirm>
          ) : null;
          return isDesktop ? (
            <div
              style={{
                position: 'sticky',
                bottom: 0,
                marginTop: 8,
                padding: '12px 0',
                background: '#f5f5f5',
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'flex-end',
                alignItems: 'center',
                gap: 8,
                zIndex: 5,
              }}
            >
              {/* Явное сообщение почему Save может быть disabled — раньше
                  пользователь видел причину только при наведении на кнопку
                  (Tooltip), что плохо обнаружимо. Теперь оранжевый тег
                  светится рядом, если есть незакрытые требования. */}
              {verifyReason && (
                <Typography.Text
                  type="warning"
                  style={{ marginRight: 'auto', fontSize: 12 }}
                >
                  ⚠ {verifyReason}
                </Typography.Text>
              )}
              <Button onClick={() => navigate(fromAccepted ? '/operations?type=delivery&tab=accepted' : '/operations?type=delivery')}>
                Отмена
              </Button>
              {markBlock}
              <Tooltip title={verifyReason ?? ''} placement="top">
                <span style={{ display: 'inline-flex' }}>
                  <Button
                    type="primary"
                    loading={save.isPending}
                    disabled={saveDisabled}
                    onClick={() => save.mutate()}
                  >
                    Сохранить
                  </Button>
                </span>
              </Tooltip>
              <Tooltip title={confirmTooltip} placement="top">
                <span style={{ display: 'inline-flex' }}>
                  <Button
                    loading={confirmMol.isPending}
                    disabled={confirmDisabled}
                    onClick={() => confirmMol.mutate()}
                  >
                    Подтвердить МОЛ
                  </Button>
                </span>
              </Tooltip>
            </div>
          ) : (
            <div
              style={{
                position: 'fixed',
                left: 0,
                right: 0,
                bottom: 0,
                padding: 12,
                background: '#fff',
                borderTop: '1px solid #f0f0f0',
                zIndex: 100,
                display: 'flex',
                gap: 8,
              }}
            >
              <Button
                size="large"
                style={{ flex: 1 }}
                onClick={() => navigate(fromAccepted ? '/operations?type=delivery&tab=accepted' : '/operations?type=delivery')}
              >
                Отмена
              </Button>
              {markBlock && <span style={{ flex: 1, display: 'inline-flex' }}>{markBlock}</span>}
              <Tooltip title={verifyReason ?? ''} placement="top">
                <span style={{ flex: 1, display: 'inline-flex' }}>
                  <Button
                    type="primary"
                    size="large"
                    style={{ flex: 1 }}
                    loading={save.isPending}
                    disabled={saveDisabled}
                    onClick={() => save.mutate()}
                  >
                    Сохранить
                  </Button>
                </span>
              </Tooltip>
              <Tooltip title={confirmTooltip} placement="top">
                <span style={{ flex: 1, display: 'inline-flex' }}>
                  <Button
                    size="large"
                    style={{ flex: 1 }}
                    loading={confirmMol.isPending}
                    disabled={confirmDisabled}
                    onClick={() => confirmMol.mutate()}
                  >
                    Подтвердить МОЛ
                  </Button>
                </span>
              </Tooltip>
            </div>
          );
        })()}
      </Space>
    );
  }

  // === Режим списка (нет deliveryId) ===
  // expectedCountQuery / acceptedCountQuery объявлены выше, рядом с
  // остальными хуками — иначе React error #300 при переходе со списка
  // на форму приёмки.

  const handleTabChange = (key: string) => {
    // Сохраняем переключатель trash при смене вкладки: пользователь мог
    // прийти в Принятые с включённым trash и хочет вернуться без потери.
    const next = new URLSearchParams(params);
    if (key === 'expected') {
      next.delete('tab');
    } else {
      next.set('tab', 'accepted');
    }
    setParams(next, { replace: true });
  };

  const listTabs: PageTabItem[] = [
    { key: 'expected', label: 'Ожидаемые', count: expectedCountQuery.data?.total ?? null },
    { key: 'accepted', label: 'Принятые', count: acceptedCountQuery.data?.total ?? null },
  ];

  const createButton = (
    <Button
      type="primary"
      icon={<PlusOutlined />}
      onClick={createBlank}
      disabled={inspectorWithoutSite}
    >
      Новая приёмка
    </Button>
  );

  // Экспорт в Excel — зависит от активной вкладки:
  //  - «Ожидаемые» → source-documents с direction=inbound + unaccepted=true;
  //  - «Принятые» → deliveries c теми же фильтрами что в DeliveriesHistory.
  // Фильтры контрагент/поставщик/объект/номер берутся из URL params (их пишут
  // дочерние компоненты), статус/авто/trash — тоже из URL (только для accepted).
  async function handleExportExcel() {
    try {
      setExporting(true);
      const contractor = params.get('contractor');
      const supplier = params.get('supplier');
      const site = params.get('site');
      const qVal = params.get('q')?.trim();
      const qs = new URLSearchParams();
      if (contractor) qs.set('contractorIds', contractor);
      if (supplier) qs.set('supplierIds', supplier);
      if (site) qs.set('siteIds', site);
      if (qVal) qs.set('q', qVal);

      let path: string;
      let fallback: string;
      const today = new Date().toISOString().slice(0, 10);
      if (tab === 'expected') {
        qs.set('direction', 'inbound');
        qs.set('unaccepted', 'true');
        path = `/source-documents/export.xlsx?${qs.toString()}`;
        fallback = `documents-expected-inbound-${today}.xlsx`;
      } else {
        const statusVal = params.get('status');
        if (statusVal) qs.set('status', statusVal);
        const plateVal = params.get('plate')?.trim();
        if (plateVal) qs.set('plate', plateVal);
        if (params.get('trash') === '1') qs.set('trash', 'true');
        path = `/deliveries/export.xlsx?${qs.toString()}`;
        fallback = `deliveries-${today}.xlsx`;
      }

      const { blob, filename } = await apiDownload(path);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || fallback;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setExporting(false);
    }
  }

  const exportButton = (
    <Button
      icon={<DownloadOutlined />}
      onClick={handleExportExcel}
      loading={exporting}
    >
      Экспорт Excel
    </Button>
  );
  const headerExtras = (
    <Space size={8}>
      {createButton}
      {exportButton}
    </Space>
  );

  // Переключатель «Удалённые» вынесен в верхнюю строку (рядом с Title) —
  // чтобы место под ним было зарезервировано всегда и фильтры/таблица не
  // прыгали по вертикали при смене вкладок. На вкладке «Ожидаемые»
  // переключатель не имеет смысла (там source-documents, не deliveries) —
  // прячем через visibility:hidden, место остаётся.
  // trashOn / isAdminUser / useEffect(trash-сброс) подняты в начало
  // компонента (до early returns) — см. там же.
  const setTrash = (next: boolean) => {
    const p = new URLSearchParams(params);
    if (next) p.set('trash', '1');
    else p.delete('trash');
    // Включение «Удалённых» только в Принятые имеет смысл — переключаем туда.
    if (next) p.set('tab', 'accepted');
    setParams(p, { replace: true });
  };
  const trashSwitchVisible = tab === 'accepted' && isAdminUser;

  // Жёсткий запрет ренда списка приёмок внутри модалки «Операции».
  //
  // KppPage внутри Modal живёт по URL ?delivery=UUID — если она тут, форма
  // отрисовалась ещё на L1160 (`if (deliveryId) return <Form>`). До этой
  // ветки мы доходим только когда deliveryId отсутствует. На «своей»
  // странице /kpp это нормально — показываем список. Но в embedded-режиме
  // (внутри antd Modal) список рисовать НЕЛЬЗЯ:
  //
  // При закрытии модалки (afterClose) родитель OperationsPage чистит URL
  // от ?delivery= и сбрасывает isClosing. React делает один re-render,
  // в котором KppPage ВНУТРИ Modal на 1 кадр оказывается без deliveryId —
  // antd размонтирует children только следующим кадром. Без этого guard'а
  // на тот кадр пользователь видит «вспышку таблицы» поверх затемнения.
  //
  // null здесь безопасен: формы без id всё равно нет, а Modal уже
  // закрывается — рисовать в нём нечего.
  if (embedded) return null;

  return (
    <StickyPageHeader
      header={
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <Typography.Title level={3} style={{ margin: 0 }}>
              Приёмка
            </Typography.Title>
            {/* Табы «Ожидаемые/Принятые» — в одной строке с заголовком,
                чтобы освободить вертикальное пространство и поднять таблицу.
                Дочерние компоненты больше не рендерят свой <PageTabs>. */}
            <PageTabs
              items={listTabs}
              activeKey={tab}
              onChange={handleTabChange}
            />
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              visibility: trashSwitchVisible ? 'visible' : 'hidden',
            }}
          >
            <Switch
              checked={trashOn}
              onChange={(checked) => setTrash(checked)}
            />
            <Typography.Text type={trashOn ? undefined : 'secondary'}>
              Удалённые
            </Typography.Text>
          </div>
        </div>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {inspectorWithoutSite && (
          <Alert
            type="warning"
            showIcon
            message="Объект не назначен"
            description="Чтобы видеть приёмки и создавать новые, обратитесь к администратору — он должен назначить вам объект на странице «Администрирование → Пользователи»."
          />
        )}

        {tab === 'expected' ? (
          // tabs/activeTab/onTabChange больше не передаём — PageTabs живёт
          // в шапке KppPage (рядом с заголовком), чтобы освободить
          // вертикальное место для таблицы.
          <ExpectedUpds onOpen={createFromUpd} filtersExtra={headerExtras} />
        ) : (
          <DeliveriesHistory
            onOpen={(id) => navigate(`/operations?type=delivery&delivery=${id}&from=accepted`)}
            filtersExtra={headerExtras}
          />
        )}
      </Space>
    </StickyPageHeader>
  );
}
