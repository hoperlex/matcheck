import {
  forwardRef,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Button, Tag, Typography, theme, type ButtonProps, type TagProps } from 'antd';

/**
 * Плашки шапки карточек приёмки и отгрузки — один вид для всех.
 *
 * Раньше шапка собиралась из шести разных элементов: синие теги, тег без
 * деления на подпись и значение, голый тумблер, пунктирные кнопки, зелёные
 * теги ЭДО с кнопками внутри (выше остальных) и обычная кнопка «Признак» со
 * шрифтом 14px. Теперь все они высотой 24px, со шрифтом 12px и устроены
 * одинаково: подпись серым, значение жирным.
 *
 * Длинное значение не обрезается, а переносится внутри плашки: полный текст
 * виден и на телефоне, где подсказка по наведению не работает. Действия
 * (`extra`) и значок (`suffix`) не сжимаются никогда — переносится только
 * значение.
 */

/** Высота плашки и кнопки шапки — как у antd Button size="small". */
export const HEADER_CHIP_HEIGHT = 24;

/** Значение длиннее переносится на следующую строку внутри плашки. */
const VALUE_MAX_WIDTH = 360;

const CHIP_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  minHeight: HEADER_CHIP_HEIGHT,
  height: 'auto',
  // 16px строки + 3+3 отступа + рамка 1+1 = 24px.
  lineHeight: '16px',
  paddingBlock: 3,
  paddingInline: 7,
  marginInlineEnd: 0,
  maxWidth: '100%',
  verticalAlign: 'middle',
  fontSize: 12,
};

/** Кнопка в виде плашки (выпадающий «Признак», «+ …»): та же высота и шрифт. */
export const HEADER_BUTTON_CHIP_STYLE: CSSProperties = {
  height: HEADER_CHIP_HEIGHT,
  paddingInline: 7,
  fontSize: 12,
};

export type HeaderChipProps = Omit<HTMLAttributes<HTMLSpanElement>, 'color' | 'children'> & {
  /** Подпись серым; двоеточие ставит сама плашка. Без подписи — только значение. */
  label?: ReactNode;
  /** Красная звёздочка после подписи. */
  required?: boolean;
  value?: ReactNode;
  /** То же, что `value`, — для плашек без подписи. */
  children?: ReactNode;
  /** Пресет цвета antd; без него — серая плашка. */
  color?: TagProps['color'];
  /** Значок справа от значения: карандаш, стрелка. */
  suffix?: ReactNode;
  /** Действия справа (ссылки, иконки). Не сжимаются. */
  extra?: ReactNode;
  /** Плашка открывает окно: указатель, фокус с клавиатуры, Enter и пробел. */
  interactive?: boolean;
  disabled?: boolean;
  /** Значение жирным. По умолчанию — когда есть подпись. */
  strong?: boolean;
};

/**
 * Плашка шапки. forwardRef и проброс обработчиков обязательны: её оборачивают
 * Popover, Tooltip, Dropdown и Popconfirm, которые вешают на ребёнка ref,
 * onClick и onMouseEnter, — без них окна не откроются.
 */
export const HeaderChip = forwardRef<HTMLSpanElement, HeaderChipProps>(function HeaderChip(
  {
    label,
    required,
    value,
    children,
    color,
    suffix,
    extra,
    interactive,
    disabled,
    strong,
    className,
    style,
    onKeyDown,
    ...rest
  },
  ref,
) {
  const { token } = theme.useToken();
  const clickable = !!interactive && !disabled;
  const bold = strong ?? label !== undefined;

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    onKeyDown?.(event);
    if (!clickable || event.defaultPrevented) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.currentTarget.click();
    }
  };

  return (
    <Tag
      {...rest}
      ref={ref}
      color={color}
      className={className ? `mc-chip ${className}` : 'mc-chip'}
      role={clickable ? 'button' : rest.role}
      tabIndex={clickable ? 0 : rest.tabIndex}
      aria-disabled={interactive && disabled ? true : undefined}
      onKeyDown={handleKeyDown}
      style={{
        ...CHIP_STYLE,
        ...(interactive
          ? { cursor: disabled ? 'not-allowed' : 'pointer', userSelect: 'none' }
          : null),
        ...(disabled ? { opacity: 0.6 } : null),
        ...style,
      }}
    >
      {label !== undefined && (
        <span style={{ flex: 'none', fontSize: 11, color: token.colorTextSecondary }}>
          {label}
          {required && <span style={{ color: token.colorError }}>*</span>}:
        </span>
      )}
      {/* Пробел виден в textContent (поиск по тексту, копирование), а во
          flex-контейнере пробельный узел не рисуется — отступ даёт gap. */}
      {label !== undefined && ' '}
      <span
        style={{
          // Перенос только по словам: плашка не сжимается уже самого длинного
          // слова. С overflow-wrap: anywhere в узком заголовке блока документа
          // (телефон) значение ломалось по буквам в колонку.
          flex: '0 1 auto',
          maxWidth: VALUE_MAX_WIDTH,
          whiteSpace: 'normal',
          overflowWrap: 'break-word',
          ...(bold ? { fontWeight: 600, color: token.colorText } : null),
        }}
      >
        {value ?? children}
      </span>
      {suffix !== undefined && suffix !== null && suffix !== false && (
        <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center' }}>{suffix}</span>
      )}
      {extra !== undefined && extra !== null && extra !== false && (
        <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          {extra}
        </span>
      )}
    </Tag>
  );
});

/**
 * Кнопка-действие внутри плашки (ЭДО: «Файл», «К другим приёмкам», «Отвязать»):
 * без собственной высоты, чтобы не раздувать плашку, но с зоной касания
 * не меньше 24×24 px.
 */
export const HeaderChipAction = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(
  function HeaderChipAction({ style, ...props }, ref) {
    return (
      <Button
        ref={ref}
        type="link"
        size="small"
        {...props}
        style={{
          height: 'auto',
          minHeight: 16,
          minWidth: 16,
          padding: '0 2px',
          fontSize: 12,
          lineHeight: '16px',
          // Зона касания шире видимой кнопки: отрицательные поля (отступ 4px +
          // рамка 1px) не сдвигают соседей и не раздувают плашку, а палец
          // попадает и рядом с иконкой.
          marginBlock: -5,
          paddingBlock: 4,
          ...style,
        }}
      />
    );
  },
);

/**
 * «+ Документ», «+ УПД из ЭДО», «+ Договор», «+ Заказ», «+ ОС»… — одна кнопка
 * для всех приглашений что-то добавить. Текст передаётся строкой «+ …», без
 * иконки: так у кнопки прежнее доступное имя.
 */
export const HeaderAddButton = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(
  function HeaderAddButton({ className, style, ...props }, ref) {
    return (
      <Button
        ref={ref}
        size="small"
        type="dashed"
        {...props}
        className={className ? `mc-chip ${className}` : 'mc-chip'}
        style={{ ...HEADER_BUTTON_CHIP_STYLE, ...style }}
      />
    );
  },
);

/**
 * Раскладка шапки рядами. На узкой карточке (меньше 640px — телефон, узкое
 * окно) подпись ряда встаёт над плашками; считается ширина самой шапки, а не
 * окна браузера, поэтому так же работает и внутри модалки «Операций».
 *
 * Пустой ряд прячется сам: плашки вроде «Договора» или флага без права правки
 * возвращают null, и дублировать их условия в странице хрупко. Без поддержки
 * :has() (старый браузер) останется только подпись пустого ряда.
 */
const HEADER_CSS = `
.mc-op-header {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  margin-bottom: 8px;
}
.mc-op-header > .mc-op-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.mc-op-header > .mc-op-row > .mc-op-row-label {
  flex: none;
  width: 72px;
  font-size: 12px;
  line-height: ${HEADER_CHIP_HEIGHT}px;
}
.mc-op-header > .mc-op-row > .mc-op-row-values {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  flex: 1;
  min-width: 0;
}
.mc-op-header > .mc-op-row:has(> .mc-op-row-values:empty) {
  display: none;
}
/* Тумблер в плашке («Разные получатели»): по базовой линии он выше строки на 1px. */
.mc-op-header .mc-chip .ant-switch {
  vertical-align: top;
}
@container (max-width: 640px) {
  .mc-op-header > .mc-op-row {
    flex-direction: column;
    gap: 2px;
  }
  .mc-op-header > .mc-op-row > .mc-op-row-label {
    width: auto;
    line-height: 16px;
  }
  .mc-op-header > .mc-op-row > .mc-op-row-values {
    width: 100%;
  }
}
`;

export function OperationHeader({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}): JSX.Element {
  return (
    <div className="mc-op-header" style={style}>
      <style>{HEADER_CSS}</style>
      {children}
    </div>
  );
}

/** Ряд шапки: подпись слева (на узкой карточке — сверху) и плашки с переносом. */
export function HeaderRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mc-op-row">
      <Typography.Text type="secondary" className="mc-op-row-label">
        {label}
      </Typography.Text>
      <div className="mc-op-row-values">{children}</div>
    </div>
  );
}
