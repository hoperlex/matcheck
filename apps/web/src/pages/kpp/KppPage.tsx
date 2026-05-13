import { useState } from 'react';
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Space,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { UploadProps } from 'antd';
import { CameraOutlined, SaveOutlined } from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import type { Delivery, DeliveryUpsert } from '@matcheck/contracts';
import { api } from '../../services/api';
import { capturePhoto } from '../../services/photoPipeline';

type DraftItem = {
  lineNo: number;
  nameRaw: string;
  qtyPlanned: string | null;
  qtyActual: string | null;
  unit: string;
};

export default function KppPage() {
  const [items, setItems] = useState<DraftItem[]>([
    { lineNo: 1, nameRaw: '', qtyPlanned: null, qtyActual: null, unit: 'шт' },
  ]);
  const [plate, setPlate] = useState('');
  const [driver, setDriver] = useState('');
  const [comment, setComment] = useState('');
  const [savedId, setSavedId] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const payload: DeliveryUpsert = {
        status: 'verified',
        vehiclePlate: plate || null,
        driverName: driver || null,
        arrivedAt: new Date().toISOString(),
        comment: comment || null,
        sourceDocumentIds: [],
        items: items
          .filter((i) => i.nameRaw.trim().length > 0)
          .map((i) => ({
            lineNo: i.lineNo,
            nameRaw: i.nameRaw,
            qtyPlanned: i.qtyPlanned,
            qtyActual: i.qtyActual,
            unit: i.unit,
          })),
      };
      return api.post<Delivery>('/deliveries', payload);
    },
    onSuccess: (d) => {
      setSavedId(d.id);
      message.success('Приёмка сохранена');
    },
    onError: (err: Error) => message.error(err.message),
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

  const updateItem = (idx: number, patch: Partial<DraftItem>) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };

  const addItem = () => {
    setItems((prev) => [
      ...prev,
      { lineNo: prev.length + 1, nameRaw: '', qtyPlanned: null, qtyActual: null, unit: 'шт' },
    ]);
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%', paddingBottom: 96 }}>
      <Typography.Title level={3}>КПП</Typography.Title>
      <Card title="Транспорт" size="small">
        <Form layout="vertical">
          <Form.Item label="Госномер">
            <Input
              size="large"
              placeholder="А123ВВ77"
              value={plate}
              onChange={(e) => setPlate(e.target.value.toUpperCase())}
              inputMode="text"
              autoCapitalize="characters"
              style={{ fontSize: 18 }}
            />
          </Form.Item>
          <Form.Item label="Водитель">
            <Input size="large" value={driver} onChange={(e) => setDriver(e.target.value)} />
          </Form.Item>
        </Form>
      </Card>
      <Card
        title="Позиции"
        size="small"
        extra={
          <Button size="large" onClick={addItem}>
            + Позиция
          </Button>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          {items.map((it, idx) => (
            <Card key={idx} size="small" type="inner" title={`№ ${it.lineNo}`}>
              <Space direction="vertical" style={{ width: '100%' }}>
                <Input
                  size="large"
                  placeholder="Наименование материала"
                  value={it.nameRaw}
                  onChange={(e) => updateItem(idx, { nameRaw: e.target.value })}
                />
                <Space wrap>
                  <span>План:</span>
                  <InputNumber
                    size="large"
                    min={0}
                    style={{ width: 120 }}
                    value={it.qtyPlanned !== null ? Number(it.qtyPlanned) : null}
                    onChange={(v) => updateItem(idx, { qtyPlanned: v !== null ? String(v) : null })}
                  />
                  <span>Факт:</span>
                  <InputNumber
                    size="large"
                    min={0}
                    style={{ width: 120 }}
                    value={it.qtyActual !== null ? Number(it.qtyActual) : null}
                    onChange={(v) => updateItem(idx, { qtyActual: v !== null ? String(v) : null })}
                  />
                  <Input
                    size="large"
                    style={{ width: 80 }}
                    value={it.unit}
                    onChange={(e) => updateItem(idx, { unit: e.target.value })}
                  />
                </Space>
              </Space>
            </Card>
          ))}
        </Space>
      </Card>
      <Card title="Комментарий" size="small">
        <Input.TextArea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
      </Card>
      <Card title="Фото" size="small">
        <Space wrap>
          <Upload {...photoProps}>
            <Button size="large" icon={<CameraOutlined />}>
              Снять фото
            </Button>
          </Upload>
          {savedId && (
            <Tag color="green">Приёмка #{savedId.slice(0, 8)} сохранена — можно добавлять фото</Tag>
          )}
        </Space>
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
        }}
      >
        <Button
          type="primary"
          size="large"
          icon={<SaveOutlined />}
          block
          loading={save.isPending}
          onClick={() => save.mutate()}
          disabled={!plate || items.every((i) => !i.nameRaw.trim())}
          style={{ height: 56, fontSize: 18 }}
        >
          {savedId ? 'Сохранить изменения' : 'Сохранить приёмку'}
        </Button>
      </div>
      <Modal open={false} onCancel={() => undefined} title="Установить приложение" footer={null}>
        Используйте «Добавить на главный экран» в браузере для офлайн-работы.
      </Modal>
    </Space>
  );
}
