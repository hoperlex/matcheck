import { Space, Tag, Typography } from 'antd';
import { formatDateRangeRu, UnmergeButton } from './MachineGroupHeadCells';
import { machineHeadSummary, type MachineHeadRow } from './machineGroupRows';

/**
 * Строка поставки в карточке узкого экрана: колонок там нет, поэтому сводка —
 * одной надписью с переносами. В таблице строка поставки раскладывается по
 * колонкам (MachineGroupHeadCells); сводка у обоих одна — machineHeadSummary.
 */
export function MachineGroupHeader({
  head,
  canUnmerge,
  onUnmerge,
  unmerging,
}: {
  head: MachineHeadRow;
  canUnmerge: boolean;
  onUnmerge: () => void;
  unmerging: boolean;
}) {
  const summary = machineHeadSummary(head);
  const agg = summary.aggregates;
  const site = agg?.site.kind === 'same' ? (agg.site.row.siteName ?? null) : null;
  const date = agg?.expectedDate ? `поставка ${formatDateRangeRu(agg.expectedDate)}` : null;
  const line = [summary.title, summary.numbersFull || null, site, date].filter(Boolean).join(' · ');
  return (
    <Space size={12} wrap>
      <Typography.Text strong>{line}</Typography.Text>
      {summary.origin && <Typography.Text type="secondary">{summary.origin}</Typography.Text>}
      {summary.found && <Tag>{summary.found}</Tag>}
      {summary.accepted && <Tag color="green">{summary.accepted.full}</Tag>}
      {summary.merged && canUnmerge && (
        <UnmergeButton onUnmerge={onUnmerge} unmerging={unmerging} />
      )}
    </Space>
  );
}
