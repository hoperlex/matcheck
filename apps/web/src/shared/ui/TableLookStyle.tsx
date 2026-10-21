import { SORT_ICON_MASKS } from './tableIcons';

/**
 * Внешний вид таблиц портала — как у таблиц FOT («Управление кадрами»): серая
 * шапка с заглавными подписями, стрелка сортировки и воронка вплотную к
 * подписи, рамка со скруглением, зебра, компактные бейджи и кнопки действий.
 *
 * Одно правило на все antd-таблицы — и в ResponsiveTable, и в модалках, и на
 * публичной странице: страницы ничего не подключают. Инлайн-стиль, а не
 * CSS-файл — тот же приём, что MismatchRowStyle (CSS-файлов в проекте нет).
 *
 * Специфичность: antd кладёт свои стили в <head> с нулевым весом хэша
 * (`:where(.css-…)`), этот <style> стоит в <body> — при равном весе
 * побеждает он. Префикс `.ant-table-wrapper .ant-table` держит вес не ниже,
 * чем у правил размера antd (`.ant-table.ant-table-small …`).
 *
 * Цвета подсветки строк (MismatchRowStyle, «Сегодня в процессе» / «Просрочено»
 * в OperationsPage) здесь не трогаются: зебра — это полупрозрачная картинка
 * поверх фона, и строки с подсветкой она обходит.
 */

const T = '.ant-table-wrapper .ant-table';

const BORDER = '#dadce0';
const TEXT = '#09090b';
const TEXT_SECONDARY = '#52525b';
const TEXT_MUTED = '#71717a';
const ACCENT = '#1677ff';
const DANGER = '#ff4d4f';
const ZEBRA = 'rgba(9, 9, 11, 0.025)';

const CSS = `
/* ── рамка ───────────────────────────────────────────────────────────── */
.ant-table-wrapper .ant-table-container {
  border: 1px solid ${BORDER};
  border-radius: 8px;
  overflow: hidden;
}
${T} .ant-table-tbody > tr:last-child > td { border-bottom: 0; }

/* ── шапка ───────────────────────────────────────────────────────────── */
${T} .ant-table-thead > tr > th.ant-table-cell {
  padding-top: 6px;
  padding-bottom: 6px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.25;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: ${TEXT_SECONDARY};
  vertical-align: middle;
  /* переносы только между словами; слово длиннее колонки — последний случай */
  white-space: normal;
  word-break: normal;
  overflow-wrap: break-word;
  hyphens: none;
}
${T} .ant-table-thead > tr > th[aria-sort] { color: ${TEXT}; }

/* Подпись, стрелка и воронка — одной строкой текста, вплотную, как в FOT.
   У antd это flex-ряд «подпись ←→ иконки»: в узкой колонке он сжимал
   подпись и рвал слово («ПОСТАВК / И»). В потоке текста подпись переносится
   по словам, а иконки идут за последним словом или целиком на новую строку. */
${T} .ant-table-filter-column { display: block; }
${T} .ant-table-column-sorters,
${T} .ant-table-column-sorters > .ant-table-column-title,
${T} .ant-table-filter-column > .ant-table-column-title { display: inline; }

/* стрелка: вместо двух кареток antd — иконка lucide по состоянию th[aria-sort] */
${T} .ant-table-column-sorter {
  display: inline-flex;
  vertical-align: -1px;
  margin: 0 0 0 4px;
  color: inherit;
  opacity: 0.35;
  transition: opacity 0.15s ease-out;
}
${T} .ant-table-column-sorters:hover .ant-table-column-sorter { color: inherit; }
${T} .ant-table-column-sorter-inner { display: none; }
${T} .ant-table-column-sorter::before {
  content: '';
  width: 12px;
  height: 12px;
  background-color: currentColor;
  -webkit-mask: ${SORT_ICON_MASKS.none} center / 12px 12px no-repeat;
  mask: ${SORT_ICON_MASKS.none} center / 12px 12px no-repeat;
}
${T} th[aria-sort='ascending'] .ant-table-column-sorter::before {
  -webkit-mask-image: ${SORT_ICON_MASKS.asc};
  mask-image: ${SORT_ICON_MASKS.asc};
}
${T} th[aria-sort='descending'] .ant-table-column-sorter::before {
  -webkit-mask-image: ${SORT_ICON_MASKS.desc};
  mask-image: ${SORT_ICON_MASKS.desc};
}
${T} th.ant-table-column-has-sorters:hover .ant-table-column-sorter,
${T} th.ant-table-column-has-sorters:focus-visible .ant-table-column-sorter,
${T} th[aria-sort] .ant-table-column-sorter { opacity: 1; }

/* воронка */
${T} .ant-table-thead .ant-table-filter-trigger {
  display: inline-flex;
  vertical-align: middle;
  width: 16px;
  height: 20px;
  margin: 0 0 0 2px;
  padding: 0;
  justify-content: center;
  border-radius: 3px;
  color: inherit;
  opacity: 0.35;
  transition: opacity 0.15s ease-out, color 0.15s ease-out;
}
${T} .ant-table-thead .ant-table-filter-trigger:hover {
  color: inherit;
  background: transparent;
}
${T} .ant-table-thead > tr > th:hover .ant-table-filter-trigger,
${T} .ant-table-thead .ant-table-filter-trigger:focus-visible,
${T} .ant-table-thead .ant-table-filter-trigger.active { opacity: 1; }
${T} .ant-table-thead .ant-table-filter-trigger.active { color: ${ACCENT}; }

/* ── тело: только строки данных (measure-row и раскрытые строки не трогаем) ─ */
${T} .ant-table-tbody > tr.ant-table-row > td { height: 40px; }

/* Зебра — отдельным правилом: браузер без «nth-child(… of …)» отбросит только его.
   Подсвеченные, выбранные и строка под курсором — без зебры, со своим цветом. */
${T} .ant-table-tbody > tr.ant-table-row:nth-child(even of .ant-table-row):not(:hover):not(.ant-table-row-selected):not(.matcheck-row-mismatch):not(.matcheck-row-progress-today):not(.matcheck-row-overdue) > td:not(.ant-table-cell-row-hover) {
  background-image: linear-gradient(${ZEBRA}, ${ZEBRA});
}

/* перенос до двух строк (ResponsiveTable → ClampText) */
.mc-clamp2 {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
  white-space: normal;
  line-height: 1.3;
}

/* ResponsiveTable: JSX-ячейки — одна строка с «…», как было с ellipsis.
   Колонки чекбоксов и раскрытия antd рисует сам — их не трогаем. Исключение
   в :where(), чтобы не поднимать вес: .mc-wrap и .mc-col-actions ниже
   должны перебивать это правило. */
.ant-table-wrapper.mc-rt .ant-table-tbody > tr.ant-table-row > td:where(:not(.ant-table-selection-column, .ant-table-row-expand-icon-cell)) {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ant-table-wrapper.mc-rt .ant-table-tbody > tr.ant-table-row > td.mc-wrap { white-space: normal; }
/* кнопки не режем многоточием — оно читается как ещё одна кнопка */
.ant-table-wrapper.mc-rt .ant-table-tbody > tr.ant-table-row > td.mc-col-actions { text-overflow: clip; }

/* колонка «№» */
${T} .ant-table-tbody > tr > td.mc-col-num {
  color: ${TEXT_MUTED};
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-overflow: clip;
}

/* теги в ячейках — бейджи FOT */
${T} .ant-table-tbody .ant-tag {
  padding: 0 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
}

/* кнопки-иконки в колонке действий */
${T} td.mc-col-actions .ant-btn.ant-btn-icon-only {
  width: 28px;
  min-width: 28px;
  height: 28px;
  border: 1px solid ${BORDER};
  border-radius: 6px;
  background: transparent;
  color: ${TEXT_SECONDARY};
}
${T} td.mc-col-actions .ant-btn.ant-btn-icon-only:not(:disabled):hover {
  background: ${ACCENT};
  border-color: ${ACCENT};
  color: #fff;
}
${T} td.mc-col-actions .ant-btn.ant-btn-icon-only.ant-btn-dangerous { color: ${DANGER}; }
${T} td.mc-col-actions .ant-btn.ant-btn-icon-only.ant-btn-dangerous:not(:disabled):hover {
  background: ${DANGER};
  border-color: ${DANGER};
  color: #fff;
}

/* ── строка под таблицей: «Всего: N» / легенда и номера страниц ───────── */
.ant-table-wrapper .ant-table-pagination .ant-pagination-total-text {
  font-size: 13px;
  color: ${TEXT_SECONDARY};
  font-variant-numeric: tabular-nums;
}
.ant-table-wrapper .ant-table-pagination.ant-pagination .ant-pagination-item,
.ant-table-wrapper .ant-table-pagination.ant-pagination .ant-pagination-prev .ant-pagination-item-link,
.ant-table-wrapper .ant-table-pagination.ant-pagination .ant-pagination-next .ant-pagination-item-link {
  border: 1px solid ${BORDER};
  border-radius: 6px;
}
.ant-table-wrapper .ant-table-pagination.ant-pagination .ant-pagination-item-active {
  border-color: ${ACCENT};
}
.ant-table-wrapper .ant-table-pagination.ant-pagination .ant-pagination-item-active a { color: ${ACCENT}; }

/* ── окно фильтра колонки (ColumnFilterWindow) ───────────────────────── */
.mc-colfilter-root .ant-table-filter-dropdown {
  border: 1px solid ${BORDER};
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}
.mc-colfilter {
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-sizing: border-box;
  width: 320px;
  max-width: calc(100vw - 16px);
  max-height: min(480px, calc(100dvh - 24px));
  padding: 12px;
  color: ${TEXT};
  font-size: 13px;
  text-transform: none;
  letter-spacing: normal;
}
.mc-colfilter-title { font-weight: 600; }
.mc-colfilter-hint { padding: 0 2px; color: ${TEXT_MUTED}; font-size: 12px; }
.mc-colfilter-error { color: ${DANGER}; font-size: 12px; }
.mc-colfilter-bulk { display: flex; justify-content: space-between; gap: 8px; }
.mc-colfilter-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: ${ACCENT};
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.mc-colfilter-link:disabled { color: ${TEXT_MUTED}; cursor: default; }
.mc-colfilter-list {
  flex: 1 1 auto;
  min-height: 60px;
  max-height: 260px;
  margin: 0 -4px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.mc-colfilter-option {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  padding: 2px 4px;
  border-radius: 6px;
  cursor: pointer;
}
.mc-colfilter-option:hover { background: #f1f3f4; }
.mc-colfilter-option input {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: ${ACCENT};
}
.mc-colfilter-label { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.mc-colfilter-count {
  flex: 0 0 auto;
  color: ${TEXT_MUTED};
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.mc-colfilter-dates { display: flex; flex-direction: column; gap: 8px; }
.mc-colfilter-field { display: grid; grid-template-columns: 28px 1fr; align-items: center; gap: 8px; }
.mc-colfilter-field > span { color: ${TEXT_SECONDARY}; }
.mc-colfilter-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid ${BORDER};
}

@media (prefers-reduced-motion: reduce) {
  ${T} .ant-table-column-sorter,
  ${T} .ant-table-thead .ant-table-filter-trigger { transition: none; }
}
`;

export function TableLookStyle() {
  return <style>{CSS}</style>;
}
