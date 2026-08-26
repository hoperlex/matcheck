import { Select, Tag, Tooltip } from 'antd';
import type { CSSProperties, ReactElement } from 'react';

export type FilterSelectOption = { value: string; label: string };

/**
 * Селект панели фильтров. Один компонент на все списки — чтобы панель вела себя
 * одинаково и не «дёргалась».
 *
 * Три правила, ради которых он существует:
 *
 * 1. ФИКСИРОВАННАЯ ширина, не minWidth. При mode="multiple" antd рисует теги
 *    через rc-overflow, и режим maxTagCount="responsive" вешает на контейнер
 *    ResizeObserver: показал тег → поле шире → влез ещё один → свернул → уже →
 *    и так каждый кадр. С эластичной шириной измерение не сходится, и вся
 *    панель прыгает влево-вправо (по крестику ✕ не попасть).
 * 2. maxTagCount={1} — responsive-путь с его ResizeObserver не включается
 *    вовсе, а второе и последующие значения дают стабильный «+N».
 * 3. Длинное название обрезается многоточием ВНУТРИ поля, а целиком читается
 *    в подсказке: названия контрагентов бывают по 150+ символов, и без
 *    ограничения тег растягивал бы поле, а вместе с ним и всю строку фильтров.
 *
 * Геометрия панели не зависит ни от выбранного значения, ни от того,
 * загрузились ли опции: перенос строки возможен только от ширины окна.
 */
export function FilterSelect({
  mode,
  width,
  placeholder,
  value,
  onChange,
  options,
  loading,
  disabled,
  allowClear = true,
  size,
  style,
}: {
  mode?: 'multiple';
  width: number;
  placeholder?: string;
  value: string[] | string | undefined;
  onChange: (v: never) => void;
  options: ReadonlyArray<FilterSelectOption>;
  loading?: boolean;
  disabled?: boolean;
  allowClear?: boolean;
  size?: 'small' | 'middle' | 'large';
  style?: CSSProperties;
}): ReactElement {
  // Ширина тега: поле минус крестик очистки, стрелка и «+N».
  const tagMaxWidth = Math.max(48, width - 96);
  return (
    <Select
      mode={mode}
      style={{ width, ...style }}
      placeholder={placeholder}
      value={value as never}
      onChange={onChange}
      options={options as FilterSelectOption[]}
      allowClear={allowClear}
      showSearch
      optionFilterProp="label"
      loading={loading}
      disabled={disabled}
      size={size}
      maxTagCount={mode === 'multiple' ? 1 : undefined}
      // Стабильный «+N» вместо антдшного «+ N ...»: число не меняет ширину.
      maxTagPlaceholder={mode === 'multiple' ? (omitted) => `+${omitted.length}` : undefined}
      tagRender={
        mode === 'multiple'
          ? ({ label, closable, onClose }) => (
              <Tooltip title={typeof label === 'string' ? label : undefined}>
                <Tag
                  closable={closable}
                  onClose={onClose}
                  onMouseDown={(e) => {
                    // Без этого клик по тегу забирает фокус у поля и antd
                    // закрывает выпадающий список раньше, чем сработает onClose.
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  style={{
                    maxWidth: tagMaxWidth,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    marginInlineEnd: 4,
                  }}
                >
                  {label}
                </Tag>
              </Tooltip>
            )
          : undefined
      }
      // Одиночный режим: длинное значение тоже не должно распирать поле.
      labelRender={
        mode === undefined
          ? (item) => (
              <Tooltip title={typeof item.label === 'string' ? item.label : undefined}>
                <span
                  style={{
                    display: 'inline-block',
                    maxWidth: width - 40,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    verticalAlign: 'bottom',
                  }}
                >
                  {item.label}
                </span>
              </Tooltip>
            )
          : undefined
      }
    />
  );
}
