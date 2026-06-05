import { useState, type ReactNode } from 'react';
import { Popover, Tag, Tooltip, Typography } from 'antd';
import { EditOutlined } from '@ant-design/icons';

/**
 * Inline-редактируемый «чип» — визуально как `<Tag>` из read-only
 * ViewModal'а, но клик открывает Popover с редактором. Применяется в
 * шапке edit-модалок Приёмки/Отгрузки, чтобы компактно показывать
 * Объект / Получатель / Госномер / УПД / Дата поставки и при этом
 * сохранить редактируемость. Освободившееся вертикальное место отдаём
 * Фото и Материалам.
 *
 * Использование:
 * ```
 * <InlineEditChip label="Объект" value={siteName ?? '—'} required disabled={isInspector}>
 *   {(close) => <Select onChange={(v) => { setSiteId(v); close(); }} ... />}
 * </InlineEditChip>
 * ```
 *
 * Контракт редактора: функция-children получает `close()`. Редактор
 * сам решает, когда закрыть Popover — обычно после успешного выбора
 * (Select.onChange) или после blur/Enter (Input). Если редактор не
 * вызовет `close()`, Popover закроется по клику снаружи (стандартное
 * поведение antd `trigger='click'`).
 *
 * Стиль чипа: цвет blue по умолчанию (как «Объект»/«УПД» в ViewModal);
 * если значение пусто (`isEmpty`) — серый с подсказкой-плейсхолдером.
 */
export function InlineEditChip({
  label,
  value,
  children,
  required,
  disabled,
  placeholder,
  color,
  width,
}: {
  label: string;
  /** Текст для отображения в чипе. Не путать с children — там редактор. */
  value: ReactNode;
  /** Редактор Popover. Функция, принимающая close() для закрытия. */
  children: (close: () => void) => ReactNode;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  color?: string;
  /** Ширина Popover-окна (по умолчанию 260px). */
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  const isEmpty =
    value === null || value === undefined || value === '' || value === '—';
  const display = isEmpty ? placeholder ?? '— не указано —' : value;

  const tag = (
    <Tag
      color={isEmpty ? undefined : color ?? 'blue'}
      style={{
        cursor: disabled ? 'not-allowed' : 'pointer',
        marginInlineEnd: 0,
        opacity: disabled ? 0.6 : 1,
        userSelect: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
      onClick={(e) => {
        if (disabled) return;
        e.stopPropagation();
        setOpen(true);
      }}
    >
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        {label}
        {required && <span style={{ color: '#ff4d4f' }}>*</span>}:
      </Typography.Text>{' '}
      <Typography.Text strong style={{ fontSize: 12 }}>
        {display}
      </Typography.Text>
      {!disabled && (
        <EditOutlined style={{ fontSize: 10, color: '#bfbfbf', marginLeft: 2 }} />
      )}
    </Tag>
  );

  if (disabled) {
    return (
      <Tooltip title={`«${label}» нельзя изменить здесь`} placement="bottom">
        {tag}
      </Tooltip>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(v) => setOpen(v)}
      trigger="click"
      placement="bottomLeft"
      destroyTooltipOnHide
      content={
        <div style={{ width: width ?? 260 }}>
          <Typography.Text
            type="secondary"
            style={{ fontSize: 11, display: 'block', marginBottom: 6 }}
          >
            {label}
          </Typography.Text>
          {children(close)}
        </div>
      }
    >
      {tag}
    </Popover>
  );
}
