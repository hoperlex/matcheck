import { List, Space, Table, Typography, type TableProps } from 'antd';
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
  numbered,
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
}) {
  const bp = useBreakpoint();
  // Сумма высот всех родительских StickyPageHeader. 0 — sticky-обёртки нет,
  // прилипания заголовка таблицы не нужно. > 0 — заголовок таблицы прилипает
  // прямо под нижний край шапки, чтобы при скролле колонки оставались видны.
  const stickyOffset = useStickyHeaderHeight();

  const finalColumns: Column<T>[] = numbered
    ? [
        {
          title: '№',
          key: '__num__',
          width: 56,
          render: (_: unknown, __: T, idx: number) => idx + 1,
        },
        ...columns,
      ]
    : columns;

  if (bp === 'desktop') {
    return (
      <Table<T>
        dataSource={items}
        columns={finalColumns}
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
