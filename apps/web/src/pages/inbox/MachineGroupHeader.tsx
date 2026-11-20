import type { MouseEvent } from 'react';
import { Button, Popconfirm, Space, Tag, Typography } from 'antd';
import { UngroupOutlined } from '@ant-design/icons';
import { formatDateRu } from '../../shared/utils/formatRu';
import { isPendingRow } from './pendingRow';
import { machineHeadParts, type MachineHeadRow } from './machineGroupRows';

const stop = (event: MouseEvent) => event.stopPropagation();

/**
 * Строка поставки над её документами: сколько документов, номера, откуда
 * пришла, принята ли. Кнопка «Разъединить» — только у объединённой вручную
 * машины. Клик по самой строке сворачивает группу (кнопка не всплывает).
 */
export function MachineGroupHeader({
  head,
  canUnmerge,
  onUnmerge,
  unmerging,
  wrap = false,
}: {
  head: MachineHeadRow;
  canUnmerge: boolean;
  onUnmerge: () => void;
  unmerging: boolean;
  /** Переносить по строкам — в карточке узкого экрана; в таблице одна строка. */
  wrap?: boolean;
}) {
  const parts = machineHeadParts(head);
  const firstDoc = head.group.members.find((r) => !isPendingRow(r));
  const site = firstDoc?.siteName ?? null;
  const date = firstDoc?.expectedDate ? `поставка ${formatDateRu(firstDoc.expectedDate)}` : null;
  const line = [parts.title, parts.numbers || null, site, date].filter(Boolean).join(' · ');
  return (
    <Space size={12} wrap={wrap} style={wrap ? undefined : { whiteSpace: 'nowrap' }}>
      <Typography.Text strong>{line}</Typography.Text>
      <Typography.Text type="secondary">{parts.origin}</Typography.Text>
      {parts.found && <Tag>{parts.found}</Tag>}
      {parts.accepted && <Tag color="green">{parts.accepted}</Tag>}
      {parts.merged && canUnmerge && (
        <span onClick={stop}>
          <Popconfirm
            title="Разъединить машину?"
            description="Все отправки вернутся в исходные машины, на планшете снова будут отдельные карточки"
            okText="Разъединить"
            cancelText="Отмена"
            onConfirm={onUnmerge}
          >
            <Button size="small" icon={<UngroupOutlined />} loading={unmerging}>
              Разъединить
            </Button>
          </Popconfirm>
        </span>
      )}
    </Space>
  );
}
