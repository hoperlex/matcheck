import { List, Space, Table, Tooltip, Typography, type TableProps } from 'antd';
import type { ReactNode } from 'react';
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

  const finalColumns: Column<T>[] = numbered
    ? [
        decorate({
          title: '№',
          key: '__num__',
          width: 56,
          render: (_: unknown, __: T, idx: number) => idx + 1,
        }),
        ...columns.map(decorate),
      ]
    : columns.map(decorate);

  if (bp === 'desktop') {
    return (
      <Table<T>
        dataSource={items}
        columns={finalColumns}
        rowKey={rowKey as TableProps<T>['rowKey']}
        loading={loading}
        size="middle"
        rowSelection={rowSelection}
        pagination={{ pageSize: 100, showSizeChanger: false }}
        locale={{ emptyText: emptyText ?? 'Нет данных' }}
        sticky={stickyOffset > 0 ? { offsetHeader: stickyOffset } : false}
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
