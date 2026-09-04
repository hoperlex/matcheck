import { ConfigProvider, List, Space, Table, Tooltip, Typography, type TableProps } from 'antd';
import { useMemo, type ReactNode } from 'react';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useStickyHeaderHeight } from './StickyPageHeader';

type Column<T> = NonNullable<TableProps<T>['columns']>[number];

/**
 * Оборачиваем оригинальный column.render так, чтобы строковые/числовые
 * значения автоматически получали antd Tooltip с полным содержимым.
 * JSX-результаты (Tag, Space, Button) пропускаем как есть — для них tooltip
 * либо не нужен, либо уже навешан внутри ячейки. В паре с column.ellipsis
 * это даёт «обрезанный текст с подсказкой на hover», все строки одной
 * высоты, без 2-3-строчных «пляшущих» ячеек.
 */
function wrapRender<T>(origRender: Column<T>['render']): Column<T>['render'] {
  return (value: unknown, record: T, idx: number): ReactNode => {
    const out: ReactNode = origRender
      ? (origRender(value, record, idx) as ReactNode)
      : (value as ReactNode);
    if (typeof out === 'string' || typeof out === 'number') {
      const s = String(out);
      if (s.length === 0 || s === '—' || s === '-') return out;
      return (
        <Tooltip title={s} placement="topLeft" mouseEnterDelay={0.4}>
          <span>{s}</span>
        </Tooltip>
      );
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

  // Все колонки получают ellipsis (одна строка + обрезка с «…»), значит все
  // строки таблицы одной высоты. Native title отключаем (showTitle: false),
  // подсказку даёт antd Tooltip из wrapRender — он же дублирует подсказку
  // для render-функций, которые возвращают string/number.
  const decorate = (col: Column<T>): Column<T> => ({
    ellipsis: { showTitle: false },
    ...col,
    render: wrapRender<T>(col.render),
  });

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
        decorate({
          title: '№',
          key: '__num__',
          width: 56,
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
        }),
        ...columns.map(decorate),
      ]
    : columns.map(decorate);

  if (bp === 'desktop') {
    // Внутренний tbody-скролл: tbody вписывается в окно, пагинация всегда
    // видна внизу страницы. Высота = vh минус sticky-шапка страницы минус
    // ~114px (шапка таблицы ~34 + пагинация ~48 + Content top+bottom
    // paddings 20 + buffer 12). Было 134 при size="middle" — с компактной
    // плотностью (отступы ячеек 6px) шапка таблицы стала ниже на ~13px, а
    // пагинация внутри componentSize="small" — на ~8px, место отдаём строкам.
    // Так таблица помещается в Content (который сам скролл-контейнер, см.
    // DesktopLayout) и НЕ переполняет его — внешнего скролла не остаётся.
    const tableScrollY = scrollY === undefined ? `calc(100vh - ${stickyOffset + 114}px)` : scrollY;
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
