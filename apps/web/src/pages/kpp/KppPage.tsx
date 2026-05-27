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
import { api } from '../../services/api';
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
import { useBreakpoint } from '../../shared/hooks/useBreakpoint';
import { DeliveriesHistory } from './DeliveriesHistory';
import { ExpectedUpds } from './ExpectedUpds';
import { PhotoGallery } from './PhotoGallery';
import { LinkSourceDocumentModal } from '../shared/LinkSourceDocumentModal';
import { LinkOutlined } from '@ant-design/icons';
import { parseDeliveryComment } from '../../shared/utils/parseDeliveryComment';

type DraftItem = {
  clientKey: string;
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

export default function KppPage() {
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
  const responsiblePersonsQuery = useQuery({
    queryKey: ['responsible-persons', 'active'],
    queryFn: () =>
      api.get<{ items: ResponsiblePerson[]; total: number }>(
        '/responsible-persons?activeOnly=true&limit=500',
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

  useEffect(() => {
    const d = deliveryQuery.data;
    if (!d) return;
    if (hydratedIdRef.current !== d.id) {
      hydratedIdRef.current = d.id;
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
    navigate(`/kpp?delivery=${id}&new=1`);
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
    navigate(`/kpp?delivery=${id}&new=1&upd=${upd.id}`);
  };

  const photoProps: UploadProps = {
    accept: 'image/*',
    capture: 'environment',
    showUploadList: false,
    beforeUpload: async (file) => {
      if (!deliveryId) return false;
      try {
        // На веб-портале нет UI 1-/2-го этапа (это специфика мобильного),
        // поэтому маппим по серверному статусу: после подтверждения МОЛ
        // (2-й этап завершён) — фото попадает в «После», иначе — в «До».
        const stage =
          loadedDelivery?.status.code === 'confirmed_mol' ? 'after' : 'before';
        await capturePhoto('delivery', deliveryId, file, 'cargo', stage);
        message.success('Фото добавлено');
        // Локальный список фото перечитывается сразу из IDB, серверный delivery.photos —
        // после S3-upload + следующего pullSync. Галерея мерджит оба источника по id.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['photos-local', 'delivery', deliveryId] }),
          queryClient.invalidateQueries({ queryKey: ['deliveries', deliveryId] }),
        ]);
        void runSync();
      } catch (err) {
        message.error(`Не удалось добавить фото: ${(err as Error).message}`);
      }
      return false;
    },
  };

  const updateField = (key: string, patch: Partial<DraftItem>) => {
    setItems((prev) => prev.map((it) => (it.clientKey === key ? { ...it, ...patch } : it)));
  };

  const addItem = () => {
    setItems((prev) => [
      ...prev,
      {
        clientKey: newKey(),
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
    return {
      status: nextStatus,
      siteId: siteId ?? loadedDelivery.siteId,
      supplierId: selectedUpd?.supplierId ?? loadedDelivery.supplierId ?? null,
      contractorId: recipientKind === 'counterparty' ? contractorId : null,
      recipientMolId: recipientKind === 'mol' ? recipientMolId : null,
      vehiclePlate: plate || null,
      arrivedAt: loadedDelivery.arrivedAt ?? new Date().toISOString(),
      comment: comment || null,
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
    void runSync();
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
      navigate('/kpp?tab=accepted');
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
      navigate('/kpp?tab=accepted');
    },
    onError: (err: Error) => message.error(err.message),
  });

  // Ручная привязка УПД к приёмке «Без документа» на портале (только admin/manager).
  // Шлём прямой POST /deliveries с непустым sourceDocumentIds и пустым items —
  // сервер сам подтянет позиции из УПД и переведёт статус в not_filled. IDB не
  // трогаем: эта операция выполняется на портале, локальный snapshot инспектора
  // обновится при следующем pullSync.
  const linkUpd = useMutation({
    mutationFn: async (upd: SourceDocument): Promise<Delivery> => {
      if (!loadedDelivery) throw new Error('Приёмка ещё не загружена');
      const payload = {
        id: loadedDelivery.id,
        statusCode: 'not_filled' as DeliveryStatusCode,
        siteId: loadedDelivery.siteId,
        supplierId: upd.supplierId ?? loadedDelivery.supplierId ?? null,
        contractorId: loadedDelivery.contractorId,
        recipientMolId: loadedDelivery.recipientMolId,
        vehiclePlate: loadedDelivery.vehiclePlate,
        driverName: loadedDelivery.driverName,
        arrivedAt: loadedDelivery.arrivedAt,
        comment: loadedDelivery.comment,
        sourceDocumentIds: [upd.id],
        items: [],
        baseVersion: loadedDelivery.version,
      };
      return await api.post<Delivery>('/deliveries', payload);
    },
    onSuccess: async (dto) => {
      await upsertServerSnapshot([dto]);
      message.success('УПД привязана');
      setLinkUpdOpen(false);
      setLinkUpdError(null);
      hydratedIdRef.current = null;
      void queryClient.invalidateQueries({ queryKey: ['deliveries', deliveryId] });
      void queryClient.invalidateQueries({ queryKey: ['deliveries'] });
      void queryClient.invalidateQueries({ queryKey: ['source-documents'] });
    },
    onError: (err: Error) => {
      setLinkUpdError(err.message);
    },
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
      void queryClient.invalidateQueries({ queryKey: ['source-documents'] });
      navigate('/kpp?tab=accepted&trash=1');
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
        width: 90,
        render: (_: unknown, r: DraftItem) =>
          r.qtyPlanned !== null && r.qtyPlanned !== ''
            ? trimQty(r.qtyPlanned)
            : '—',
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
        width: 80,
        render: (_: unknown, r: DraftItem) => (
          <Input
            size="small"
            value={r.unit}
            onChange={(e) => updateField(r.clientKey, { unit: e.target.value })}
          />
        ),
      },
      {
        title: 'Цена',
        width: 110,
        render: (_: unknown, r: DraftItem) => {
          const v = toNum(r.price);
          return v !== null ? v.toFixed(2) : '—';
        },
      },
      {
        title: 'Сумма НДС',
        width: 120,
        render: (_: unknown, r: DraftItem) => {
          const v = computeVatSum(r);
          return v !== null ? v.toFixed(2) : '—';
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
            <div>{priceNum !== null ? priceNum.toFixed(2) : '—'}</div>
          </Col>
          <Col span={12}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Сумма НДС
            </Typography.Text>
            <div>{vatNum !== null ? vatNum.toFixed(2) : '—'}</div>
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
        <Space style={{ width: '100%' }} align="center">
          {fromAccepted && (
            <Button
              type="text"
              icon={<ArrowLeftOutlined />}
              onClick={() => navigate('/kpp?tab=accepted')}
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

        <Row gutter={[8, 8]}>
          <Col xs={24} sm={12} md={6}>
            <Card
              size="small"
              title={
                <span>
                  Объект <span style={{ color: '#ff4d4f' }}>*</span>
                </span>
              }
              styles={{ body: { padding: 12 } }}
            >
              <Select<string>
                size="large"
                style={{ width: '100%' }}
                placeholder="Выберите объект"
                value={siteId ?? undefined}
                onChange={(v) => setSiteId(v)}
                showSearch
                optionFilterProp="label"
                loading={sitesQuery.isLoading}
                disabled={isInspector}
                options={sites.map((s) => ({
                  value: s.id,
                  label: `${s.code} · ${s.name}`,
                }))}
                notFoundContent={
                  <Typography.Text type="secondary">
                    Объектов нет — заведите их в Справочниках
                  </Typography.Text>
                }
              />
            </Card>
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Card size="small" title="Получатель" styles={{ body: { padding: 12 } }}>
              <Segmented
                block
                style={{ marginBottom: 8 }}
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
                  size="large"
                  style={{ width: '100%' }}
                  placeholder="— не указан —"
                  value={contractorId ?? undefined}
                  onChange={(v) => setContractorId(v ?? null)}
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  loading={counterpartiesQuery.isLoading}
                  options={counterparties.map((c) => ({
                    value: c.id,
                    label: c.name,
                  }))}
                  notFoundContent={
                    <Typography.Text type="secondary">
                      Нет контрагентов с ролью «Подрядчик» — отметьте их в Справочниках
                    </Typography.Text>
                  }
                />
              ) : (
                <Select<string>
                  size="large"
                  style={{ width: '100%' }}
                  placeholder="— не указан —"
                  value={recipientMolId ?? undefined}
                  onChange={(v) => setRecipientMolId(v ?? null)}
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  loading={responsiblePersonsQuery.isLoading}
                  options={responsiblePersons.map((m) => ({
                    value: m.id,
                    label: m.fullName,
                  }))}
                  notFoundContent={
                    <Typography.Text type="secondary">
                      Заведите МОЛ в Справочниках
                    </Typography.Text>
                  }
                />
              )}
            </Card>
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Card size="small" title="Госномер" styles={{ body: { padding: 12 } }}>
              <Input
                size="large"
                placeholder="А123ВВ77"
                value={plate}
                onChange={(e) => setPlate(e.target.value.toUpperCase())}
                autoCapitalize="characters"
              />
            </Card>
          </Col>
          <Col xs={24} sm={12} md={6}>
            {loadedDelivery?.sourceShipmentId ? (
              // Парная приёмка из transfer — вместо УПД показываем источник и
              // обе фактические даты. Дата прибытия заполнится, как только
              // инспектор destSite подтвердит приёмку.
              <Card size="small" title="Перемещение" styles={{ body: { padding: 12 } }}>
                <Space direction="vertical" size={2}>
                  <Space wrap>
                    <Tag color="geekblue">с объекта</Tag>
                    <Typography.Text strong>
                      {loadedDelivery.sourceShipmentSiteCode ?? '—'}
                    </Typography.Text>
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Отгружено: {formatMolDate(loadedDelivery.sourceShipmentShippedAt)}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Принято: {formatMolDate(loadedDelivery.arrivedAt)}
                  </Typography.Text>
                </Space>
              </Card>
            ) : (
              <Card size="small" title="УПД" styles={{ body: { padding: 12 } }}>
                {selectedUpd ? (
                  <Space wrap>
                    <Tag color="blue">{selectedUpd.docNumber ?? '— без номера —'}</Tag>
                    <Typography.Text type="secondary">
                      {selectedUpd.docDate ?? '—'} · {selectedUpd.totalSum ?? '—'} ₽
                    </Typography.Text>
                  </Space>
                ) : (
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <Typography.Text type="secondary">— без УПД —</Typography.Text>
                    {!isInspector &&
                      loadedDelivery?.sourceDocumentIds.length === 0 &&
                      !isNew && (
                        <Button
                          size="small"
                          icon={<LinkOutlined />}
                          onClick={() => {
                            setLinkUpdError(null);
                            setLinkUpdOpen(true);
                          }}
                        >
                          Привязать УПД
                        </Button>
                      )}
                  </Space>
                )}
              </Card>
            )}
          </Col>
        </Row>

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

        {selectedUpd && !loadedDelivery?.sourceShipmentId && (
          <Card size="small" title="Дата поставки" styles={{ body: { padding: 12 } }}>
            <Typography.Text>{selectedUpd.expectedDate ?? '—'}</Typography.Text>
          </Card>
        )}

        <Collapse
          size="small"
          defaultActiveKey={photosCount > 0 ? ['photos'] : []}
          items={[
            {
              key: 'photos',
              label: `Фото${photosCount ? ` (${photosCount})` : ''}`,
              children: (
                <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                  <Space wrap>
                    <Upload {...photoProps}>
                      <Button size="large" icon={<CameraOutlined />}>
                        Снять фото
                      </Button>
                    </Upload>
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
                          До {beforePhotos.length > 0 && `(${beforePhotos.length})`}
                        </Typography.Text>
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
                          После {afterPhotos.length > 0 && `(${afterPhotos.length})`}
                        </Typography.Text>
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
          const parsed = parseDeliveryComment(comment);
          if (parsed.hasStructure) {
            const empty = (
              <Typography.Text type="secondary">— нет —</Typography.Text>
            );
            return (
              <Collapse
                size="small"
                defaultActiveKey={['comment']}
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
          // Кнопка «Пометить на удаление» доступна для filled/confirmed_mol в активном режиме.
          const canMarkDeletion =
            !isPending &&
            (loadedDelivery.status.code === 'filled' ||
              loadedDelivery.status.code === 'confirmed_mol');
          const markBlock = canMarkDeletion ? (
            <Popconfirm
              title="Пометить на удаление?"
              description={
                <Input.TextArea
                  placeholder="Причина (необязательно)"
                  rows={2}
                  maxLength={500}
                  value={markReason}
                  onChange={(e) => setMarkReason(e.target.value)}
                />
              }
              okText="Пометить"
              cancelText="Нет"
              onConfirm={() => {
                const reason = markReason.trim() || null;
                markDel.mutate(reason);
                setMarkReason('');
              }}
            >
              <Button danger icon={<DeleteOutlined />} loading={markDel.isPending}>
                Пометить на удаление
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
                justifyContent: 'flex-end',
                gap: 8,
                zIndex: 5,
              }}
            >
              <Button onClick={() => navigate(fromAccepted ? '/kpp?tab=accepted' : '/kpp')}>
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
                onClick={() => navigate(fromAccepted ? '/kpp?tab=accepted' : '/kpp')}
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
  return (
    <StickyPageHeader
      header={
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Space wrap align="center">
            <Typography.Title level={3} style={{ margin: 0 }}>
              Приёмка
            </Typography.Title>
            <Segmented
              value={tab}
              onChange={(v) => {
                const next = v as ListTab;
                if (next === 'expected') setParams({});
                else setParams({ tab: 'accepted' });
              }}
              options={[
                { label: 'Ожидаемые', value: 'expected' },
                { label: 'Принятые', value: 'accepted' },
              ]}
            />
          </Space>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={createBlank}
            disabled={inspectorWithoutSite}
          >
            Новая приёмка
          </Button>
        </Space>
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
          <ExpectedUpds onOpen={createFromUpd} />
        ) : (
          <DeliveriesHistory
            onOpen={(id) => navigate(`/kpp?delivery=${id}&from=accepted`)}
          />
        )}
      </Space>
    </StickyPageHeader>
  );
}
