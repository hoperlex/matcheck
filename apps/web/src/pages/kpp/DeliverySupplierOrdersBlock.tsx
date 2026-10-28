import { useState } from 'react';
import { Alert, Collapse, Descriptions, Space, Table, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { DeliverySupplierOrder, EstimatOrderItem, EstimatOrderItemsResponse } from '@matcheck/contracts';
import { api } from '../../services/api';
import { formatMoneyRu } from '../../shared/utils/formatRu';
import {
  APPROVAL_STATE_COLORS,
  APPROVAL_STATE_LABELS,
  approvalText,
  formatMsk,
  stageLabel,
} from '../../shared/utils/estimatOrder';

/** Состав заказа — из EstiMat по требованию, только пока блок раскрыт. */
function OrderItems({ deliveryId, orderId }: { deliveryId: string; orderId: string }) {
  const items = useQuery({
    queryKey: ['delivery-supplier-order-items', deliveryId, orderId],
    queryFn: () =>
      api.get<EstimatOrderItemsResponse>(`/deliveries/${deliveryId}/supplier-orders/${orderId}/items`),
    staleTime: 60_000,
    retry: false,
  });
  if (items.isError) return <Alert type="warning" showIcon message="Состав заказа не загрузился" />;
  const data = items.data;
  if (data && data.state !== 'ready') {
    return (
      <Typography.Text type="secondary">
        Состав сейчас недоступен{data.message ? `: ${data.message}` : ''}.
      </Typography.Text>
    );
  }
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      {data?.fetchedAt && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Состав на {formatMsk(data.fetchedAt)} (МСК)
        </Typography.Text>
      )}
      <Table<EstimatOrderItem>
        rowKey="id"
        size="small"
        loading={items.isLoading}
        dataSource={data?.items ?? []}
        pagination={{ pageSize: 50, showSizeChanger: false, hideOnSinglePage: true }}
        scroll={{ x: 700 }}
        columns={[
          { title: 'Материал', dataIndex: 'materialName', ellipsis: { showTitle: true } },
          { title: 'Ед.', dataIndex: 'unit', width: 70 },
          {
            title: 'Кол-во',
            dataIndex: 'quantity',
            width: 110,
            align: 'right',
            render: (v: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(v),
          },
          {
            title: 'Дата поставки',
            dataIndex: 'deliveryDate',
            width: 130,
            render: (v: string | null) => (v ? formatMsk(v, false) : '—'),
          },
          { title: 'Подрядчик', dataIndex: 'contractorName', width: 200, ellipsis: true, render: (v) => v ?? '—' },
        ]}
        locale={{ emptyText: 'Позиций нет' }}
      />
    </Space>
  );
}

function OrderCard({ deliveryId, order, open }: { deliveryId: string; order: DeliverySupplierOrder; open: boolean }) {
  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Space size={6} wrap>
        <Typography.Text strong>{order.number}</Typography.Text>
        <Tag color={APPROVAL_STATE_COLORS[order.approvalState]} style={{ marginInlineEnd: 0 }}>
          {APPROVAL_STATE_LABELS[order.approvalState]}
        </Tag>
        {order.siteMismatch && <Tag color="orange">привязан к приёмке другого объекта</Tag>}
        {order.supplierMatch === false && <Tag color="orange">поставщик в заказе другой</Tag>}
      </Space>
      {/* Короткие поля — парами, длинные (поставщик, подрядчики) — на всю
          ширину: иначе название в 150–200 символов сжимало соседние ячейки до
          переноса посреди слова. */}
      <Descriptions
        size="small"
        column={{ xs: 1, md: 2 }}
        bordered
        styles={{ label: { width: 140, whiteSpace: 'nowrap' } }}
      >
        <Descriptions.Item label="Стадия">{stageLabel(order.sourcingStatus)}</Descriptions.Item>
        <Descriptions.Item label="Виза">{approvalText(order)}</Descriptions.Item>
        <Descriptions.Item label="Объект EstiMat">
          {[order.projectCode, order.projectName].filter(Boolean).join(' · ') || '—'}
        </Descriptions.Item>
        <Descriptions.Item label="Сумма">
          <span style={{ whiteSpace: 'nowrap' }}>{formatMoneyRu(order.amount)}</span>
        </Descriptions.Item>
        <Descriptions.Item label="Поставщик" span="filled">
          {order.supplierName ?? '— не выбран —'}
          {order.supplierInn ? `, ИНН ${order.supplierInn}` : ''}
        </Descriptions.Item>
        <Descriptions.Item label="Подрядчик" span="filled">
          {order.contractors.length === 0
            ? '—'
            : order.contractors.map((c) => (
                <div key={c.id}>
                  {c.name}
                  {c.type === 'mol' ? ' (МОЛ)' : ''}
                  {c.inn ? `, ИНН ${c.inn}` : ''}
                </div>
              ))}
        </Descriptions.Item>
      </Descriptions>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Обновлено из EstiMat {formatMsk(order.lastSeenAt)} (МСК)
      </Typography.Text>
      {open && <OrderItems deliveryId={deliveryId} orderId={order.id} />}
    </Space>
  );
}

/**
 * Блок «Заказ» карточки приёмки: что заказано, у кого и для кого, согласован ли
 * заказ окончательно. Свёрнут; состав каждого заказа читается из EstiMat только
 * при раскрытии. Без привязок блока нет.
 */
export function DeliverySupplierOrdersBlock({
  deliveryId,
  orders,
}: {
  deliveryId: string;
  orders: DeliverySupplierOrder[];
}) {
  const [open, setOpen] = useState(false);
  if (orders.length === 0) return null;
  const label =
    orders.length === 1
      ? `Заказ ${orders[0]!.number} · ${approvalText(orders[0]!)}`
      : `Заказы (${orders.length})`;
  return (
    <Collapse
      size="small"
      activeKey={open ? ['supplier-orders'] : []}
      onChange={(keys) => setOpen((Array.isArray(keys) ? keys : [keys]).includes('supplier-orders'))}
      items={[
        {
          key: 'supplier-orders',
          label,
          children: (
            <Space direction="vertical" size="large" style={{ width: '100%' }}>
              {orders.map((o) => (
                <OrderCard key={o.id} deliveryId={deliveryId} order={o} open={open} />
              ))}
            </Space>
          ),
        },
      ]}
    />
  );
}
