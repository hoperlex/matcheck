import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Input,
  InputNumber,
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
  PlusOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Counterparty,
  Delivery,
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
  upsertServerSnapshot,
} from '../../services/deliveries';
import { runSync } from '../../services/sync';
import { db } from '../../lib/db';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { useBreakpoint } from '../../shared/hooks/useBreakpoint';
import { DeliveriesHistory } from './DeliveriesHistory';
import { ExpectedUpds } from './ExpectedUpds';
import { PhotoGallery } from './PhotoGallery';
import { VehicleFillGauge } from './VehicleFillGauge';
import { GroupedItemsList } from './grouping/GroupedItemsList';

type DraftItem = {
  clientKey: string;
  lineNo: number;
  nameRaw: string;
  qtyPlanned: string | null;
  qtyActual: string | null;
  unit: string;
  materialId: string | null;
  volumeM3: string | null;
  massKg: string | null;
  volumeConfidence: 'low' | 'medium' | 'high' | null;
  groupName: string | null;
};

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

  // Для inspector_kpp объект фиксирован значением из БД; селект блокируется,
  // а сервер всё равно перепишет siteId в запросе на сохранение.
  const authUser = useAuthStore((s) => s.user);
  const isInspector = authUser?.role === 'inspector_kpp';
  const inspectorSiteId = isInspector ? (authUser?.siteId ?? null) : null;
  const inspectorWithoutSite = isInspector && !inspectorSiteId;

  const [items, setItems] = useState<DraftItem[]>([]);
  const [plate, setPlate] = useState('');
  const [comment, setComment] = useState('');
  const [siteId, setSiteId] = useState<string | null>(inspectorSiteId);
  const [contractorId, setContractorId] = useState<string | null>(null);
  const [selectedUpd, setSelectedUpd] = useState<SourceDocument | null>(null);
  const [creating, setCreating] = useState(false);

  // Сбрасываем локальное состояние при выходе из формы. Для inspector_kpp
  // siteId восстанавливается из назначенного объекта (не очищается).
  useEffect(() => {
    if (!deliveryId) {
      setItems([]);
      setPlate('');
      setComment('');
      setSiteId(inspectorSiteId);
      setContractorId(null);
      setSelectedUpd(null);
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

  const sites = sitesQuery.data?.items ?? [];
  const counterparties = counterpartiesQuery.data?.items ?? [];

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
    enabled: !!deliveryId,
  });

  // Производное значение: react-query — единственный источник истины для
  // загруженной приёмки. Использование useState + setLoadedDelivery в useEffect
  // приводило к гонке рендера (data уже есть, isLoading=false, но state ещё null).
  const loadedDelivery: Delivery | null = deliveryQuery.data ?? null;

  // Черновик (server === null) не имеет photos в effectiveState — считаем локально
  const photosCountQuery = useQuery({
    queryKey: ['photos-count', deliveryId],
    queryFn: async () => {
      if (!deliveryId) return 0;
      const dbi = await db();
      const all = await dbi
        .transaction('photos')
        .store.index('byDelivery')
        .getAll(deliveryId);
      return all.length;
    },
    enabled: !!deliveryId,
  });

  useEffect(() => {
    const d = deliveryQuery.data;
    if (!d) return;
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
    setContractorId((prev) => prev ?? d.contractorId ?? null);
    setItems(
      d.items.map((it, idx) => ({
        clientKey: newKey(),
        lineNo: idx + 1,
        nameRaw: it.nameRaw,
        qtyPlanned: it.qtyPlanned,
        qtyActual: it.qtyActual,
        unit: it.unit,
        materialId: it.materialId,
        volumeM3: it.volumeM3 ?? null,
        massKg: it.massKg ?? null,
        volumeConfidence: it.volumeConfidence ?? null,
        groupName: it.groupName ?? null,
      })),
    );
    if (d.sourceDocumentIds.length > 0 && !selectedUpd) {
      api
        .get<SourceDocument>(`/source-documents/${d.sourceDocumentIds[0]}`)
        .then(setSelectedUpd)
        .catch(() => undefined);
    }
  }, [deliveryQuery.data, selectedUpd]);

  /**
   * Создаёт пустую приёмку. UUID генерируется на клиенте, запись сразу появляется
   * в IndexedDB, а мутация уезжает на сервер через runSync (best-effort, может догнаться позже).
   */
  const createBlank = async () => {
    if (creating) return;
    if (inspectorWithoutSite) {
      message.error('Объект не назначен — обратитесь к администратору');
      return;
    }
    setCreating(true);
    try {
      const id = crypto.randomUUID();
      // siteId — обязателен на сервере. Для inspector_kpp сразу подставляем
      // назначенный объект (сервер всё равно перезапишет). Для остальных —
      // системный «Без объекта» как заглушку, чтобы черновик мог уехать
      // на сервер (status='not_filled') и не зависал в pending-mutations.
      const initialSiteId = inspectorSiteId ?? SYSTEM_SITE_ID;
      await applyLocalEdit(id, { siteId: initialSiteId });
      await enqueueMutation({
        id: crypto.randomUUID(),
        kind: 'delivery_upsert',
        entityId: id,
        baseVersion: 0,
        payload: null,
      });
      void runSync();
      navigate(`/kpp?delivery=${id}`);
    } catch (err) {
      message.error(`Не удалось создать приёмку: ${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  };

  /**
   * Создаёт приёмку по выбранному УПД. Детали УПД читаются из локального кеша (его наполняет
   * pullSync); при offline и пустом кеше — ошибка. UUID клиентский, мутация уезжает асинхронно.
   */
  const createFromUpd = async (upd: SourceDocument) => {
    if (creating) return;
    if (inspectorWithoutSite) {
      message.error('Объект не назначен — обратитесь к администратору');
      return;
    }
    setCreating(true);
    try {
      const dbi = await db();
      let detail = await dbi.get('source_documents', upd.id);
      if (!detail) {
        try {
          detail = await api.get<SourceDocumentDetail>(`/source-documents/${upd.id}`);
        } catch {
          message.error('Нет связи и детали УПД ещё не загружены — попробуйте позже');
          return;
        }
      }
      const id = crypto.randomUUID();
      const patch: Partial<Delivery> = {
        siteId: inspectorSiteId ?? SYSTEM_SITE_ID,
        supplierId: detail.supplierId ?? null,
        sourceDocumentIds: [upd.id],
        items: detail.items.map((it, i) => ({
          id: crypto.randomUUID(),
          materialId: it.materialId ?? null,
          nameRaw: it.nameRaw,
          qtyPlanned: it.qty,
          qtyActual: it.qty,
          unit: it.unit,
          comment: null,
          lineNo: i + 1,
          volumeM3: it.volumeM3 ?? null,
          massKg: it.massKg ?? null,
          volumeConfidence: it.volumeConfidence ?? null,
          groupName: it.groupName ?? null,
        })),
      };
      await applyLocalEdit(id, patch);
      await enqueueMutation({
        id: crypto.randomUUID(),
        kind: 'delivery_upsert',
        entityId: id,
        baseVersion: 0,
        payload: null,
      });
      void runSync();
      navigate(`/kpp?delivery=${id}`);
    } catch (err) {
      message.error(`Не удалось открыть УПД: ${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  };

  const photoProps: UploadProps = {
    accept: 'image/*',
    capture: 'environment',
    showUploadList: false,
    beforeUpload: async (file) => {
      if (!deliveryId) return false;
      try {
        await capturePhoto('delivery', deliveryId, file, 'cargo');
        message.success('Фото добавлено');
        // Локальный счётчик фото — invalidate на photos-count.
        // Photos попадут в Delivery.photos после успешного upload + следующего pullSync.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['photos-count', deliveryId] }),
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
        volumeM3: null,
        massKg: null,
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
      contractorId,
      vehiclePlate: plate || null,
      arrivedAt: loadedDelivery.arrivedAt ?? new Date().toISOString(),
      comment: comment || null,
      sourceDocumentIds: selectedUpd
        ? [selectedUpd.id]
        : loadedDelivery.sourceDocumentIds,
      items: items
        .filter((i) => i.nameRaw.trim().length > 0)
        .map((i) => ({
          id: crypto.randomUUID(),
          materialId: i.materialId,
          nameRaw: i.nameRaw,
          qtyPlanned: i.qtyPlanned,
          qtyActual: i.qtyActual,
          unit: i.unit,
          comment: null,
          lineNo: i.lineNo,
          volumeM3: i.volumeM3,
          massKg: i.massKg,
          volumeConfidence: i.volumeConfidence,
          groupName: i.groupName,
        })),
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
      // Обычное «Сохранить» не должно «понижать» подтверждённый документ —
      // если он уже confirmed_mol, оставляем этот статус.
      const currentCode = loadedDelivery.status.code as DeliveryStatusCode;
      const nextCode: DeliveryStatusCode =
        currentCode === 'confirmed_mol' ? 'confirmed_mol' : 'filled';
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

  // Берём максимум: локальные (включая черновик, ещё не на сервере) или server-snapshot.
  const photosCount = Math.max(
    photosCountQuery.data ?? 0,
    loadedDelivery?.photos.length ?? 0,
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
      { title: '№', dataIndex: 'lineNo', width: 56 },
      {
        title: 'Название',
        dataIndex: 'nameRaw',
        render: (_: unknown, r: DraftItem) => (
          <Input.TextArea
            autoSize={{ minRows: 1, maxRows: 4 }}
            value={r.nameRaw}
            placeholder="Наименование"
            onChange={(e) => updateField(r.clientKey, { nameRaw: e.target.value })}
            readOnly={!!r.materialId}
          />
        ),
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
    ],
    [],
  );

  const cardRender = (r: DraftItem) => (
    <div style={{ width: '100%' }}>
      <Typography.Text strong>№{r.lineNo}</Typography.Text>
      <Input.TextArea
        autoSize={{ minRows: 1, maxRows: 4 }}
        value={r.nameRaw}
        placeholder="Наименование"
        onChange={(e) => updateField(r.clientKey, { nameRaw: e.target.value })}
        readOnly={!!r.materialId}
        style={{ marginTop: 4 }}
      />
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
    </div>
  );

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
            Приёмка
          </Typography.Title>
        </Space>

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
            <Card size="small" title="Подрядчик" styles={{ body: { padding: 12 } }}>
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
            <Card size="small" title="УПД" styles={{ body: { padding: 12 } }}>
              {selectedUpd ? (
                <Space wrap>
                  <Tag color="blue">{selectedUpd.docNumber ?? '— без номера —'}</Tag>
                  <Typography.Text type="secondary">
                    {selectedUpd.docDate ?? '—'} · {selectedUpd.totalSum ?? '—'} ₽
                  </Typography.Text>
                </Space>
              ) : (
                <Typography.Text type="secondary">— без УПД —</Typography.Text>
              )}
            </Card>
          </Col>
        </Row>

        <VehicleFillGauge
          items={items.map((it) => ({
            qty:
              it.qtyActual !== null && it.qtyActual !== ''
                ? Number(it.qtyActual)
                : it.qtyPlanned !== null && it.qtyPlanned !== ''
                  ? Number(it.qtyPlanned)
                  : 0,
            volumeM3: it.volumeM3 !== null && it.volumeM3 !== '' ? Number(it.volumeM3) : null,
            massKg: it.massKg !== null && it.massKg !== '' ? Number(it.massKg) : null,
          }))}
        />

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
                    <PhotoGallery
                      deliveryId={deliveryId}
                      photos={loadedDelivery.photos}
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
          ) : items.some((it) => it.groupName) ? (
            <div style={{ padding: 12 }}>
              <GroupedItemsList
                items={items}
                deliveryId={deliveryId}
                onChange={(key, patch) => updateField(key, patch as Partial<DraftItem>)}
              />
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
          const isConfirmed = loadedDelivery.status.code === 'confirmed_mol';
          const confirmTooltip = isConfirmed
            ? `Подтверждено: ${loadedDelivery.confirmedByMolUserEmail ?? '—'}, ${formatMolDate(loadedDelivery.confirmedByMolAt)}`
            : (verifyReason ?? 'Подтвердить документ как МОЛ');
          const saveDisabled = !!verifyReason;
          const confirmDisabled = isConfirmed || !!verifyReason;
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
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <Typography.Title level={3} style={{ margin: 0 }}>
          Приёмка
        </Typography.Title>
        <Space wrap>
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
          <Button
            type="primary"
            icon={<PlusOutlined />}
            loading={creating}
            onClick={createBlank}
            disabled={inspectorWithoutSite}
          >
            Новая приёмка
          </Button>
        </Space>
      </Space>

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
  );
}
