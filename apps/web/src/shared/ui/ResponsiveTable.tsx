import { List, Space, Table, Tooltip, Typography, type TableProps } from 'antd';
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
function wrapRender<T>(
  origRender: Column<T>['render'],
): Column<T>['render'] {
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
  rowSelection,
  expandable,
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
  // Необязательный antd rowSelection для массового выбора строк
  // (см. useBulkSelection). В карточном (mobile) режиме игнорируется.
  rowSelection?: TableProps<T>['rowSelection'];
  // Необязательный antd expandable для раскрывающихся строк (например
  // отображение позиций source_document под шапкой). Поддерживаем кастомный
  // toggle через колонку — для этого используется showExpandColumn:false
  // и контролируемый expandedRowKeys на стороне родителя.
  expandable?: TableProps<T>['expandable'];
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

  // Map ссылок строк на их исходную позицию — comparator колонки «№» лезет
  // сюда O(1), без него indexOf давал бы O(n²·log n) при сортировке.
  const originalIndex = useMemo(() => {
    const m = new Map<T, number>();
    items.forEach((it, i) => m.set(it, i));
    return m;
  }, [items]);

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
          sorter: (a: T, b: T) =>
            (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0),
          // Номер привязан к исходной позиции, а не к текущему индексу в
          // отсортированной таблице. Иначе после DESC-сортировки первая
          // строка получала бы «1» вместо ожидаемых «N, N-1, …» — теряется
          // визуальная подсказка «куда уехала именно эта запись».
          render: (_: unknown, record: T) => (originalIndex.get(record) ?? -1) + 1,
        }),
        ...columns.map(decorate),
      ]
    : columns.map(decorate);

  if (bp === 'desktop') {
    // Внутренний tbody-скролл: tbody вписывается в окно, пагинация всегда
    // видна внизу страницы (не уезжает за границу). Высота = vh минус
    // sticky-шапка страницы (фильтры) минус ~210px (шапка таблицы +
    // пагинация + paddings + буфер). Раньше был `sticky offsetHeader`,
    // но страница скроллилась целиком и пагинация уезжала за низ.
    const tableScrollY = `calc(100vh - ${stickyOffset + 210}px)`;
    return (
      <Table<T>
        dataSource={items}
        columns={finalColumns}
        rowKey={rowKey as TableProps<T>['rowKey']}
        loading={loading}
        size="middle"
        rowSelection={rowSelection}
        expandable={expandable}
        pagination={{ pageSize: 100, showSizeChanger: false }}
        locale={{ emptyText: emptyText ?? 'Нет данных' }}
        scroll={{ y: tableScrollY }}
        onRow={
          onRowClick
            ? (row) => ({
                onClick: () => onRowClick(row),
                style: { cursor: 'pointer' },
              })
            : undefined
        }
      />
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
          style={onRowClick ? { cursor: 'pointer' } : undefined}
        >
          {numbered ? (
            <Space align="start" style={{ width: '100%' }}>
              <Typography.Text type="secondary" style={{ minWidth: 24 }}>
                {idx + 1}.
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
