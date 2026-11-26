import { useState } from 'react';
import { Popconfirm, Tooltip } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { HeaderAddButton, HeaderChip } from './HeaderChip';

/**
 * Кликабельный чип-флаг (ОС / Транзит) для шапки edit-модалок
 * Приёмки и Отгрузки. Поведение:
 *
 *  - value=true:  показывает цветной Tag «emoji label». Клик → Popconfirm
 *                 «Убрать признак?». При confirm дергает onChange(false).
 *  - value=false: показывает пунктирную кнопку «+ label» (приглашение поставить),
 *                 такую же, как «+ Договор» и «+ Заказ».
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
        <HeaderChip color={color}>
          {emoji} {label}
        </HeaderChip>
      </Tooltip>
    );
  }

  // Карандаш серый, как у остальных плашек: белый на светлом фоне тега не виден.
  const tag = value ? (
    <HeaderChip
      color={color}
      interactive
      suffix={<EditOutlined style={{ fontSize: 10, color: '#bfbfbf' }} />}
    >
      {emoji} {label}
    </HeaderChip>
  ) : (
    <HeaderAddButton>{`+ ${label}`}</HeaderAddButton>
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
