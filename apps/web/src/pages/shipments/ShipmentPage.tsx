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
  LinkOutlined,
  PlusOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Counterparty,
  ResponsiblePerson,
  Shipment,
  ShipmentKind,
  ShipmentPhoto,
  ShipmentStatusCode,
  Site,
  SourceDocument,
  SourceDocumentDetail,
  Status,
} from '@matcheck/contracts';
import { api } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { capturePhoto } from '../../services/photoPipeline';
import {
  applyLocalEdit,
  effectiveState,
  enqueueMutation,
  getShipment,
  hardDeleteShipment,
  markDeletion as markShipmentDeletion,
  unmarkDeletion as unmarkShipmentDeletion,
  upsertServerSnapshot,
} from '../../services/shipments';
import { AssetTag } from '../../shared/ui/AssetTag';
import { PendingDeletionTag } from '../../shared/ui/PendingDeletionTag';
import { runSync } from '../../services/sync';
import { db, SYSTEM_SITE_ID } from '../../lib/db';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import type { PageTabItem } from '../../shared/ui/PageTabs';
import { useBreakpoint } from '../../shared/hooks/useBreakpoint';
import { PhotoGallery } from '../kpp/PhotoGallery';
import { ShipmentsHistory } from './ShipmentsHistory';
import { ExpectedOutbound } from './ExpectedOutbound';
import { LinkSourceDocumentModal } from '../shared/LinkSourceDocumentModal';

type DraftItem = {
  clientKey: string;
  lineNo: number;
  nameRaw: string;
  qtyPlanned: string | null;
  qtyActual: string | null;
  unit: string;
  materialId: string | null;
  // Поддержка ОС в позициях: itemKind='asset' визуально отмечается стикером
  // AssetTag. assetId/inventoryNumber/serialNumber — атрибуты конкретного
  // экземпляра, заполняются для itemKind='asset'.
  itemKind: 'material' | 'asset';
  assetId: string | null;
  inventoryNumber: string | null;
  serialNumber: string | null;
  // Финансовый снимок из УПД, см. apps/web/src/pages/kpp/KppPage.tsx.
  price: string | null;
  vatRate: string | null;
  vatSum: string | null;
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

const KIND_OPTIONS: { label: string; value: ShipmentKind }[] = [
  { label: 'Подрядчику', value: 'contractor' },
  { label: 'Возврат', value: 'return' },
  { label: 'Перемещение', value: 'transfer' },
  { label: 'Списание', value: 'writeoff' },
];

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

export default function ShipmentPage() {
  const navigate = useNavigate();
  const isDesktop = useBreakpoint() === 'desktop';
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const shipmentId = params.get('shipment');
  const fromList = params.get('from') === 'list';
  // Дефолт — 'accepted' (не ломаем привычку: страница и раньше открывалась
  // на истории отгрузок). Вкладка 'expected' появляется только при явном tab=expected.
  const tab: ListTab = params.get('tab') === 'expected' ? 'expected' : 'accepted';
  // Режим «новой несохранённой формы»: запись в IDB/БД ещё не создана.
  // UUID лежит в shipmentId, флаг new=1 отключает shipmentQuery и активирует
  // ветку creation в save-mutation (первый «Сохранить» создаёт документ shipped).
  const isNew = params.get('new') === '1';
  const updIdFromUrl = params.get('upd');

  // Для inspector_kpp объект-источник фиксирован значением из БД (selectбыл бы
  // disabled, а сервер всё равно перепишет siteId на user.siteId).
  const authUser = useAuthStore((s) => s.user);
  const isInspector = authUser?.role === 'inspector_kpp';
  const inspectorSiteId = isInspector ? (authUser?.siteId ?? null) : null;
  const inspectorWithoutSite = isInspector && !inspectorSiteId;

  const [items, setItems] = useState<DraftItem[]>([]);
  // Inline-edit названия материала: см. apps/web/src/pages/kpp/KppPage.tsx.
  const [editingNameKey, setEditingNameKey] = useState<string | null>(null);
  const [kind, setKind] = useState<ShipmentKind>('contractor');
  const [siteId, setSiteId] = useState<string | null>(inspectorSiteId);
  const [destSiteId, setDestSiteId] = useState<string | null>(null);
  // Тип получателя для kind in ('contractor','transfer'): подрядчик из counterparties
  // или МОЛ из responsible_persons. Для kind='return' принудительно 'counterparty'
  // (возврат — только поставщику). receiverId хранит выбранный id выбранного типа.
  const [receiverKind, setReceiverKind] = useState<'counterparty' | 'mol'>('counterparty');
  const [receiverId, setReceiverId] = useState<string | null>(null);
  const [plate, setPlate] = useState('');
  const [driverName, setDriverName] = useState('');
  const [comment, setComment] = useState('');
  const [linkUpdOpen, setLinkUpdOpen] = useState(false);
  const [linkUpdError, setLinkUpdError] = useState<string | null>(null);

  // ID отгрузки, для которой уже выполнили первичную гидратацию формы из server data.
  // Защищает локальные правки (plate/driverName/comment/items) от затирания при рефетче
  // ['shipments', id] — рефетч происходит, например, после загрузки/удаления фото.
  const hydratedIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!shipmentId) {
      setItems([]);
      setKind('contractor');
      setSiteId(inspectorSiteId);
      setDestSiteId(null);
      setReceiverKind('counterparty');
      setReceiverId(null);
      setPlate('');
      setDriverName('');
      setComment('');
      hydratedIdRef.current = null;
    }
  }, [shipmentId, inspectorSiteId]);

  const sitesQuery = useQuery({
    queryKey: ['sites', 'all'],
    queryFn: () => api.get<{ items: Site[]; total: number }>('/sites?activeOnly=true&limit=200'),
  });
  const counterpartiesQuery = useQuery({
    queryKey: ['counterparties', 'all'],
    queryFn: () =>
      api.get<{ items: Counterparty[]; total: number }>('/counterparties?limit=500'),
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
  // Для возврата фильтруем по supplier; для contractor — любые контрагенты.
  const counterpartyReceiverOptions =
    kind === 'return' ? counterparties.filter((c) => c.isSupplier) : counterparties;

  // Лёгкие count-запросы для счётчиков на вкладках Ожидаемые/Принятые.
  // ОБЯЗАТЕЛЬНО объявляются вместе с остальными хуками — выше любых early
  // return'ов формы (иначе React error #300 при навигации со списка в форму).
  const expectedCountQuery = useQuery({
    queryKey: ['source-documents', 'unaccepted-upd-count', 'outbound'],
    queryFn: () =>
      api.get<{ total: number }>(
        '/source-documents?kind=upd,transport_waybill,os2_transfer&direction=outbound&unaccepted=true&limit=1',
      ),
  });
  const acceptedCountQuery = useQuery({
    queryKey: ['shipments', 'count', 'active'],
    queryFn: () => api.get<{ total: number }>('/shipments?limit=1'),
  });

  const shipmentQuery = useQuery({
    queryKey: ['shipments', shipmentId],
    queryFn: async (): Promise<Shipment> => {
      if (!shipmentId) throw new Error('no shipment id');
      try {
        const remote = await api.get<Shipment>(`/shipments/${shipmentId}`);
        await upsertServerSnapshot([remote]);
        return remote;
      } catch (err) {
        const local = await getShipment(shipmentId);
        const eff = local ? effectiveState(local) : null;
        if (eff) return eff;
        throw err;
      }
    },
    // В режиме isNew записи на сервере и в IDB ещё нет — запрос дал бы 404
    // и завис бы в isLoading. Форма работает только с локальным state.
    enabled: !!shipmentId && !isNew,
  });

  // Детали УПД для преднаполнения формы в режиме isNew. Сначала IndexedDB
  // (наполняется pullSync), при пустом кеше — серверный fallback.
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

  // Локальные IDB-записи фото — параллельный источник к loadedShipment.photos.
  // Мерджим оба, чтобы свежеснятое фото показывалось в галерее, не дожидаясь pullSync.
  const localPhotosQuery = useQuery({
    queryKey: ['photos-local', 'shipment', shipmentId],
    queryFn: async (): Promise<ShipmentPhoto[]> => {
      if (!shipmentId) return [];
      const dbi = await db();
      const all = await dbi
        .transaction('photos')
        .store.index('byDelivery')
        .getAll(shipmentId);
      return all
        .filter((p) => p.operationKind === 'shipment')
        .map((p) => ({
          id: p.id,
          kind: p.kind,
          s3Key: p.s3Key ?? '',
          thumbS3Key: p.thumbS3Key ?? null,
          contentHash: p.contentHash ?? null,
          takenAt: new Date(p.takenAt).toISOString(),
        }));
    },
    enabled: !!shipmentId,
  });

  useEffect(() => {
    const s = shipmentQuery.data;
    if (!s) return;
    if (hydratedIdRef.current !== s.id) {
      hydratedIdRef.current = s.id;
      setKind(s.kind);
      if (isInspector) {
        setSiteId(inspectorSiteId);
      } else {
        setSiteId((prev) => prev ?? (s.siteId === SYSTEM_SITE_ID ? null : s.siteId));
      }
      setDestSiteId((prev) => prev ?? s.destSiteId ?? null);
      // Восстанавливаем выбранный тип получателя из сервера: если есть
      // receiverMolId — это МОЛ; иначе counterparty (даже если оба null).
      if (s.receiverMolId) {
        setReceiverKind('mol');
        setReceiverId((prev) => prev ?? s.receiverMolId);
      } else {
        setReceiverKind('counterparty');
        setReceiverId((prev) => prev ?? s.receiverCounterpartyId ?? null);
      }
      setPlate(s.vehiclePlate ?? '');
      setDriverName(s.driverName ?? '');
      setComment(s.comment ?? '');
      setItems(
        s.items.map((it, idx) => ({
          clientKey: newKey(),
          lineNo: idx + 1,
          nameRaw: it.nameRaw,
          qtyPlanned: it.qtyPlanned,
          qtyActual: it.qtyActual ?? it.qtyPlanned,
          unit: it.unit,
          materialId: it.materialId,
          itemKind: it.itemKind,
          assetId: it.assetId,
          inventoryNumber: it.inventoryNumber,
          serialNumber: it.serialNumber,
          price: it.price ?? null,
          vatRate: it.vatRate ?? null,
          vatSum: it.vatSum ?? null,
        })),
      );
    }
  }, [shipmentQuery.data, isInspector, inspectorSiteId]);

  // В режиме isNew серверной записи ещё нет — собираем «виртуальный» Shipment
  // из дефолтов, чтобы существующий JSX (status, photos, version и т. д.) работал
  // без переписки. Фактические items/receiver/comment живут в локальном state формы.
  const virtualShipment: Shipment | null = useMemo(() => {
    if (!isNew || !shipmentId) return null;
    // До первого «Сохранить» статус виртуальной отгрузки — not_filled
    // независимо от наличия УПД. Признак «без документа» отображается
    // отдельным тегом и вычисляется из sourceDocumentIds.
    const initialStatus: Status = {
      id: '',
      entityType: 'shipment',
      code: 'not_filled',
      label: 'Не оформлена',
      color: 'orange',
      sortOrder: 10,
    };
    return {
      id: shipmentId,
      status: initialStatus,
      kind: 'contractor',
      siteId: inspectorSiteId ?? SYSTEM_SITE_ID,
      receiverCounterpartyId: null,
      receiverMolId: null,
      destSiteId: null,
      vehiclePlate: null,
      driverName: null,
      shippedAt: null,
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
      items: [],
      photos: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }, [isNew, shipmentId, inspectorSiteId, updIdFromUrl, authUser?.id]);

  // Гидратация формы в режиме isNew по выбранному УПД. items/receiverId/siteId
  // подставляются из SourceDocumentDetail один раз — далее редактирование идёт
  // через локальный state. hydratedIdRef защищает от повторного затирания.
  useEffect(() => {
    if (!isNew || !shipmentId) return;
    const detail = newFromUpdQuery.data;
    if (!detail) return;
    if (hydratedIdRef.current === shipmentId) return;
    hydratedIdRef.current = shipmentId;
    setKind('contractor');
    if (!isInspector) {
      setSiteId((prev) => prev ?? (detail.siteId === SYSTEM_SITE_ID ? null : detail.siteId));
    }
    setReceiverKind('counterparty');
    setReceiverId((prev) => prev ?? detail.contractorId ?? null);
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
        price: it.price ?? null,
        vatRate: it.vatRate ?? null,
        vatSum: it.vatSum ?? null,
      })),
    );
  }, [isNew, shipmentId, newFromUpdQuery.data, isInspector]);

  const loadedShipment: Shipment | null = virtualShipment ?? shipmentQuery.data ?? null;

  // Для уже сохранённой отгрузки — детали привязанного источника
  // (для отображения номера/даты/суммы УПД или Накладной в шапке).
  // Должно быть ПОСЛЕ объявления loadedShipment — иначе TDZ
  // (Cannot access 'loadedShipment' before initialization).
  const linkedSourceId = loadedShipment?.sourceDocumentIds[0] ?? null;
  const linkedSourceQuery = useQuery({
    queryKey: ['source-document-detail', linkedSourceId],
    queryFn: async (): Promise<SourceDocumentDetail> => {
      if (!linkedSourceId) throw new Error('no source id');
      const dbi = await db();
      const cached = await dbi.get('source_documents', linkedSourceId);
      if (cached) return cached;
      return await api.get<SourceDocumentDetail>(`/source-documents/${linkedSourceId}`);
    },
    enabled: !isNew && !!linkedSourceId,
  });
  // Единый источник для шапки: при isNew — из URL, иначе — из сохранённой отгрузки.
  const linkedSource = isNew ? newFromUpdQuery.data : linkedSourceQuery.data;

  /**
   * Открывает форму новой пустой отгрузки. UUID кладётся в URL под флагом new=1.
   * Запись в IndexedDB и на сервере появится только при первом нажатии «Сохранить» —
   * до этого момента форма существует только как React state.
   */
  const createBlank = () => {
    if (inspectorWithoutSite) {
      message.error('Объект не назначен — обратитесь к администратору');
      return;
    }
    const id = crypto.randomUUID();
    navigate(`/shipments?shipment=${id}&new=1`);
  };

  /**
   * Открывает форму новой отгрузки, преднаполненной из выбранного исходящего УПД.
   * Детали УПД (items, receiverCounterpartyId) подгружаются уже внутри формы по
   * флагу new=1 и updIdFromUrl. Черновик в IDB/БД до явного «Сохранить» не создаётся.
   */
  const createFromUpd = (upd: SourceDocument) => {
    if (inspectorWithoutSite) {
      message.error('Объект не назначен — обратитесь к администратору');
      return;
    }
    const id = crypto.randomUUID();
    navigate(`/shipments?shipment=${id}&new=1&upd=${upd.id}&from=list`);
  };

  const photoProps: UploadProps = {
    accept: 'image/*',
    capture: 'environment',
    showUploadList: false,
    beforeUpload: async (file) => {
      if (!shipmentId) return false;
      try {
        await capturePhoto('shipment', shipmentId, file, 'cargo');
        message.success('Фото добавлено');
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['photos-local', 'shipment', shipmentId] }),
          queryClient.invalidateQueries({ queryKey: ['shipments', shipmentId] }),
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
        price: null,
        vatRate: null,
        vatSum: null,
      },
    ]);
  };

  const removeItem = (key: string) => {
    setItems((prev) =>
      prev.filter((it) => it.clientKey !== key).map((it, i) => ({ ...it, lineNo: i + 1 })),
    );
  };

  const buildPatch = (nextCode: ShipmentStatusCode): Partial<Shipment> => {
    if (!loadedShipment) throw new Error('Отгрузка ещё не загружена');
    const nextStatus: Status = { ...loadedShipment.status, code: nextCode };
    return {
      status: nextStatus,
      kind,
      siteId: siteId ?? loadedShipment.siteId,
      receiverCounterpartyId:
        (kind === 'contractor' || kind === 'return' || kind === 'transfer') &&
        receiverKind === 'counterparty'
          ? receiverId
          : null,
      receiverMolId:
        (kind === 'contractor' || kind === 'transfer') && receiverKind === 'mol'
          ? receiverId
          : null,
      destSiteId: kind === 'transfer' ? destSiteId : null,
      vehiclePlate: plate || null,
      driverName: driverName || null,
      shippedAt: loadedShipment.shippedAt ?? new Date().toISOString(),
      comment: comment || null,
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
            volumeM3: null,
            massKg: null,
            price: i.price,
            vatRate: i.vatRate,
            vatSum: computed !== null ? computed.toFixed(2) : (i.vatSum ?? null),
            volumeConfidence: null,
            groupName: null,
          };
        }),
    };
  };

  const persistStatus = async (nextCode: ShipmentStatusCode) => {
    if (!loadedShipment) throw new Error('Отгрузка ещё не загружена');
    await applyLocalEdit(loadedShipment.id, buildPatch(nextCode));
    await enqueueMutation({
      id: crypto.randomUUID(),
      kind: 'shipment_upsert',
      entityId: loadedShipment.id,
      baseVersion: loadedShipment.version,
      payload: null,
    });
    void runSync();
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!loadedShipment) throw new Error('Отгрузка ещё не загружена');
      // Без УПД оформить как shipped нельзя — сервер всё равно понизит,
      // но локальный optimistic-state должен совпадать.
      const hasUpd = loadedShipment.sourceDocumentIds.length > 0;
      const currentCode = loadedShipment.status.code as ShipmentStatusCode;
      const nextCode: ShipmentStatusCode =
        currentCode === 'confirmed_mol'
          ? 'confirmed_mol'
          : hasUpd
            ? 'shipped'
            : 'not_filled';
      await persistStatus(nextCode);
    },
    onSuccess: () => {
      message.success('Отгрузка сохранена');
      void queryClient.invalidateQueries({ queryKey: ['shipments'] });
      navigate('/shipments');
    },
    onError: (err: Error) => message.error(err.message),
  });

  const confirmMol = useMutation({
    mutationFn: async () => {
      await persistStatus('confirmed_mol');
    },
    onSuccess: () => {
      message.success('Отгрузка подтверждена МОЛ');
      void queryClient.invalidateQueries({ queryKey: ['shipments'] });
      navigate('/shipments');
    },
    onError: (err: Error) => message.error(err.message),
  });

  // Ручная привязка УПД к отгрузке «Без документа» на портале (только admin/manager).
  // Симметрично linkUpd в KppPage.tsx.
  const linkUpd = useMutation({
    mutationFn: async (upd: SourceDocument): Promise<Shipment> => {
      if (!loadedShipment) throw new Error('Отгрузка ещё не загружена');
      const payload = {
        id: loadedShipment.id,
        statusCode: 'not_filled' as ShipmentStatusCode,
        kind: loadedShipment.kind,
        siteId: loadedShipment.siteId,
        receiverCounterpartyId: loadedShipment.receiverCounterpartyId,
        receiverMolId: loadedShipment.receiverMolId,
        destSiteId: loadedShipment.destSiteId,
        vehiclePlate: loadedShipment.vehiclePlate,
        driverName: loadedShipment.driverName,
        shippedAt: loadedShipment.shippedAt,
        comment: loadedShipment.comment,
        sourceDocumentIds: [upd.id],
        items: [],
        baseVersion: loadedShipment.version,
      };
      return await api.post<Shipment>('/shipments', payload);
    },
    onSuccess: async (dto) => {
      await upsertServerSnapshot([dto]);
      message.success('УПД привязана');
      setLinkUpdOpen(false);
      setLinkUpdError(null);
      hydratedIdRef.current = null;
      void queryClient.invalidateQueries({ queryKey: ['shipments', shipmentId] });
      void queryClient.invalidateQueries({ queryKey: ['shipments'] });
      void queryClient.invalidateQueries({ queryKey: ['source-documents'] });
    },
    onError: (err: Error) => {
      setLinkUpdError(err.message);
    },
  });

  const markDel = useMutation({
    mutationFn: async (reason: string | null) => {
      if (!loadedShipment) throw new Error('Отгрузка ещё не загружена');
      return markShipmentDeletion(loadedShipment.id, reason);
    },
    onSuccess: () => {
      message.success('Помечено на удаление');
      void queryClient.invalidateQueries({ queryKey: ['shipments', shipmentId] });
      void queryClient.invalidateQueries({ queryKey: ['shipments'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const unmarkDel = useMutation({
    mutationFn: async () => {
      if (!loadedShipment) throw new Error('Отгрузка ещё не загружена');
      return unmarkShipmentDeletion(loadedShipment.id);
    },
    onSuccess: () => {
      message.success('Пометка снята');
      void queryClient.invalidateQueries({ queryKey: ['shipments', shipmentId] });
      void queryClient.invalidateQueries({ queryKey: ['shipments'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const hardDel = useMutation({
    mutationFn: async () => {
      if (!loadedShipment) throw new Error('Отгрузка ещё не загружена');
      return hardDeleteShipment(loadedShipment.id);
    },
    onSuccess: () => {
      message.success('Отгрузка удалена');
      void queryClient.invalidateQueries({ queryKey: ['shipments'] });
      void queryClient.invalidateQueries({ queryKey: ['source-documents'] });
      navigate('/shipments?trash=1');
    },
    onError: (err: Error) => message.error(err.message),
  });

  const [markReason, setMarkReason] = useState('');

  // Мерджим серверные photos и локальные IDB-записи по id, чтобы превью
  // свежеснятого фото не пропадало между моментами IDB-put и pullSync.
  const mergedPhotos: ShipmentPhoto[] = useMemo(() => {
    const server = loadedShipment?.photos ?? [];
    const local = localPhotosQuery.data ?? [];
    return [
      ...server,
      ...local.filter((lp) => !server.some((sp) => sp.id === lp.id)),
    ];
  }, [loadedShipment?.photos, localPhotosQuery.data]);
  const photosCount = mergedPhotos.length;

  const verifyReason: string | null = (() => {
    const reasons: string[] = [];
    if (!siteId) reasons.push('Выберите объект «Откуда»');
    if (kind === 'contractor' || kind === 'return') {
      if (!receiverId) reasons.push('Выберите получателя');
    }
    if (kind === 'transfer') {
      if (!destSiteId) reasons.push('Выберите объект «Куда»');
      else if (destSiteId === siteId) reasons.push('Объект-приёмник должен отличаться от источника');
      if (!receiverId) reasons.push('Выберите получателя на новом объекте');
    }
    if (!plate.trim()) reasons.push('Заполните госномер');
    if (photosCount === 0) reasons.push('Сделайте хотя бы одно фото');
    // Позиции обязательны только если привязана УПД. Отгрузка без УПД
    // оформляется одними фото — позиции подтянутся позже при ручной
    // привязке УПД на портале (см. updateShipment на сервере).
    const hasUpdNow = (loadedShipment?.sourceDocumentIds.length ?? 0) > 0;
    if (
      hasUpdNow &&
      items.filter((it) => it.nameRaw.trim().length > 0).length === 0
    )
      reasons.push('Добавьте хотя бы одну позицию');
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
          const assetMeta = r.itemKind === 'asset' && (
            <Space size={4} style={{ marginBottom: 4 }}>
              <AssetTag />
              {r.inventoryNumber && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Инв. № {r.inventoryNumber}
                </Typography.Text>
              )}
              {r.serialNumber && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  SN {r.serialNumber}
                </Typography.Text>
              )}
            </Space>
          );
          const isEditing = editingNameKey === r.clientKey;
          return (
            <Space.Compact direction="vertical" style={{ width: '100%' }}>
              {assetMeta}
              {isEditing ? (
                <Input.TextArea
                  autoSize={{ minRows: 1, maxRows: 4 }}
                  autoFocus
                  value={r.nameRaw}
                  placeholder="Наименование"
                  onChange={(e) => updateField(r.clientKey, { nameRaw: e.target.value })}
                  onBlur={() => setEditingNameKey(null)}
                />
              ) : (
                <div
                  onClick={() => setEditingNameKey(r.clientKey)}
                  style={{
                    cursor: 'text',
                    whiteSpace: 'pre-wrap',
                    minHeight: 22,
                    padding: '4px 0',
                  }}
                >
                  {r.nameRaw || (
                    <Typography.Text type="secondary">
                      — нажмите, чтобы заполнить —
                    </Typography.Text>
                  )}
                </div>
              )}
            </Space.Compact>
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
      {
        title: '',
        width: 60,
        align: 'right',
        render: (_: unknown, r: DraftItem) => (
          <Popconfirm
            title="Удалить позицию?"
            okText="Да"
            cancelText="Нет"
            onConfirm={() => removeItem(r.clientKey)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        ),
      },
    ],
    [editingNameKey],
  );

  const cardRender = (r: DraftItem) => {
    const isEditing = editingNameKey === r.clientKey;
    return (
    <div style={{ width: '100%' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <Typography.Text strong>№{r.lineNo}</Typography.Text>
        <Popconfirm
          title="Удалить позицию?"
          okText="Да"
          cancelText="Нет"
          onConfirm={() => removeItem(r.clientKey)}
        >
          <Button size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      </Space>
      {r.itemKind === 'asset' && (
        <Space size={4} style={{ marginTop: 4 }} wrap>
          <AssetTag />
          {r.inventoryNumber && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Инв. № {r.inventoryNumber}
            </Typography.Text>
          )}
          {r.serialNumber && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              SN {r.serialNumber}
            </Typography.Text>
          )}
        </Space>
      )}
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
          onClick={() => setEditingNameKey(r.clientKey)}
          style={{
            marginTop: 4,
            cursor: 'text',
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
          <div>{toNum(r.price) !== null ? toNum(r.price)!.toFixed(2) : '—'}</div>
        </Col>
        <Col span={12}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Сумма НДС
          </Typography.Text>
          <div>
            {(() => {
              const v = computeVatSum(r);
              return v !== null ? v.toFixed(2) : '—';
            })()}
          </div>
        </Col>
      </Row>
    </div>
    );
  };

  if (shipmentId && shipmentQuery.isLoading && !loadedShipment) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
        <Spin size="large" />
      </div>
    );
  }

  // ─── Режим формы ─────────────────────────────────────────────────────────
  if (shipmentId) {
    const pendingAt = loadedShipment?.pendingDeletionAt ?? null;
    const isPending = pendingAt !== null;
    const isAdmin = authUser?.role === 'admin';
    const canUnmark =
      isAdmin || authUser?.id === (loadedShipment?.pendingDeletionByUserId ?? null);
    return (
      <Space direction="vertical" size="middle" style={{ width: '100%', paddingBottom: isDesktop ? 0 : 96 }}>
        <Space style={{ width: '100%' }} align="center">
          {fromList && (
            <Button
              type="text"
              icon={<ArrowLeftOutlined />}
              onClick={() => navigate('/shipments')}
            />
          )}
          <Typography.Title level={3} style={{ margin: 0 }}>
            {isNew ? 'Новая отгрузка' : 'Отгрузка'}
          </Typography.Title>
          {isPending && loadedShipment && (
            <PendingDeletionTag
              at={loadedShipment.pendingDeletionAt}
              byEmail={loadedShipment.pendingDeletionByUserEmail}
              reason={loadedShipment.pendingDeletionReason}
            />
          )}
        </Space>

        {isPending && loadedShipment && (
          <Alert
            type="warning"
            showIcon
            message="Документ помечен на удаление"
            description={
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Typography.Text>
                  Пометил: {loadedShipment.pendingDeletionByUserEmail ?? '—'} ·{' '}
                  {loadedShipment.pendingDeletionAt
                    ? new Date(loadedShipment.pendingDeletionAt).toLocaleString('ru-RU')
                    : '—'}
                </Typography.Text>
                {loadedShipment.pendingDeletionReason && (
                  <Typography.Text type="secondary">
                    Причина: {loadedShipment.pendingDeletionReason}
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
                      description="Запись, фото и связи с документами будут стёрты."
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

        {loadedShipment?.sourceDocumentIds.length === 0 && !isNew && (
          <Alert
            type="info"
            showIcon
            message="Отгрузка без УПД"
            description={
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Typography.Text>
                  Этот документ был оформлен инспектором без выбранной УПД
                  (только с фото). Когда УПД появится на портале, привяжите
                  её — позиции подтянутся автоматически.
                </Typography.Text>
                {!isInspector && (
                  <Button
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
            }
          />
        )}

        <LinkSourceDocumentModal
          open={linkUpdOpen}
          onCancel={() => {
            if (!linkUpd.isPending) setLinkUpdOpen(false);
          }}
          onPick={(upd) => linkUpd.mutate(upd)}
          direction="outbound"
          siteId={loadedShipment?.siteId === SYSTEM_SITE_ID ? null : loadedShipment?.siteId ?? null}
          busy={linkUpd.isPending}
          error={linkUpdError}
        />

        <Card size="small" title="Вид отгрузки" styles={{ body: { padding: 12 } }}>
          <Segmented
            block
            options={KIND_OPTIONS}
            value={kind}
            onChange={(v) => {
              const next = v as ShipmentKind;
              setKind(next);
              if (next !== 'transfer') setDestSiteId(null);
              if (next === 'writeoff') {
                setReceiverId(null);
                setDestSiteId(null);
              }
              if (next === 'return') {
                // Возврат — только counterparty (поставщик).
                setReceiverKind('counterparty');
              }
              // Между сменой kind сбрасываем выбранный id: подрядчики и МОЛ
              // имеют разные id-пространства, чтобы не отправить чужой.
              setReceiverId(null);
            }}
          />
        </Card>

        <Row gutter={[8, 8]}>
          <Col xs={24} sm={12} md={6}>
            <Card
              size="small"
              title={
                <span>
                  Откуда <span style={{ color: '#ff4d4f' }}>*</span>
                </span>
              }
              styles={{ body: { padding: 12 } }}
            >
              <Select<string>
                size="large"
                style={{ width: '100%' }}
                placeholder="Объект"
                value={siteId ?? undefined}
                onChange={(v) => setSiteId(v)}
                showSearch
                optionFilterProp="label"
                loading={sitesQuery.isLoading}
                disabled={isInspector}
                options={sites.map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))}
              />
            </Card>
          </Col>
          {kind === 'transfer' && (
            <Col xs={24} sm={12} md={6}>
              <Card
                size="small"
                title={
                  <span>
                    Куда <span style={{ color: '#ff4d4f' }}>*</span>
                  </span>
                }
                styles={{ body: { padding: 12 } }}
              >
                <Select<string>
                  size="large"
                  style={{ width: '100%' }}
                  placeholder="Объект-приёмник"
                  value={destSiteId ?? undefined}
                  onChange={(v) => setDestSiteId(v)}
                  showSearch
                  optionFilterProp="label"
                  loading={sitesQuery.isLoading}
                  options={sites
                    .filter((s) => s.id !== siteId)
                    .map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))}
                />
              </Card>
            </Col>
          )}
          {(kind === 'contractor' || kind === 'return' || kind === 'transfer') && (
            <Col xs={24} sm={12} md={6}>
              <Card
                size="small"
                title={
                  <span>
                    Получатель <span style={{ color: '#ff4d4f' }}>*</span>
                  </span>
                }
                styles={{ body: { padding: 12 } }}
              >
                {/* Для return — только поставщик (counterparty), переключатель скрыт.
                    Для contractor и transfer — выбор «Подрядчик / МОЛ». */}
                {kind !== 'return' && (
                  <Segmented
                    block
                    style={{ marginBottom: 8 }}
                    options={[
                      { label: 'Подрядчик', value: 'counterparty' },
                      { label: 'МОЛ', value: 'mol' },
                    ]}
                    value={receiverKind}
                    onChange={(v) => {
                      setReceiverKind(v as 'counterparty' | 'mol');
                      setReceiverId(null);
                    }}
                  />
                )}
                {receiverKind === 'counterparty' ? (
                  <Select<string>
                    size="large"
                    style={{ width: '100%' }}
                    placeholder={kind === 'return' ? 'Поставщик' : 'Контрагент'}
                    value={receiverId ?? undefined}
                    onChange={(v) => setReceiverId(v)}
                    showSearch
                    optionFilterProp="label"
                    loading={counterpartiesQuery.isLoading}
                    options={counterpartyReceiverOptions.map((c) => ({
                      value: c.id,
                      label: c.name,
                    }))}
                  />
                ) : (
                  <Select<string>
                    size="large"
                    style={{ width: '100%' }}
                    placeholder="МОЛ"
                    value={receiverId ?? undefined}
                    onChange={(v) => setReceiverId(v)}
                    showSearch
                    optionFilterProp="label"
                    loading={responsiblePersonsQuery.isLoading}
                    options={responsiblePersons.map((m) => ({ value: m.id, label: m.fullName }))}
                  />
                )}
              </Card>
            </Col>
          )}
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
            <Card size="small" title="Водитель" styles={{ body: { padding: 12 } }}>
              <Input
                size="large"
                placeholder="ФИО"
                value={driverName}
                onChange={(e) => setDriverName(e.target.value)}
              />
            </Card>
          </Col>
          {linkedSource && (
            <Col xs={24} sm={12} md={6}>
              <Card
                size="small"
                // Заголовок зависит от формы источника: ТН/ОС-2 → «Накладная»,
                // УПД (или legacy) → «УПД». Аналогично «УПД»-карточке в KppPage.
                title={
                  linkedSource.kind === 'transport_waybill' ||
                  linkedSource.kind === 'os2_transfer'
                    ? 'Накладная'
                    : 'УПД'
                }
                styles={{ body: { padding: 12 } }}
              >
                <Space wrap>
                  <Tag
                    color={
                      linkedSource.kind === 'transport_waybill' ||
                      linkedSource.kind === 'os2_transfer'
                        ? 'purple'
                        : 'blue'
                    }
                  >
                    {linkedSource.docNumber ?? '— без номера —'}
                  </Tag>
                  <Typography.Text type="secondary">
                    {linkedSource.docDate ?? '—'}
                    {linkedSource.totalSum ? ` · ${linkedSource.totalSum} ₽` : ''}
                  </Typography.Text>
                </Space>
              </Card>
            </Col>
          )}
        </Row>

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
                  {shipmentId && loadedShipment && (
                    <PhotoGallery
                      deliveryId={shipmentId}
                      photos={mergedPhotos}
                      operationKind="shipment"
                    />
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
              Добавить
            </Button>
          }
          styles={{ body: { padding: 0 } }}
        >
          {items.length === 0 ? (
            <div style={{ padding: 16 }}>
              <Typography.Text type="secondary">
                Добавьте позиции вручную или сохраните без них (статус «Не оформлена»).
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

        {(() => {
          const isConfirmed = loadedShipment.status.code === 'confirmed_mol';
          const confirmTooltip = isNew
            ? 'Сначала сохраните отгрузку, затем можно подтверждать МОЛ'
            : isConfirmed
              ? `Подтверждено: ${loadedShipment.confirmedByMolUserEmail ?? '—'}, ${formatMolDate(loadedShipment.confirmedByMolAt)}`
              : (verifyReason ?? 'Подтвердить документ как МОЛ');
          // Помеченный документ — read-only: блокируем Save и Подтвердить МОЛ.
          const saveDisabled = !!verifyReason || isPending;
          // В режиме isNew подтверждение МОЛ недоступно — сначала должна
          // появиться сохранённая запись со статусом shipped.
          const confirmDisabled = isNew || isConfirmed || !!verifyReason || isPending;
          const canMarkDeletion =
            !isPending &&
            (loadedShipment.status.code === 'shipped' ||
              loadedShipment.status.code === 'confirmed_mol');
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
              <Button onClick={() => navigate('/shipments')}>Отмена</Button>
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
                onClick={() => navigate('/shipments')}
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

  // ─── Режим списка ───────────────────────────────────────────────────────
  // expectedCountQuery / acceptedCountQuery объявлены выше, рядом с
  // остальными хуками (нельзя после early return — React error #300).

  const handleTabChange = (key: string) => {
    // Сохраняем trash при смене вкладок, см. комментарий в KppPage.
    const next = new URLSearchParams(params);
    if (key === 'expected') next.set('tab', 'expected');
    else next.delete('tab');
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
      Новая отгрузка
    </Button>
  );

  // Переключатель «Удалённые» — постоянная верхняя строка (см. KppPage):
  // место зарезервировано всегда; на Ожидаемые скрыт через visibility:hidden,
  // включение автоматически переключает на вкладку Принятые.
  const trashOn = params.get('trash') === '1';
  const setTrash = (next: boolean) => {
    const p = new URLSearchParams(params);
    if (next) p.set('trash', '1');
    else p.delete('trash');
    // «Удалённые» имеют смысл только в Принятые; expectedTab у нас по
    // умолчанию (без ?tab=) — accepted в ShipmentPage, поэтому tab не трогаем.
    if (next) p.delete('tab');
    setParams(p, { replace: true });
  };
  const trashSwitchVisible = tab === 'accepted';

  return (
    <StickyPageHeader
      header={
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
          }}
        >
          <Typography.Title level={3} style={{ margin: 0 }}>
            Отгрузка
          </Typography.Title>
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
            description="Чтобы видеть отгрузки и создавать новые, обратитесь к администратору — он должен назначить вам объект на странице «Администрирование → Пользователи»."
          />
        )}
        {tab === 'expected' ? (
          <ExpectedOutbound
            onOpen={createFromUpd}
            tabs={listTabs}
            activeTab={tab}
            onTabChange={handleTabChange}
            filtersExtra={createButton}
          />
        ) : (
          <ShipmentsHistory
            onOpen={(id) => {
              setParams({});
              navigate(`/shipments?shipment=${id}&from=list`);
            }}
            tabs={listTabs}
            activeTab={tab}
            onTabChange={handleTabChange}
            filtersExtra={createButton}
          />
        )}
      </Space>
    </StickyPageHeader>
  );
}
