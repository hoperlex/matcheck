import { useState, type ReactNode } from 'react';
import { Popover, Tooltip, Typography } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { HeaderChip } from './HeaderChip';

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
 * если значение пусто (`isEmpty`) — серый с подсказкой-плейсхолдером. Вид —
 * общий для шапки (HeaderChip): высота 24px, подпись серым, значение жирным.
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
  onOpenChange,
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
  /**
   * Окно открылось или закрылось — и кликом снаружи, и через `close()`. Нужен
   * редактору, который при открытии берёт значение с сервера (получатель
   * приёмки сохраняется сразу, и брошенный выбор вида не должен оставаться).
   */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const change = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  const close = () => change(false);

  const isEmpty =
    value === null || value === undefined || value === '' || value === '—';
  const display = isEmpty ? placeholder ?? '— не указано —' : value;

  const tag = (
    <HeaderChip
      label={label}
      required={required}
      value={display}
      color={isEmpty ? undefined : (color ?? 'blue')}
      interactive
      disabled={disabled}
      suffix={!disabled && <EditOutlined style={{ fontSize: 10, color: '#bfbfbf' }} />}
      onClick={(e) => {
        if (disabled) return;
        e.stopPropagation();
        setOpen(true);
      }}
    />
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
      onOpenChange={(v) => change(v)}
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
