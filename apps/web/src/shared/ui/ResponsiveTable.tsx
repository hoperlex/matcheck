import { List, Table, type TableProps } from 'antd';
import type { ReactNode } from 'react';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useStickyHeaderHeight } from './StickyPageHeader';

type Column<T> = NonNullable<TableProps<T>['columns']>[number];

export function ResponsiveTable<T extends object>({
  items,
  columns,
  rowKey,
  cardRender,
  loading,
  emptyText,
  onRowClick,
}: {
  items: T[];
  columns: Column<T>[];
  rowKey: keyof T | ((row: T) => string);
  cardRender: (row: T) => ReactNode;
  loading?: boolean;
  emptyText?: string;
  onRowClick?: (row: T) => void;
}) {
  const bp = useBreakpoint();
  // Сумма высот всех родительских StickyPageHeader. 0 — sticky-обёртки нет,
  // прилипания заголовка таблицы не нужно. > 0 — заголовок таблицы прилипает
  // прямо под нижний край шапки, чтобы при скролле колонки оставались видны.
  const stickyOffset = useStickyHeaderHeight();
  if (bp === 'desktop') {
    return (
      <Table<T>
        dataSource={items}
        columns={columns}
        rowKey={rowKey as TableProps<T>['rowKey']}
        loading={loading}
        size="middle"
        pagination={{ pageSize: 50, showSizeChanger: true }}
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
      renderItem={(item) => (
        <List.Item
          key={typeof rowKey === 'function' ? rowKey(item) : String(item[rowKey])}
          onClick={onRowClick ? () => onRowClick(item) : undefined}
          style={onRowClick ? { cursor: 'pointer' } : undefined}
        >
          {cardRender(item)}
        </List.Item>
      )}
    />
  );
}
