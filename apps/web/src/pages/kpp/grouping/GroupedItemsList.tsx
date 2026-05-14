import { useMemo, useState } from 'react';
import {
  Button,
  Card,
  Collapse,
  Input,
  InputNumber,
  Popconfirm,
  Space,
  Table,
  Typography,
  type TableProps,
} from 'antd';
import { DeleteOutlined, RightOutlined } from '@ant-design/icons';
import { useBreakpoint } from '../../../shared/hooks/useBreakpoint';
import { GroupSummaryHeader, type GroupSummary } from './GroupSummaryHeader';
import { GroupDrawer } from './GroupDrawer';
import { useExpandedGroups } from './useExpandedGroups';

export type GroupableItem = {
  clientKey: string;
  lineNo: number;
  nameRaw: string;
  qtyPlanned: string | null;
  qtyActual: string | null;
  unit: string;
  materialId: string | null;
  groupName: string | null;
};

type Group = {
  key: string;
  summary: GroupSummary;
  items: GroupableItem[];
};

const FALLBACK_GROUP = 'Прочее';

const trimQty = (s: string) =>
  s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;

function buildGroups(items: GroupableItem[]): Group[] {
  const order: string[] = [];
  const byName = new Map<string, GroupableItem[]>();
  for (const it of items) {
    const name = it.groupName?.trim() || FALLBACK_GROUP;
    if (!byName.has(name)) {
      byName.set(name, []);
      order.push(name);
    }
    byName.get(name)!.push(it);
  }
  return order.map((name) => {
    const groupItems = byName.get(name)!;
    let filled = 0;
    let totalPlan = 0;
    let totalFact = 0;
    for (const it of groupItems) {
      const plan = it.qtyPlanned !== null && it.qtyPlanned !== '' ? Number(it.qtyPlanned) : null;
      const fact = it.qtyActual !== null && it.qtyActual !== '' ? Number(it.qtyActual) : null;
      if (fact !== null) filled += 1;
      if (plan !== null) totalPlan += plan;
      if (fact !== null) totalFact += fact;
    }
    return {
      key: name,
      summary: {
        name,
        itemsCount: groupItems.length,
        filledCount: filled,
        totalPlan,
        totalFact,
      },
      items: groupItems,
    };
  });
}

type Props = {
  items: GroupableItem[];
  deliveryId: string | null;
  onChange: (clientKey: string, patch: Partial<GroupableItem>) => void;
  onRemove: (clientKey: string) => void;
};

export function GroupedItemsList({ items, deliveryId, onChange, onRemove }: Props) {
  const bp = useBreakpoint();
  const groups = useMemo(() => buildGroups(items), [items]);
  const { expanded, setExpanded } = useExpandedGroups(deliveryId);
  const [drawerKey, setDrawerKey] = useState<string | null>(null);

  if (bp === 'mobile') {
    return (
      <>
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          {groups.map((g) => (
            <Card
              key={g.key}
              size="small"
              hoverable
              onClick={() => setDrawerKey(g.key)}
              styles={{ body: { padding: 12 } }}
            >
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <div style={{ flex: 1 }}>
                  <GroupSummaryHeader group={g.summary} />
                </div>
                <RightOutlined style={{ color: '#bfbfbf' }} />
              </Space>
            </Card>
          ))}
        </Space>
        <GroupDrawer
          open={drawerKey !== null}
          groups={groups}
          initialGroupKey={drawerKey}
          onClose={() => setDrawerKey(null)}
          onChange={onChange}
          onRemove={onRemove}
        />
      </>
    );
  }

  // Desktop: Collapse + inline Table per group
  return (
    <Collapse
      activeKey={expanded}
      onChange={(keys) => setExpanded(Array.isArray(keys) ? keys : [keys])}
      bordered={false}
      items={groups.map((g) => ({
        key: g.key,
        label: <GroupSummaryHeader group={g.summary} />,
        children: <GroupTable items={g.items} onChange={onChange} onRemove={onRemove} />,
      }))}
    />
  );
}

function GroupTable({
  items,
  onChange,
  onRemove,
}: {
  items: GroupableItem[];
  onChange: (clientKey: string, patch: Partial<GroupableItem>) => void;
  onRemove: (clientKey: string) => void;
}) {
  const columns: NonNullable<TableProps<GroupableItem>['columns']> = [
    { title: '№', dataIndex: 'lineNo', width: 56 },
    {
      title: 'Название',
      dataIndex: 'nameRaw',
      render: (_: unknown, r: GroupableItem) => (
        <Input.TextArea
          autoSize={{ minRows: 1, maxRows: 4 }}
          value={r.nameRaw}
          placeholder="Наименование"
          onChange={(e) => onChange(r.clientKey, { nameRaw: e.target.value })}
          readOnly={!!r.materialId}
        />
      ),
    },
    {
      title: 'План',
      width: 90,
      render: (_: unknown, r: GroupableItem) =>
        r.qtyPlanned !== null && r.qtyPlanned !== '' ? trimQty(r.qtyPlanned) : '—',
    },
    {
      title: 'Факт',
      width: 130,
      render: (_: unknown, r: GroupableItem) => (
        <InputNumber
          size="small"
          min={0}
          style={{ width: '100%' }}
          value={r.qtyActual !== null && r.qtyActual !== '' ? Number(r.qtyActual) : null}
          onChange={(v) =>
            onChange(r.clientKey, {
              qtyActual: v !== null && v !== undefined ? String(v) : null,
            })
          }
        />
      ),
    },
    {
      title: 'Ед.',
      width: 80,
      render: (_: unknown, r: GroupableItem) => (
        <Input
          size="small"
          value={r.unit}
          onChange={(e) => onChange(r.clientKey, { unit: e.target.value })}
        />
      ),
    },
    {
      title: '',
      width: 60,
      align: 'right',
      render: (_: unknown, r: GroupableItem) => (
        <Popconfirm
          title="Удалить материал?"
          okText="Да"
          cancelText="Нет"
          onConfirm={() => onRemove(r.clientKey)}
        >
          <Button size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ];

  if (items.length === 0) {
    return (
      <Typography.Text type="secondary" style={{ paddingLeft: 16 }}>
        Нет позиций
      </Typography.Text>
    );
  }
  return (
    <Table<GroupableItem>
      dataSource={items}
      columns={columns}
      rowKey="clientKey"
      pagination={false}
      size="small"
    />
  );
}
