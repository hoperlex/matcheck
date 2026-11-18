import type { MouseEvent } from 'react';
import { Button, Popconfirm, Space, Tooltip, Typography } from 'antd';
import {
  CheckSquareOutlined,
  EditOutlined,
  LinkOutlined,
  UngroupOutlined,
} from '@ant-design/icons';
import { deliveriesCount, type GroupHeadRow } from './deliveryGroupRows';
import { dispatcherBulkPlan, dispatcherConfirmTitle } from './dispatcherBulk';

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
  canDispatch,
  onLink,
  onEdit,
  onDissolve,
  onDispatcher,
  dissolving,
  dispatching,
  wrap = false,
}: {
  head: GroupHeadRow;
  siteName: string | null;
  canGroup: boolean;
  canLinkUpd: boolean;
  /** Отметка «Диспетчер» всей группе — то же право, что у одиночной. */
  canDispatch: boolean;
  onLink: () => void;
  onEdit: () => void;
  onDissolve: () => void;
  /** true — поставить отметку тем, у кого её нет; false — снять у всех. */
  onDispatcher: (checked: boolean) => void;
  dissolving: boolean;
  dispatching: boolean;
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
  // Счёт приходит с сервера по всей группе (и по приёмкам с других страниц);
  // нет счёта — роли отметка не видна.
  const dispatcher = canDispatch ? head.group.dispatcher : undefined;
  const plan = dispatcher ? dispatcherBulkPlan(dispatcher) : null;
  const notReady = dispatcher ? total - dispatcher.eligible : 0;
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
      {dispatcher && plan && (
        // Счёт — на самой кнопке: строка группы не переносится, и отдельная
        // надпись вытолкнула бы «Разгруппировать» за край на экране 1280.
        <span onClick={stop}>
          <Tooltip
            title={
              plan.block ??
              (notReady > 0
                ? `Ещё не оформлены: ${deliveriesCount(notReady)} — им отметку не поставить`
                : undefined)
            }
          >
            <span>
              {plan.block !== null ? (
                <Button size="small" icon={<CheckSquareOutlined />} disabled>
                  Диспетчер: {dispatcher.checked} из {dispatcher.eligible}
                </Button>
              ) : (
                <Popconfirm
                  title={dispatcherConfirmTitle(plan, 'group')}
                  okText={plan.mode === 'check' ? 'Отметить' : 'Снять'}
                  cancelText="Отмена"
                  onConfirm={() => onDispatcher(plan.mode === 'check')}
                >
                  <Button
                    size="small"
                    type={plan.mode === 'uncheck' ? 'primary' : 'default'}
                    icon={<CheckSquareOutlined />}
                    loading={dispatching}
                  >
                    Диспетчер: {dispatcher.checked} из {dispatcher.eligible}
                  </Button>
                </Popconfirm>
              )}
            </span>
          </Tooltip>
        </span>
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
