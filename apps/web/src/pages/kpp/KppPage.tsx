import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Button,
  Card,
  Col,
  Collapse,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Segmented,
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
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Delivery,
  DeliveryStatusCode,
  SourceDocument,
  SourceDocumentDetail,
  Status,
} from '@matcheck/contracts';
import { api } from '../../services/api';
import { capturePhoto } from '../../services/photoPipeline';
import {
  applyLocalEdit,
  effectiveState,
  enqueueMutation,
  getDelivery,
  markTombstone,
  upsertServerSnapshot,
} from '../../services/deliveries';
import { runSync } from '../../services/sync';
import { db } from '../../lib/db';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
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

function newKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function KppPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const deliveryId = params.get('delivery');
  const fromAccepted = params.get('from') === 'accepted';
  const tab: ListTab = params.get('tab') === 'accepted' ? 'accepted' : 'expected';

  const [items, setItems] = useState<DraftItem[]>([]);
  const [plate, setPlate] = useState('');
  const [comment, setComment] = useState('');
  const [selectedUpd, setSelectedUpd] = useState<SourceDocument | null>(null);
  const [loadedDelivery, setLoadedDelivery] = useState<Delivery | null>(null);
  const [creating, setCreating] = useState(false);

  // Сбрасываем локальное состояние при выходе из формы
  useEffect(() => {
    if (!deliveryId) {
      setItems([]);
      setPlate('');
      setComment('');
      setSelectedUpd(null);
      setLoadedDelivery(null);
    }
  }, [deliveryId]);

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
    setLoadedDelivery(d);
    setPlate(d.vehiclePlate ?? '');
    setComment(d.comment ?? '');
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
    setCreating(true);
    try {
      const id = crypto.randomUUID();
      await applyLocalEdit(id, {});
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
        await capturePhoto(deliveryId, file, 'cargo');
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

  const removeItem = (key: string) => {
    setItems((prev) =>
      prev.filter((it) => it.clientKey !== key).map((it, i) => ({ ...it, lineNo: i + 1 })),
    );
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!loadedDelivery) throw new Error('Приёмка ещё не загружена');
      // Локальный patch: status.code = 'filled' (полный Status придёт с сервера в pullSync).
      const nextStatus: Status = {
        ...loadedDelivery.status,
        code: 'filled' satisfies DeliveryStatusCode,
      };
      const patch: Partial<Delivery> = {
        status: nextStatus,
        supplierId: selectedUpd?.supplierId ?? loadedDelivery.supplierId ?? null,
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
      await applyLocalEdit(loadedDelivery.id, patch);
      await enqueueMutation({
        id: crypto.randomUUID(),
        kind: 'delivery_upsert',
        entityId: loadedDelivery.id,
        baseVersion: loadedDelivery.version,
        payload: null,
      });
      void runSync();
    },
    onSuccess: () => {
      message.success('Приёмка сохранена');
      void queryClient.invalidateQueries({ queryKey: ['deliveries'] });
      navigate('/kpp?tab=accepted');
    },
    onError: (err: Error) => message.error(err.message),
  });

  const cancel = useMutation({
    mutationFn: async () => {
      if (!deliveryId) return;
      const dbi = await db();
      const local = await dbi.get('deliveries', deliveryId);

      // Черновик, который ни разу не уехал на сервер — чистим только локально.
      if (!local || local.server === null) {
        // Удаляем связанные фото и pending-мутации
        const photoIds = (
          await dbi.transaction('photos').store.index('byDelivery').getAll(deliveryId)
        ).map((p) => p.id);
        const mutationIds = (
          await dbi.transaction('mutations').store.index('byEntity').getAll(deliveryId)
        ).map((m) => m.id);
        const tx = dbi.transaction(['deliveries', 'photos', 'mutations'], 'readwrite');
        for (const pid of photoIds) await tx.objectStore('photos').delete(pid);
        for (const mid of mutationIds) await tx.objectStore('mutations').delete(mid);
        await tx.objectStore('deliveries').delete(deliveryId);
        await tx.done;
        return;
      }

      await markTombstone(deliveryId);
      await enqueueMutation({
        id: crypto.randomUUID(),
        kind: 'delivery_delete',
        entityId: deliveryId,
        baseVersion: loadedDelivery?.version ?? local.version,
        payload: null,
      });
      void runSync();
    },
    onSuccess: () => {
      message.success('Приёмка удалена');
      void queryClient.invalidateQueries({ queryKey: ['deliveries'] });
      navigate('/kpp');
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
      {
        title: '',
        width: 60,
        align: 'right',
        render: (_: unknown, r: DraftItem) => (
          <Popconfirm
            title="Удалить материал?"
            okText="Да"
            cancelText="Нет"
            onConfirm={() => removeItem(r.clientKey)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        ),
      },
    ],
    [],
  );

  const cardRender = (r: DraftItem) => (
    <div style={{ width: '100%' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <Typography.Text strong>№{r.lineNo}</Typography.Text>
        <Popconfirm
          title="Удалить материал?"
          okText="Да"
          cancelText="Нет"
          onConfirm={() => removeItem(r.clientKey)}
        >
          <Button size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      </Space>
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

  if (deliveryId && deliveryQuery.isLoading && !loadedDelivery) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
        <Spin size="large" />
      </div>
    );
  }

  // === Режим формы (открыта приёмка) ===
  if (deliveryId) {
    return (
      <Space direction="vertical" size="middle" style={{ width: '100%', paddingBottom: 96 }}>
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
          <Col xs={24} sm={12}>
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
          <Col xs={24} sm={12}>
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
                onRemove={removeItem}
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
          <Popconfirm
            title="Удалить эту приёмку?"
            description="Запись и связанные фото будут удалены."
            okText="Да, удалить"
            cancelText="Нет"
            okButtonProps={{ danger: true }}
            onConfirm={() => cancel.mutate()}
          >
            <Button size="large" danger loading={cancel.isPending} style={{ flex: 1 }}>
              Отмена
            </Button>
          </Popconfirm>
          <Tooltip title={verifyReason ?? ''} placement="top">
            <span style={{ flex: 1, display: 'inline-flex' }}>
              <Button
                type="primary"
                size="large"
                style={{ flex: 1 }}
                loading={save.isPending}
                disabled={!!verifyReason}
                onClick={() => save.mutate()}
              >
                Сохранить
              </Button>
            </span>
          </Tooltip>
        </div>
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
          <Button type="primary" icon={<PlusOutlined />} loading={creating} onClick={createBlank}>
            Новая приёмка
          </Button>
        </Space>
      </Space>

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
