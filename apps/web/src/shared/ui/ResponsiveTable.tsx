import { List, Table, type TableProps } from 'antd';
import type { ReactNode } from 'react';
import { useBreakpoint } from '../hooks/useBreakpoint';

type Column<T> = NonNullable<TableProps<T>['columns']>[number];

export function ResponsiveTable<T extends object>({
  items,
  columns,
  rowKey,
  cardRender,
  loading,
  emptyText,
}: {
  items: T[];
  columns: Column<T>[];
  rowKey: keyof T | ((row: T) => string);
  cardRender: (row: T) => ReactNode;
  loading?: boolean;
  emptyText?: string;
}) {
  const bp = useBreakpoint();
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
      />
    );
  }
  return (
    <List
      dataSource={items}
      loading={loading}
      locale={{ emptyText: emptyText ?? 'Нет данных' }}
      renderItem={(item) => (
        <List.Item key={typeof rowKey === 'function' ? rowKey(item) : String(item[rowKey])}>
          {cardRender(item)}
        </List.Item>
      )}
    />
  );
}
