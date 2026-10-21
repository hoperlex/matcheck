/**
 * Иконки заголовка таблицы — те же, что у таблиц FOT («Управление кадрами»):
 * стрелки сортировки и воронка фильтра из набора lucide.
 *
 * Пути скопированы из lucide 0.508 (лицензия ISC, © Lucide Contributors) —
 * ради четырёх иконок тянуть пакет целиком незачем.
 */
import type { ReactElement } from 'react';

const ARROW_UP_DOWN = ['m21 16-4 4-4-4', 'M17 20V4', 'm3 8 4-4 4 4', 'M7 4v16'] as const;
const ARROW_UP = ['m5 12 7-7 7 7', 'M12 19V5'] as const;
const ARROW_DOWN = ['M12 5v14', 'm19 12-7 7-7-7'] as const;
const FUNNEL = [
  'M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z',
] as const;

/**
 * SVG для CSS-маски: `mask-image: url("data:…")`. Цвет у маски не важен —
 * видимую иконку красит `background-color: currentColor` элемента.
 */
export function lucideMaskUri(paths: readonly string[]): string {
  const body = paths.map((d) => `<path d='${d}'/>`).join('');
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' ` +
    `stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * Иконки сортировки рисуются CSS-маской по `th[aria-sort]` (см. TableLookStyle):
 * так стрелку получает любая antd-таблица портала, без правки её колонок.
 */
export const SORT_ICON_MASKS = {
  none: lucideMaskUri(ARROW_UP_DOWN),
  asc: lucideMaskUri(ARROW_UP),
  desc: lucideMaskUri(ARROW_DOWN),
} as const;

/** Воронка фильтра колонки: antd `filterIcon`, цвет и прозрачность задаёт CSS. */
export function FunnelIcon(): ReactElement {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {FUNNEL.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
