import { useState } from 'react';
import { Popconfirm, Tag, Tooltip, Typography } from 'antd';
import { EditOutlined } from '@ant-design/icons';

/**
 * Кликабельный чип-флаг (ОС / Транзит) для шапки edit-модалок
 * Приёмки и Отгрузки. Поведение:
 *
 *  - value=true:  показывает цветной Tag «emoji label». Клик → Popconfirm
 *                 «Убрать признак?». При confirm дергает onChange(false).
 *  - value=false: показывает серый Tag «+ label» (приглашение поставить).
 *                 Клик → Popconfirm «Поставить признак?» → onChange(true).
 *  - disabled:    Tag показывается только если value=true (как раньше);
 *                 клик не реагирует, появляется Tooltip с причиной.
 *
 * Это сохраняет старое поведение для инспектора (видит цветной Tag,
 * не может изменить) и даёт менеджеру/админу возможность поставить или
 * убрать признак без полной пересохранки приёмки/отгрузки.
 */
export function FlagChip({
  label,
  emoji,
  color,
  value,
  disabled,
  loading,
  onChange,
}: {
  label: string;
  emoji: string;
  /** antd Tag color при value=true. */
  color: string;
  value: boolean;
  disabled?: boolean;
  loading?: boolean;
  onChange: (next: boolean) => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);

  // Inspector / read-only режим: рендерим как раньше — цветной Tag,
  // если флаг true; ничего, если false. Никакого Popconfirm.
  if (disabled) {
    if (!value) return null;
    return (
      <Tooltip title={`«${label}» нельзя изменить здесь`}>
        <Tag color={color} style={{ marginInlineEnd: 0 }}>
          {emoji} {label}
        </Tag>
      </Tooltip>
    );
  }

  const tag = value ? (
    <Tag
      color={color}
      style={{ marginInlineEnd: 0, cursor: 'pointer', userSelect: 'none' }}
    >
      {emoji} {label}
      <EditOutlined style={{ fontSize: 10, color: '#fff', marginLeft: 4, opacity: 0.7 }} />
    </Tag>
  ) : (
    <Tag style={{ marginInlineEnd: 0, cursor: 'pointer', userSelect: 'none' }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        + {label}
      </Typography.Text>
    </Tag>
  );

  return (
    <Popconfirm
      open={open}
      onOpenChange={(v) => setOpen(v)}
      title={value ? `Убрать признак «${label}»?` : `Поставить признак «${label}»?`}
      okText={value ? 'Убрать' : 'Поставить'}
      cancelText="Отмена"
      okButtonProps={{ loading, danger: value }}
      onConfirm={() => {
        onChange(!value);
        setOpen(false);
      }}
    >
      {tag}
    </Popconfirm>
  );
}
