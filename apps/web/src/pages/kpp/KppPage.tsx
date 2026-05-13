import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AutoComplete,
  Button,
  Card,
  Col,
  Collapse,
  Drawer,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Row,
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
  CameraOutlined,
  CheckOutlined,
  DeleteOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  Delivery,
  DeliveryUpsert,
  SourceDocument,
  SourceDocumentDetail,
  SourceDocumentListResponseSchema,
} from '@matcheck/contracts';
import type { z } from 'zod';
import { api } from '../../services/api';
import { capturePhoto } from '../../services/photoPipeline';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';

type DraftItem = {
  clientKey: string;
  lineNo: number;
  nameRaw: string;
  qtyPlanned: string | null;
  qtyActual: string | null;
  unit: string;
  materialId: string | null;
};

type SourceList = z.infer<typeof SourceDocumentListResponseSchema>;
type SaveStatus = 'draft' | 'verified';

const GREEN = '#52c41a';

const trimQty = (s: string) =>
  s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;

function newKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function KppPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const deliveryId = params.get('delivery');

  const [items, setItems] = useState<DraftItem[]>([]);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [pendingStatus, setPendingStatus] = useState<SaveStatus | null>(null);

  const [plate, setPlate] = useState('');
  const [comment, setComment] = useState('');
  const [savedId, setSavedId] = useState<string | null>(null);
  const [updQuery, setUpdQuery] = useState('');
  const [selectedUpd, setSelectedUpd] = useState<SourceDocument | null>(null);
  const [loadedDelivery, setLoadedDelivery] = useState<Delivery | null>(null);

  const editingItem = useMemo(
    () => items.find((i) => i.clientKey === editingKey) ?? null,
    [items, editingKey],
  );

  const deliveryQuery = useQuery({
    queryKey: ['deliveries', deliveryId],
    queryFn: () => api.get<Delivery>(`/deliveries/${deliveryId}`),
    enabled: !!deliveryId && !loadedDelivery,
  });

  useEffect(() => {
    const d = deliveryQuery.data;
    if (!d || loadedDelivery) return;
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
      })),
    );
    setConfirmed(new Set());
    if (d.sourceDocumentIds.length > 0) {
      api
        .get<SourceDocument>(`/source-documents/${d.sourceDocumentIds[0]}`)
        .then(setSelectedUpd)
        .catch(() => undefined);
    }
  }, [deliveryQuery.data, loadedDelivery]);

  const updSuggestions = useQuery({
    queryKey: ['source-documents', 'unaccepted-upd', updQuery],
    queryFn: () =>
      api.get<SourceList>(
        `/source-documents?kind=upd&unaccepted=true${
          updQuery ? `&q=${encodeURIComponent(updQuery)}` : ''
        }&limit=20`,
      ),
    enabled: !savedId,
  });

  const loadDetail = useMutation({
    mutationFn: (id: string) => api.get<SourceDocumentDetail>(`/source-documents/${id}`),
    onSuccess: (detail) => {
      setSelectedUpd(detail);
      setItems(
        detail.items.map((it, idx) => ({
          clientKey: newKey(),
          lineNo: idx + 1,
          nameRaw: it.nameRaw,
          qtyPlanned: it.qty,
          qtyActual: it.qty,
          unit: it.unit,
          materialId: it.materialId,
        })),
      );
      setConfirmed(new Set());
    },
    onError: (err: Error) => message.error(`Не удалось загрузить УПД: ${err.message}`),
  });

  const save = useMutation({
    mutationFn: async (status: SaveStatus) => {
      setPendingStatus(status);
      const payload: DeliveryUpsert = {
        id: loadedDelivery?.id,
        baseVersion: loadedDelivery?.version,
        status,
        supplierId: selectedUpd?.supplierId ?? null,
        vehiclePlate: plate || null,
        arrivedAt: loadedDelivery?.arrivedAt ?? new Date().toISOString(),
        comment: comment || null,
        sourceDocumentIds: selectedUpd ? [selectedUpd.id] : [],
        items: items
          .filter((i) => i.nameRaw.trim().length > 0)
          .map((i) => ({
            lineNo: i.lineNo,
            nameRaw: i.nameRaw,
            qtyPlanned: i.qtyPlanned,
            qtyActual: i.qtyActual,
            unit: i.unit,
            materialId: i.materialId,
          })),
      };
      return api.post<Delivery>('/deliveries', payload);
    },
    onSuccess: (d, status) => {
      setLoadedDelivery(d);
      if (status === 'verified') {
        setSavedId(d.id);
        message.success('Приёмка сохранена');
      } else {
        message.success('Черновик сохранён');
        if (!deliveryId) {
          navigate(`/kpp?delivery=${d.id}`, { replace: true });
        }
      }
      setPendingStatus(null);
    },
    onError: (err: Error) => {
      message.error(err.message);
      setPendingStatus(null);
    },
  });

  const photoProps: UploadProps = {
    accept: 'image/*',
    showUploadList: false,
    beforeUpload: async (file) => {
      if (!savedId) {
        message.warning('Сначала сохраните приёмку — фото привязываются к ней.');
        return false;
      }
      try {
        await capturePhoto(savedId, file, 'cargo');
        message.success('Фото добавлено');
      } catch (err) {
        message.error(`Не удалось добавить фото: ${(err as Error).message}`);
      }
      return false;
    },
  };

  const updateField = (key: string, patch: Partial<DraftItem>) => {
    setItems((prev) => prev.map((it) => (it.clientKey === key ? { ...it, ...patch } : it)));
    if ('qtyActual' in patch || 'nameRaw' in patch || 'unit' in patch) {
      setConfirmed((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
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
      },
    ]);
  };

  const removeItem = (key: string) => {
    setItems((prev) =>
      prev.filter((it) => it.clientKey !== key).map((it, i) => ({ ...it, lineNo: i + 1 })),
    );
    setConfirmed((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  const toggleConfirm = (key: string) => {
    setConfirmed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const updOptions = (updSuggestions.data?.items ?? []).map((sd) => ({
    value: sd.id,
    label: `${sd.docNumber ?? '— без номера —'}${sd.docDate ? ` от ${sd.docDate}` : ''}${
      sd.totalSum ? ` · ${sd.totalSum} ₽` : ''
    }`,
  }));

  type Column = NonNullable<TableProps<DraftItem>['columns']>[number];
  const columns: Column[] = [
    { title: '№', dataIndex: 'lineNo', width: 56 },
    {
      title: 'Название',
      dataIndex: 'nameRaw',
      ellipsis: { showTitle: false },
      render: (v: string) =>
        v ? (
          <Tooltip title={v} placement="topLeft">
            <span>{v}</span>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">— пусто —</Typography.Text>
        ),
    },
    {
      title: 'Кол-во',
      width: 140,
      render: (_: unknown, r: DraftItem) =>
        r.qtyActual !== null && r.qtyActual !== ''
          ? `${trimQty(r.qtyActual)} ${r.unit}`
          : <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: '',
      width: 110,
      align: 'right',
      render: (_: unknown, r: DraftItem) => (
        <Space size={4} onClick={(e) => e.stopPropagation()}>
          <Button
            size="small"
            type={confirmed.has(r.clientKey) ? 'primary' : 'default'}
            icon={<CheckOutlined />}
            style={
              confirmed.has(r.clientKey)
                ? { background: GREEN, borderColor: GREEN }
                : undefined
            }
            onClick={() => toggleConfirm(r.clientKey)}
          />
          <Popconfirm
            title="Удалить материал?"
            okText="Да"
            cancelText="Нет"
            onConfirm={() => removeItem(r.clientKey)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const cardRender = (r: DraftItem) => (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        minWidth: 0,
      }}
    >
      <Typography.Text strong style={{ width: 28, flexShrink: 0 }}>
        №{r.lineNo}
      </Typography.Text>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {r.nameRaw || <Typography.Text type="secondary">— пусто —</Typography.Text>}
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {r.qtyActual !== null && r.qtyActual !== '' ? `${trimQty(r.qtyActual)} ${r.unit}` : '—'}
        </Typography.Text>
      </div>
      <Space size={4} onClick={(e) => e.stopPropagation()}>
        <Button
          type={confirmed.has(r.clientKey) ? 'primary' : 'default'}
          icon={<CheckOutlined />}
          style={
            confirmed.has(r.clientKey)
              ? { background: GREEN, borderColor: GREEN }
              : undefined
          }
          onClick={() => toggleConfirm(r.clientKey)}
        />
        <Popconfirm
          title="Удалить материал?"
          okText="Да"
          cancelText="Нет"
          onConfirm={() => removeItem(r.clientKey)}
        >
          <Button danger icon={<DeleteOutlined />} />
        </Popconfirm>
      </Space>
    </div>
  );

  const allConfirmed = items.length > 0 && confirmed.size === items.length;
  const locked = !!savedId;
  const isFromVerified = loadedDelivery?.status === 'verified';

  const verifyReason: string | null = (() => {
    if (locked) return null;
    const reasons: string[] = [];
    if (items.length === 0) reasons.push('Добавьте хотя бы один материал');
    else if (confirmed.size !== items.length) reasons.push('Подтвердите все строки галочкой');
    if (!plate.trim()) reasons.push('Заполните госномер');
    return reasons.length ? reasons.join(' · ') : null;
  })();

  if (deliveryId && deliveryQuery.isLoading && !loadedDelivery) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%', paddingBottom: 96 }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        КПП
      </Typography.Title>

      <Row gutter={[8, 8]}>
        <Col xs={24} sm={12}>
          <Card size="small" title="Госномер" styles={{ body: { padding: 12 } }}>
            <Input
              size="large"
              placeholder="А123ВВ77"
              value={plate}
              onChange={(e) => setPlate(e.target.value.toUpperCase())}
              autoCapitalize="characters"
              disabled={locked}
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
                <Button
                  size="small"
                  onClick={() => {
                    setSelectedUpd(null);
                    setItems([]);
                    setConfirmed(new Set());
                  }}
                  disabled={locked}
                >
                  Сменить
                </Button>
              </Space>
            ) : (
              <AutoComplete
                size="large"
                style={{ width: '100%' }}
                placeholder="Введите номер УПД для поиска"
                value={updQuery}
                onChange={(v) => setUpdQuery(v)}
                onSelect={(value) => {
                  loadDetail.mutate(value);
                  setUpdQuery('');
                }}
                options={updOptions}
                notFoundContent={updSuggestions.isLoading ? 'Поиск…' : 'Ничего не найдено'}
                filterOption={false}
                disabled={locked}
              />
            )}
          </Card>
        </Col>
      </Row>

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
                disabled={locked}
              />
            ),
          },
          {
            key: 'photos',
            label: savedId ? `Фото (приёмка #${savedId.slice(0, 8)})` : 'Фото',
            children: (
              <Space wrap>
                <Upload {...photoProps}>
                  <Button size="large" icon={<CameraOutlined />} disabled={!savedId}>
                    Снять фото
                  </Button>
                </Upload>
                {!savedId && (
                  <Typography.Text type="secondary">
                    Доступно после сохранения приёмки.
                  </Typography.Text>
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
          <Button size="small" icon={<PlusOutlined />} onClick={addItem} disabled={locked}>
            Материал
          </Button>
        }
        styles={{ body: { padding: 0 } }}
      >
        {items.length === 0 ? (
          <div style={{ padding: 16 }}>
            <Typography.Text type="secondary">
              Выберите УПД выше — материалы подтянутся автоматически. Или добавьте строки вручную.
            </Typography.Text>
          </div>
        ) : (
          <ResponsiveTable<DraftItem>
            items={items}
            columns={columns}
            rowKey="clientKey"
            cardRender={cardRender}
            onRowClick={(r) => setEditingKey(r.clientKey)}
          />
        )}
      </Card>

      <Drawer
        open={editingKey !== null}
        onClose={() => setEditingKey(null)}
        placement="right"
        width={Math.min(480, typeof window !== 'undefined' ? window.innerWidth : 480)}
        title={editingItem ? `Материал № ${editingItem.lineNo}` : ''}
        destroyOnClose
      >
        {editingItem && (
          <Form layout="vertical">
            <Form.Item label="Наименование">
              <Input.TextArea
                autoSize={{ minRows: 2, maxRows: 6 }}
                value={editingItem.nameRaw}
                onChange={(e) => updateField(editingItem.clientKey, { nameRaw: e.target.value })}
                readOnly={!!editingItem.materialId}
              />
            </Form.Item>
            <Form.Item label="План (из УПД)">
              <InputNumber
                value={editingItem.qtyPlanned !== null ? Number(editingItem.qtyPlanned) : null}
                disabled
                style={{ width: '100%' }}
              />
            </Form.Item>
            <Form.Item label="Факт">
              <InputNumber
                autoFocus
                size="large"
                min={0}
                style={{ width: '100%' }}
                value={editingItem.qtyActual !== null ? Number(editingItem.qtyActual) : null}
                onChange={(v) =>
                  updateField(editingItem.clientKey, {
                    qtyActual: v !== null && v !== undefined ? String(v) : null,
                  })
                }
              />
            </Form.Item>
            <Form.Item label="Ед.">
              <Input
                value={editingItem.unit}
                onChange={(e) => updateField(editingItem.clientKey, { unit: e.target.value })}
              />
            </Form.Item>
            <Button type="primary" block onClick={() => setEditingKey(null)}>
              Готово
            </Button>
          </Form>
        )}
      </Drawer>

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
          loading={save.isPending && pendingStatus === 'draft'}
          disabled={
            locked || isFromVerified || (save.isPending && pendingStatus !== 'draft')
          }
          onClick={() => save.mutate('draft')}
        >
          Сохранить черновик
        </Button>
        <Tooltip title={verifyReason ?? ''} placement="top">
          <span style={{ flex: 1, display: 'inline-flex' }}>
            <Button
              type="primary"
              size="large"
              style={{
                flex: 1,
                background: allConfirmed && !locked && plate.trim() ? GREEN : undefined,
                borderColor: allConfirmed && !locked && plate.trim() ? GREEN : undefined,
              }}
              loading={save.isPending && pendingStatus === 'verified'}
              disabled={
                locked ||
                !!verifyReason ||
                (save.isPending && pendingStatus !== 'verified')
              }
              onClick={() => save.mutate('verified')}
            >
              {locked ? 'Сохранено' : 'Сохранить'}
            </Button>
          </span>
        </Tooltip>
      </div>
    </Space>
  );
}
