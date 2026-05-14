import { Progress, Space, Tag, Typography } from 'antd';
import { CheckCircleFilled, ExclamationCircleOutlined, WarningOutlined } from '@ant-design/icons';
import type { ReactNode } from 'react';

export type GroupSummary = {
  name: string;
  itemsCount: number;
  filledCount: number;
  totalPlan: number;
  totalFact: number;
};

const trim = (n: number) =>
  n.toLocaleString('ru-RU', { maximumFractionDigits: 3, minimumFractionDigits: 0 });

export function GroupSummaryHeader({
  group,
  prefix,
}: {
  group: GroupSummary;
  prefix?: ReactNode;
}): ReactNode {
  const pct = group.itemsCount > 0 ? (group.filledCount / group.itemsCount) * 100 : 0;
  const allFilled = group.filledCount === group.itemsCount && group.itemsCount > 0;
  const diff = group.totalFact - group.totalPlan;
  const hasMismatch = allFilled && Math.abs(diff) > 0.0001;
  let tag: ReactNode;
  if (!allFilled) {
    tag = (
      <Tag color="default" icon={<ExclamationCircleOutlined />}>
        {group.filledCount}/{group.itemsCount}
      </Tag>
    );
  } else if (hasMismatch) {
    tag = (
      <Tag color="orange" icon={<WarningOutlined />}>
        Δ {diff > 0 ? '+' : ''}
        {trim(diff)}
      </Tag>
    );
  } else {
    tag = (
      <Tag color="green" icon={<CheckCircleFilled />}>
        ok
      </Tag>
    );
  }
  return (
    <div style={{ width: '100%' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <Space>
          {prefix}
          <Typography.Text strong>{group.name}</Typography.Text>
          <Typography.Text type="secondary">({group.itemsCount})</Typography.Text>
        </Space>
        <Space>
          <Typography.Text style={{ fontSize: 13 }}>
            Σплан {trim(group.totalPlan)} / Σфакт {trim(group.totalFact)}
          </Typography.Text>
          {tag}
        </Space>
      </Space>
      <Progress
        percent={Math.round(pct)}
        size="small"
        showInfo={false}
        strokeColor={allFilled ? (hasMismatch ? '#fa8c16' : '#52c41a') : '#1677ff'}
        style={{ margin: 0 }}
      />
    </div>
  );
}
