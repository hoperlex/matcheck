import { useState } from 'react';
import { Button, Popconfirm, Popover, Space, Tag, Typography } from 'antd';
import { DisconnectOutlined } from '@ant-design/icons';
import type { DeliverySupplierOrder } from '@matcheck/contracts';
import { formatMoneyRu } from '../../shared/utils/formatRu';
import {
  APPROVAL_STATE_COLORS,
  APPROVAL_STATE_LABELS,
  approvalText,
  stageLabel,
  worstApprovalState,
} from '../../shared/utils/estimatOrder';

const INLINE_NUMBERS = 3;

/**
 * Чип «Заказ» в шапке приёмки: номера привязанных заказов EstiMat, цвет — по
 * худшему состоянию согласования (красный — отменён или удалён, оранжевый —
 * не согласован, зелёный — согласован или виза не нужна). Клик — список с
 * визой по Москве и «Отвязать». Без привязок чипа нет.
 */
export function SupplierOrderChip({
  orders,
  onUnlink,
  unlinkPending = false,
}: {
  orders: DeliverySupplierOrder[];
  /** undefined — прав на отвязку нет, кнопки не будет. */
  onUnlink?: (order: DeliverySupplierOrder) => void;
  unlinkPending?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const worst = worstApprovalState(orders.map((o) => o.approvalState));
  if (orders.length === 0 || worst === null) return null;

  const numbers = orders.map((o) => o.number);
  const shown = numbers.slice(0, INLINE_NUMBERS).join(' · ');
  const rest = numbers.length - INLINE_NUMBERS;

  const details = (
    <Space direction="vertical" size={6} style={{ maxWidth: 420 }}>
      {orders.map((o) => (
        <Space key={o.id} size={6} wrap data-testid={`supplier-order-${o.id}`}>
          <Typography.Text strong>{o.number}</Typography.Text>
          <Tag color={APPROVAL_STATE_COLORS[o.approvalState]} style={{ marginInlineEnd: 0 }}>
            {APPROVAL_STATE_LABELS[o.approvalState]}
          </Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {stageLabel(o.sourcingStatus)} · {approvalText(o)}
            {o.amount !== null ? ` · ${formatMoneyRu(o.amount)}` : ''}
          </Typography.Text>
          {onUnlink && (
            <Popconfirm
              title="Отвязать заказ?"
              description="Заказ останется в EstiMat и во вкладке «Заказы»."
              okText="Отвязать"
              cancelText="Отмена"
              onConfirm={() => onUnlink(o)}
            >
              <Button
                type="link"
                size="small"
                danger
                icon={<DisconnectOutlined />}
                disabled={unlinkPending}
                style={{ padding: '0 4px', fontSize: 12 }}
              >
                Отвязать
              </Button>
            </Popconfirm>
          )}
        </Space>
      ))}
    </Space>
  );

  return (
    <Popover content={details} trigger="click" placement="bottomLeft" open={open} onOpenChange={setOpen}>
      <Tag
        color={APPROVAL_STATE_COLORS[worst]}
        style={{ marginInlineEnd: 0, cursor: 'pointer' }}
        data-testid="supplier-order-chip"
        data-state={worst}
      >
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {orders.length > 1 ? 'Заказы:' : 'Заказ:'}
        </Typography.Text>{' '}
        <Typography.Text strong style={{ fontSize: 12 }}>
          {shown}
          {rest > 0 ? ` +${rest}` : ''}
        </Typography.Text>
      </Tag>
    </Popover>
  );
}
