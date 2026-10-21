import { ConfigProvider, List, Space, Table, Tooltip, Typography, type TableProps } from 'antd';
import type { TableRef } from 'antd/es/table';
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useStickyHeaderHeight } from './StickyPageHeader';

type Column<T> = NonNullable<TableProps<T>['columns']>[number];

/** Ключи колонок с кнопками действий — им достаются кнопки-иконки в стиле FOT. */
const ACTION_COLUMN_KEYS = new Set(['actions', 'a']);

/** Высота шапки таблицы, пока её не измерили (одна строка подписей). */
const DEFAULT_HEADER_HEIGHT = 34;

function isClipped(el: HTMLElement): boolean {
  return el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
}

/**
 * Текст ячейки в две строки, дальше «…» — как ФИО и отделы у таблиц FOT.
 * Подсказка с полным текстом появляется только у реально обрезанного: на
 * коротком значении она лишь мешала бы.
 */
export function ClampText({ text }: { text: string }): ReactElement {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      title={text}
      placement="topLeft"
      mouseEnterDelay={0.4}
      open={open}
      onOpenChange={(next) => setOpen(next && !!ref.current && isClipped(ref.current))}
    >
      <span ref={ref} className="mc-clamp2">
        {text}
      </span>
    </Tooltip>
  );
}

/**
 * «Числовое» значение: суммы, даты, время, количества, номера из цифр и
 * разделителей. Его не переносим: разряды суммы разделены неразрывным
 * пробелом (formatMoneyRu), и для браузера «1 564 512,34» — одно слово —
 * перенос до двух строк резал его прямо по цифрам («1 564 5» / «₽»).
 * `\s` в JS покрывает и U+00A0, и узкий U+202F.
 */
const NUMERIC_LIKE = /^[\d\s.,:;+−–—/\\₽%$€()№#-]+$/;

/** Одна строка с «…» (её даёт CSS ячейки) и подсказкой с полным значением. */
function OneLineText({ text }: { text: string }): ReactElement {
  return (
    <Tooltip title={text} placement="topLeft" mouseEnterDelay={0.4}>
      <span>{text}</span>
    </Tooltip>
  );
}

/**
 * Текст ячейки — в ClampText (до двух строк), числовое значение — в одну
 * строку; JSX (теги, кнопки, контролы) — как есть.
 */
function clampRender<T>(origRender: Column<T>['render']): Column<T>['render'] {
  return (value: unknown, record: T, idx: number): ReactNode => {
    const out: ReactNode = origRender
      ? (origRender(value, record, idx) as ReactNode)
      : (value as ReactNode);
    if (typeof out === 'string' || typeof out === 'number') {
      const s = String(out);
      if (s.length === 0 || s === '—' || s === '-') return out;
      return NUMERIC_LIKE.test(s) ? <OneLineText text={s} /> : <ClampText text={s} />;
    }
    return out;
  };
}

/**
 * Прежний путь для колонок с явным `ellipsis`: одна строка, Tooltip на
 * строковых значениях. Такие колонки сами выбрали однострочный вид.
 */
function wrapRender<T>(origRender: Column<T>['render']): Column<T>['render'] {
  return (value: unknown, record: T, idx: number): ReactNode => {
    const out: ReactNode = origRender
      ? (origRender(value, record, idx) as ReactNode)
      : (value as ReactNode);
    if (typeof out === 'string' || typeof out === 'number') {
      const s = String(out);
      if (s.length === 0 || s === '—' || s === '-') return out;
      return <OneLineText text={s} />;
    }
    return out;
  };
}

export function ResponsiveTable<T extends object>({
  items,
  columns,
  rowKey,
  cardRender,
  loading,
  emptyText,
  onRowClick,
  numbered,
  numberedOffset,
  numberedSortable = true,
  rowSelection,
  expandable,
  rowClassName,
  pagination,
  onChange,
  scrollY,
  scrollX,
}: {
  items: T[];
  columns: Column<T>[];
  rowKey: keyof T | ((row: T) => string);
  cardRender: (row: T) => ReactNode;
  loading?: boolean;
  emptyText?: string;
  onRowClick?: (row: T) => void;
  // Если true — слева добавляется автоинкрементная колонка «№»
  // (в пределах текущей страницы пагинации), а в карточном режиме
  // перед содержимым карточки выводится «N.».
  numbered?: boolean;
  // Базовый offset для нумерации при server-side pagination. На
  // странице 2 (offset=50) нумерация должна начинаться с 51, а не с 1.
  // Если не задан — нумерация в рамках принятого items (старое поведение).
  numberedOffset?: number;
  // Можно ли сортировать по «№». По умолчанию да — прежнее поведение.
  //
  // Таблицам с СЕРВЕРНОЙ сортировкой нужно false: компаратор ниже переставляет
  // только загруженную страницу, а сам клик приходит в onChange с ключом
  // `__num__`, которого нет среди серверных полей, — и обработчик снимает
  // текущую сортировку. То есть колонка «№» не столько сортирует, сколько
  // ломает сортировку по соседним колонкам.
  numberedSortable?: boolean;
  // Необязательный antd rowSelection для массового выбора строк
  // (см. useBulkSelection). В карточном (mobile) режиме игнорируется.
  rowSelection?: TableProps<T>['rowSelection'];
  // Необязательный antd expandable для раскрывающихся строк (например
  // отображение позиций source_document под шапкой). Поддерживаем кастомный
  // toggle через колонку — для этого используется showExpandColumn:false
  // и контролируемый expandedRowKeys на стороне родителя.
  expandable?: TableProps<T>['expandable'];
  // Кастомный CSS-класс per-row — для подсветки «в процессе» (жёлтый)
  // или «незавершено» (красный) в Операциях.
  rowClassName?: (row: T) => string;
  // Override antd pagination. Используется в DeliveriesHistory /
  // ShipmentsHistory, чтобы добавить showTotal с легендой цветов
  // подсветки строк (Сегодня в процессе / Просрочено) — она рендерится
  // слева от номеров страниц на той же линии. Если undefined — default
  // `{ pageSize: 100, showSizeChanger: false }`.
  pagination?: TableProps<T>['pagination'];
  // Смена страницы/сортировки/колоночного фильтра. Нужен там, где всё это
  // считает сервер: страница сама решает, что положить в адрес и в запрос.
  onChange?: TableProps<T>['onChange'];
  /**
   * Высота внутреннего скролла tbody. По умолчанию — «во весь экран под
   * шапкой»: компонент рассчитан на ОДНУ таблицу на странице. `false` убирает
   * скролл вовсе — для страниц, где таблиц несколько подряд и каждая рисовала
   * бы свой трек прокрутки (вкладка «Роли»).
   */
  scrollY?: string | false;
  /**
   * Минимальная ширина таблицы. Табличный режим начинается уже с 1024px (см.
   * useBreakpoint), а при развёрнутом Sider (240) и padding Content (48) под
   * таблицу остаётся 736px — десяток колонок сжимается в нечитаемую кашу.
   * Заданный scrollX включает внутренний горизонтальный скролл вместо сжатия.
   */
  scrollX?: number | string;
}) {
  const bp = useBreakpoint();
  // Сумма высот всех родительских StickyPageHeader. 0 — sticky-обёртки нет,
  // прилипания заголовка таблицы не нужно. > 0 — заголовок таблицы прилипает
  // прямо под нижний край шапки, чтобы при скролле колонки оставались видны.
  const stickyOffset = useStickyHeaderHeight();

  // Текст ячеек — до двух строк, как в FOT (ClampText). JSX-ячейки остаются
  // в одну строку с «…»: это задаёт CSS таблицы `.mc-rt` (TableLookStyle).
  // Колонка с явным ellipsis идёт прежним однострочным путём, а с
  // ellipsis:false (стороны документа — название и ИНН) переносится целиком.
  const decorate = (col: Column<T>): Column<T> => {
    const extraClass = [
      col.ellipsis === false ? 'mc-wrap' : null,
      col.key != null && ACTION_COLUMN_KEYS.has(String(col.key)) ? 'mc-col-actions' : null,
    ]
      .filter(Boolean)
      .join(' ');
    return {
      ...col,
      className: [col.className, extraClass].filter(Boolean).join(' ') || undefined,
      render: col.ellipsis ? wrapRender<T>(col.render) : clampRender<T>(col.render),
    };
  };

  // Map ключей строк на их исходную позицию — comparator колонки «№» лезет
  // сюда O(1), без него indexOf давал бы O(n²·log n) при сортировке.
  // Ключи строковые (через rowKey), а не сами объекты: на страницах, где
  // items пересоздаются на каждом ререндере (map/sort/filter), ссылки
  // меняются и Map<T,number> не находила бы их — получался «0» в столбце.
  const getRowKey = (it: T): string =>
    typeof rowKey === 'function' ? String(rowKey(it)) : String(it[rowKey] as unknown);
  const originalIndex = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((it, i) => m.set(getRowKey(it), i));
    return m;
    // getRowKey зависит от rowKey-пропа, items — стабильный массив здесь.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, rowKey]);

  const finalColumns: Column<T>[] = numbered
    ? [
        {
          title: '№',
          key: '__num__',
          width: 56,
          align: 'center',
          className: 'mc-col-num',
          // Сортировка по «№» = по исходной позиции в items. Первый клик —
          // ASC (как пришли с бэка), второй — DESC (инверсия), третий —
          // снимает сортировку. Нужен, чтобы юзер мог одним кликом
          // развернуть список «снизу вверх», не меняя других сортировок.
          // При серверной выборке отключается (numberedSortable=false): там
          // переставлять загруженную страницу нечестно, см. проп выше.
          ...(numberedSortable
            ? {
                sorter: (a: T, b: T) =>
                  (originalIndex.get(getRowKey(a)) ?? 0) - (originalIndex.get(getRowKey(b)) ?? 0),
              }
            : {}),
          // Номер привязан к исходной позиции, а не к текущему индексу в
          // отсортированной таблице. Иначе после DESC-сортировки первая
          // строка получала бы «1» вместо ожидаемых «N, N-1, …» — теряется
          // визуальная подсказка «куда уехала именно эта запись».
          // При server-side pagination передаётся numberedOffset = (page-1)*pageSize
          // — тогда на странице 2 первая строка получит номер 51, не 1.
          render: (_: unknown, record: T) =>
            (numberedOffset ?? 0) + (originalIndex.get(getRowKey(record)) ?? -1) + 1,
        },
        ...columns.map(decorate),
      ]
    : columns.map(decorate);

  // Высота шапки таблицы. Подписи заглавные и переносятся по словам, так что
  // шапка бывает в одну строку (~34px) и в две (~47px), и зависит от ширины
  // окна. Её меряем, а не закладываем числом: иначе на двухстрочной шапке
  // таблица переполняла бы Content и появлялся второй, внешний скролл.
  const tableRef = useRef<TableRef>(null);
  const [headerHeight, setHeaderHeight] = useState(DEFAULT_HEADER_HEIGHT);
  const measureHeader = bp === 'desktop' && scrollY === undefined;
  useEffect(() => {
    if (!measureHeader || typeof ResizeObserver === 'undefined') return;
    const header = tableRef.current?.nativeElement?.querySelector<HTMLElement>('.ant-table-header');
    if (!header) return;
    const observer = new ResizeObserver(() => {
      const h = header.offsetHeight;
      if (h > 0) setHeaderHeight(h);
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, [measureHeader]);

  if (bp === 'desktop') {
    // Внутренний tbody-скролл: tbody вписывается в окно, пагинация всегда
    // видна внизу страницы. Высота = vh минус sticky-шапка страницы минус
    // шапка таблицы (измеренная, см. выше) минус ~80px: пагинация ~48 +
    // Content top+bottom paddings 20 + buffer 12. Так таблица помещается в
    // Content (который сам скролл-контейнер, см. DesktopLayout) и НЕ
    // переполняет его — внешнего скролла не остаётся.
    const tableScrollY =
      scrollY === undefined ? `calc(100vh - ${stickyOffset + 80 + headerHeight}px)` : scrollY;
    // Собираем scroll явно: при scrollY === false в объект нельзя класть
    // y: false — таблицы «Ролей» (шесть подряд на одной странице) получили бы
    // некорректную высоту вместо скролла страницей.
    const tableScroll: TableProps<T>['scroll'] =
      tableScrollY === false
        ? scrollX === undefined
          ? undefined
          : { x: scrollX }
        : { x: scrollX, y: tableScrollY };
    return (
      // componentSize="small" — контролы в ячейках (Select, Input, InputNumber,
      // Button, Pagination) становятся 24px вместо 32, Switch — 16px. Иначе
      // строка упирается в высоту контрола и отступы ячеек её не сжимают.
      // Обёртка живёт только в desktop-ветке: в карточном режиме ниже нужны
      // крупные тапабельные зоны. Явный size в конкретной ячейке побеждает.
      <ConfigProvider componentSize="small">
        <Table<T>
          ref={tableRef}
          className="mc-rt"
          // Ширины колонок держит fixed-раскладка. Раньше её включал общий
          // ellipsis колонок; без него таблицы без scroll.y (Роли, позиции
          // приёмки) перешли бы на auto, и колонки растянулись бы по тексту.
          tableLayout="fixed"
          dataSource={items}
          columns={finalColumns}
          rowKey={rowKey as TableProps<T>['rowKey']}
          loading={loading}
          size="small"
          rowSelection={rowSelection}
          expandable={expandable}
          showSorterTooltip={false}
          pagination={
            pagination === false
              ? false
              : { pageSize: 100, showSizeChanger: false, ...(pagination ?? {}) }
          }
          onChange={onChange}
          locale={{ emptyText: emptyText ?? 'Нет данных' }}
          scroll={tableScroll}
          rowClassName={rowClassName}
          onRow={
            onRowClick
              ? (row) => ({
                  onClick: () => onRowClick(row),
                  style: { cursor: 'pointer' },
                })
              : undefined
          }
        />
      </ConfigProvider>
    );
  }
  return (
    <List
      dataSource={items}
      loading={loading}
      locale={{ emptyText: emptyText ?? 'Нет данных' }}
      renderItem={(item, idx) => (
        <List.Item
          key={typeof rowKey === 'function' ? rowKey(item) : String(item[rowKey])}
          onClick={onRowClick ? () => onRowClick(item) : undefined}
          // rowClassName раньше уходил только в десктопную таблицу, и подсветка
          // проблемной строки на планшете/узком экране просто пропадала — как
          // раз там, где карточку чаще всего и открывают.
          className={rowClassName?.(item) || undefined}
          style={onRowClick ? { cursor: 'pointer' } : undefined}
        >
          {numbered ? (
            <Space align="start" style={{ width: '100%' }}>
              <Typography.Text type="secondary" style={{ minWidth: 24 }}>
                {(numberedOffset ?? 0) + idx + 1}.
              </Typography.Text>
              <div style={{ flex: 1, minWidth: 0 }}>{cardRender(item)}</div>
            </Space>
          ) : (
            cardRender(item)
          )}
        </List.Item>
      )}
    />
  );
}
