import { useEffect, useState } from 'react';
import {
  Button,
  Drawer,
  Input,
  Popconfirm,
  Space,
  Steps,
  Typography,
} from 'antd';
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { GroupSummaryHeader, type GroupSummary } from './GroupSummaryHeader';
import { QtyStepper } from './QtyStepper';
import type { GroupableItem } from './GroupedItemsList';

type Group = { key: string; summary: GroupSummary; items: GroupableItem[] };

type Props = {
  open: boolean;
  groups: Group[];
  initialGroupKey: string | null;
  onClose: () => void;
  onChange: (clientKey: string, patch: Partial<GroupableItem>) => void;
  onRemove: (clientKey: string) => void;
};

const trim = (s: string | null) => (s == null ? '—' : s.replace(/\.?0+$/, '') || '0');

export function GroupDrawer({
  open,
  groups,
  initialGroupKey,
  onClose,
  onChange,
  onRemove,
}: Props) {
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    if (!open) return;
    const idx = groups.findIndex((g) => g.key === initialGroupKey);
    setActiveIdx(idx >= 0 ? idx : 0);
  }, [open, initialGroupKey, groups]);

  if (groups.length === 0) return null;
  const safeIdx = Math.min(activeIdx, groups.length - 1);
  const current = groups[safeIdx]!;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement="right"
      width="100%"
      title={
        <GroupSummaryHeader
          group={current.summary}
          prefix={
            <Button
              type="text"
              size="small"
              icon={<ArrowLeftOutlined />}
              onClick={onClose}
              aria-label="Закрыть"
            />
          }
        />
      }
      styles={{ body: { padding: 12, paddingBottom: 96 } }}
      destroyOnClose
    >
      {groups.length > 1 && (
        <Steps
          current={safeIdx}
          size="small"
          progressDot
          items={groups.map((g) => ({ title: g.summary.name }))}
          style={{ marginBottom: 16 }}
        />
      )}

      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {current.items.map((it) => {
          const planNum =
            it.qtyPlanned !== null && it.qtyPlanned !== '' ? Number(it.qtyPlanned) : null;
          const factNum =
            it.qtyActual !== null && it.qtyActual !== '' ? Number(it.qtyActual) : null;
          return (
            <div
              key={it.clientKey}
              style={{
                background: '#fafafa',
                borderRadius: 8,
                padding: 12,
                border: '1px solid #f0f0f0',
              }}
            >
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <Typography.Text strong>№{it.lineNo}</Typography.Text>
                <Popconfirm
                  title="Удалить материал?"
                  okText="Да"
                  cancelText="Нет"
                  onConfirm={() => onRemove(it.clientKey)}
                >
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
              <Input.TextArea
                autoSize={{ minRows: 1, maxRows: 4 }}
                value={it.nameRaw}
                placeholder="Наименование"
                onChange={(e) => onChange(it.clientKey, { nameRaw: e.target.value })}
                readOnly={!!it.materialId}
                style={{ marginTop: 6 }}
              />
              <div style={{ marginTop: 10 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  План: {trim(it.qtyPlanned)} {it.unit} · Факт:
                </Typography.Text>
              </div>
              <div style={{ marginTop: 6 }}>
                <QtyStepper
                  value={factNum}
                  onChange={(n) =>
                    onChange(it.clientKey, {
                      qtyActual: n !== null && n !== undefined ? String(n) : null,
                    })
                  }
                />
              </div>
              {planNum !== null && factNum !== null && Math.abs(planNum - factNum) > 0.0001 && (
                <Typography.Text type="warning" style={{ fontSize: 12 }}>
                  Δ {factNum - planNum > 0 ? '+' : ''}
                  {factNum - planNum}
                </Typography.Text>
              )}
            </div>
          );
        })}
      </Space>

      <div
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          padding: 12,
          background: '#fff',
          borderTop: '1px solid #f0f0f0',
          display: 'flex',
          gap: 8,
          zIndex: 1100,
        }}
      >
        <Button
          size="large"
          icon={<ArrowLeftOutlined />}
          disabled={safeIdx <= 0}
          onClick={() => setActiveIdx((i) => Math.max(0, i - 1))}
          style={{ flex: 1 }}
        >
          Пред.
        </Button>
        <Button
          size="large"
          type="primary"
          icon={<ArrowRightOutlined />}
          disabled={safeIdx >= groups.length - 1}
          onClick={() => setActiveIdx((i) => Math.min(groups.length - 1, i + 1))}
          style={{ flex: 1 }}
        >
          След.
        </Button>
      </div>
    </Drawer>
  );
}
