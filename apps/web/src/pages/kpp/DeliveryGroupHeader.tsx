import type { MouseEvent } from 'react';
import { Button, Popconfirm, Space, Typography } from 'antd';
import { EditOutlined, LinkOutlined, UngroupOutlined } from '@ant-design/icons';
import { deliveriesCount, type GroupHeadRow } from './deliveryGroupRows';

const stop = (event: MouseEvent) => event.stopPropagation();

/**
 * Строка группы над её приёмками: сколько приёмок, объект, сколько из них уже
 * с УПД из ЭДО, и действия над всей группой. Кнопки не всплывают в строку:
 * клик по самой строке сворачивает группу.
 */
export function DeliveryGroupHeader({
  head,
  siteName,
  canGroup,
  canLinkUpd,
  onLink,
  onEdit,
  onDissolve,
  dissolving,
  wrap = false,
}: {
  head: GroupHeadRow;
  siteName: string | null;
  canGroup: boolean;
  canLinkUpd: boolean;
  onLink: () => void;
  onEdit: () => void;
  onDissolve: () => void;
  dissolving: boolean;
  /** Переносить по строкам — в карточке узкого экрана; в таблице одна строка. */
  wrap?: boolean;
}) {
  const total = head.group.members.length;
  const shown = head.visibleIds.length;
  const edo = head.group.edoLinkedCount;
  const parts = [
    `Группа · ${deliveriesCount(total)}`,
    siteName,
    shown < total ? `на странице ${shown} из ${total}` : null,
  ].filter(Boolean);
  return (
    <Space size={12} wrap={wrap} style={wrap ? undefined : { whiteSpace: 'nowrap' }}>
      <Typography.Text strong>{parts.join(' · ')}</Typography.Text>
      {canLinkUpd && edo !== undefined && (
        <Typography.Text type={edo === total ? 'success' : 'secondary'}>
          УПД из ЭДО: у {edo} из {total}
        </Typography.Text>
      )}
      {canLinkUpd && (
        <Button size="small" icon={<LinkOutlined />} onClick={(e) => (stop(e), onLink())}>
          Привязать УПД из ЭДО
        </Button>
      )}
      {canGroup && (
        <Button size="small" icon={<EditOutlined />} onClick={(e) => (stop(e), onEdit())}>
          Изменить состав
        </Button>
      )}
      {canGroup && (
        <span onClick={stop}>
          <Popconfirm
            title={`Разгруппировать ${deliveriesCount(total)}?`}
            description="Приёмки и привязанные УПД останутся, исчезнет только группа."
            okText="Разгруппировать"
            cancelText="Отмена"
            onConfirm={onDissolve}
          >
            <Button size="small" icon={<UngroupOutlined />} loading={dissolving}>
              Разгруппировать
            </Button>
          </Popconfirm>
        </span>
      )}
    </Space>
  );
}
