import type { MouseEvent } from 'react';
import type { GroupGutter } from './deliveryGroupRows';

/**
 * Скобка группы слева от таблицы — как группировка строк в Excel: у строки
 * группы квадратная кнопка «−/+», вниз от неё линия вдоль приёмок группы, у
 * последней — уголок. Линии рисует CSS ячеек (псевдоэлементы), кнопка — здесь.
 */
export function DeliveryGroupToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="mc-group-toggle"
      aria-label={collapsed ? 'Развернуть группу' : 'Свернуть группу'}
      aria-expanded={!collapsed}
      onClick={(event: MouseEvent) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {collapsed ? '+' : '−'}
    </button>
  );
}

/** Класс ячейки скобки по её куску. */
export function gutterCellClass(kind: GroupGutter, collapsed = false): string {
  if (!kind) return 'mc-group-gutter';
  return `mc-group-gutter mc-gutter-${kind}${collapsed ? ' mc-gutter-collapsed' : ''}`;
}

const LINE = '#8c8c8c';

/**
 * Стили скобки и строки группы. Линия идёт по центру колонки (13px) и
 * перекрывает границу строки (bottom: -1px), иначе между приёмками были бы
 * разрывы. Строка группы — светлый фон, её не красит зебра (TableLookStyle).
 */
export function DeliveryGroupStyle() {
  return (
    <style>{`
.mc-rt td.mc-group-gutter { position: relative; padding: 0 !important; }
.mc-rt td.mc-gutter-mid::before,
.mc-rt td.mc-gutter-end::before,
.mc-rt td.mc-gutter-head:not(.mc-gutter-collapsed)::before {
  content: ''; position: absolute; left: 13px; width: 0; border-left: 1px solid ${LINE};
}
.mc-rt td.mc-gutter-mid::before { top: 0; bottom: -1px; }
.mc-rt td.mc-gutter-head:not(.mc-gutter-collapsed)::before { top: 50%; bottom: -1px; }
.mc-rt td.mc-gutter-end::before { top: 0; height: 50%; }
.mc-rt td.mc-gutter-end::after {
  content: ''; position: absolute; left: 13px; top: 50%; width: 9px; border-top: 1px solid ${LINE};
}
.mc-group-toggle {
  position: relative; z-index: 1; display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; margin-left: 5px; padding: 0;
  border: 1px solid ${LINE}; border-radius: 2px; background: #fff; color: #262626;
  font-size: 12px; line-height: 1; cursor: pointer;
}
.mc-group-toggle:hover { border-color: #1677ff; color: #1677ff; }
.mc-rt tr.mc-group-head > td { background: #f5f7fa; }
.mc-rt tr.mc-group-head:hover > td { background: #eef2f7 !important; }
`}</style>
  );
}
