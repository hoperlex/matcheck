import { Button, InputNumber, Space } from 'antd';
import { MinusOutlined, PlusOutlined } from '@ant-design/icons';

type Props = {
  value: number | null;
  onChange: (next: number | null) => void;
  step?: number;
};

export function QtyStepper({ value, onChange, step = 1 }: Props) {
  const v = value ?? 0;
  return (
    <Space.Compact style={{ width: '100%' }}>
      <Button
        size="large"
        icon={<MinusOutlined />}
        style={{ minWidth: 44, height: 44 }}
        onClick={() => onChange(Math.max(0, v - step))}
        disabled={v <= 0}
      />
      <InputNumber
        size="large"
        min={0}
        value={value}
        onChange={(n) => onChange(n != null ? Number(n) : null)}
        style={{ flex: 1, height: 44 }}
        controls={false}
      />
      <Button
        size="large"
        icon={<PlusOutlined />}
        style={{ minWidth: 44, height: 44 }}
        onClick={() => onChange(v + step)}
      />
    </Space.Compact>
  );
}
