import { Card, Descriptions, List, Space, Tag, Typography, Button } from 'antd';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Delivery } from '@matcheck/contracts';
import { api } from '../../services/api';

export default function DeliveryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({
    queryKey: ['deliveries', id],
    queryFn: () => api.get<Delivery>(`/deliveries/${id}`),
    enabled: !!id,
  });

  if (q.isLoading || !q.data) return <Card loading={q.isLoading}>Загрузка…</Card>;
  const d = q.data;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <Typography.Title level={3} style={{ margin: 0 }}>
          Приёмка
        </Typography.Title>
        <Space>
          <Tag>{d.status}</Tag>
          <Button type="primary">
            <Link to={`/kpp?delivery=${d.id}`}>Открыть на КПП</Link>
          </Button>
        </Space>
      </Space>
      <Descriptions bordered column={{ xs: 1, sm: 2 }} size="small">
        <Descriptions.Item label="Авто">{d.vehiclePlate ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Водитель">{d.driverName ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Прибытие">{d.arrivedAt ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Версия">{d.version}</Descriptions.Item>
        <Descriptions.Item label="Комментарий" span={2}>
          {d.comment ?? '—'}
        </Descriptions.Item>
      </Descriptions>
      <Card title="Позиции" size="small">
        <List
          dataSource={d.items}
          locale={{ emptyText: 'Нет позиций' }}
          renderItem={(it) => (
            <List.Item key={it.id}>
              <Space direction="vertical" size={2}>
                <Typography.Text strong>{it.nameRaw}</Typography.Text>
                <Typography.Text type="secondary">
                  План: {it.qtyPlanned ?? '—'} · Факт: {it.qtyActual ?? '—'} {it.unit}
                </Typography.Text>
                {it.comment && <Typography.Text>{it.comment}</Typography.Text>}
              </Space>
            </List.Item>
          )}
        />
      </Card>
      <Card title={`Фото (${d.photos.length})`} size="small">
        <Typography.Text type="secondary">
          Фото отображаются на странице КПП; здесь только метаданные.
        </Typography.Text>
        <List
          dataSource={d.photos}
          renderItem={(p) => (
            <List.Item key={p.id}>
              <Tag>{p.kind}</Tag>
              <Typography.Text style={{ fontSize: 12 }}>{p.s3Key}</Typography.Text>
            </List.Item>
          )}
        />
      </Card>
    </Space>
  );
}
