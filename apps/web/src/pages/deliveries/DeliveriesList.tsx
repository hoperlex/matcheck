import { Typography, Card, Tag, Space, Button } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { DeliveryListResponseSchema } from '@matcheck/contracts';
import type { z } from 'zod';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';

type List = z.infer<typeof DeliveryListResponseSchema>;
type Row = List['items'][number];

const statusColor: Record<Row['status'], string> = {
  expected: 'gold',
  arrived: 'blue',
  verified: 'green',
  rejected: 'red',
};

const statusLabel: Record<Row['status'], string> = {
  expected: 'Ожидается',
  arrived: 'Прибыла',
  verified: 'Принято',
  rejected: 'Отклонена',
};

export default function DeliveriesListPage() {
  const list = useQuery({
    queryKey: ['deliveries'],
    queryFn: () => api.get<List>('/deliveries'),
  });

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          Приёмки
        </Typography.Title>
        <Button type="primary">
          <Link to="/kpp">Открыть КПП</Link>
        </Button>
      </Space>
      <ResponsiveTable<Row>
        items={list.data?.items ?? []}
        loading={list.isLoading}
        rowKey="id"
        columns={[
          {
            title: 'Статус',
            dataIndex: 'status',
            render: (s: Row['status']) => <Tag color={statusColor[s]}>{statusLabel[s]}</Tag>,
          },
          { title: 'Авто', dataIndex: 'vehiclePlate' },
          { title: 'Водитель', dataIndex: 'driverName' },
          { title: 'Прибытие', dataIndex: 'arrivedAt' },
          {
            title: '',
            key: 'actions',
            render: (_: unknown, row: Row) => <Link to={`/deliveries/${row.id}`}>Открыть</Link>,
          },
        ]}
        cardRender={(r) => (
          <Card style={{ width: '100%' }} size="small">
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Space>
                <Tag color={statusColor[r.status]}>{statusLabel[r.status]}</Tag>
                <Typography.Text strong>{r.vehiclePlate ?? 'Без номера'}</Typography.Text>
              </Space>
              <Typography.Text type="secondary">{r.driverName ?? '—'}</Typography.Text>
              <Link to={`/deliveries/${r.id}`}>Открыть</Link>
            </Space>
          </Card>
        )}
      />
    </div>
  );
}
