import { Card, Space, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { Counterparty, DeliveryListResponseSchema } from '@matcheck/contracts';
import type { z } from 'zod';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';

type List = z.infer<typeof DeliveryListResponseSchema>;
type Row = List['items'][number];

export function DeliveriesHistory({ onOpen }: { onOpen: (id: string) => void }) {
  const list = useQuery({
    queryKey: ['deliveries'],
    queryFn: () => api.get<List>('/deliveries'),
  });

  const counterparties = useQuery({
    queryKey: ['counterparties'],
    queryFn: () =>
      api.get<{ items: Counterparty[]; total: number }>('/counterparties'),
  });

  const suppliersMap = new Map<string, string>();
  for (const c of counterparties.data?.items ?? []) {
    suppliersMap.set(c.id, c.name);
  }
  const supplierName = (id: string | null | undefined) =>
    id ? suppliersMap.get(id) ?? '—' : '—';

  return (
    <ResponsiveTable<Row>
      items={list.data?.items ?? []}
      loading={list.isLoading}
      rowKey="id"
      onRowClick={(r) => onOpen(r.id)}
      emptyText="Нет приёмок"
      columns={[
        {
          title: 'Статус',
          key: 'status',
          render: (_: unknown, r: Row) => (
            <Tag color={r.status.color ?? 'default'}>{r.status.label}</Tag>
          ),
        },
        { title: 'Авто', dataIndex: 'vehiclePlate' },
        { title: 'Прибытие', dataIndex: 'arrivedAt' },
        {
          title: 'Поставщик',
          key: 'supplier',
          render: (_: unknown, r: Row) => supplierName(r.supplierId),
        },
        {
          title: 'Кол-во',
          key: 'itemsCount',
          render: (_: unknown, r: Row) => r.items?.length ?? 0,
        },
      ]}
      cardRender={(r) => (
        <Card style={{ width: '100%' }} size="small">
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Space>
              <Tag color={r.status.color ?? 'default'}>{r.status.label}</Tag>
              <Typography.Text strong>{r.vehiclePlate ?? 'Без номера'}</Typography.Text>
            </Space>
            <Typography.Text type="secondary">
              {supplierName(r.supplierId)} · {r.items?.length ?? 0} стр.
            </Typography.Text>
            <Typography.Text type="secondary">{r.arrivedAt ?? '—'}</Typography.Text>
          </Space>
        </Card>
      )}
    />
  );
}
