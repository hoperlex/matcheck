import { Spin, Table, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { SourceDocumentDetail } from '@matcheck/contracts';
import { api } from '../../services/api';
import { formatDecimal } from '../utils/formatDecimal';
import { formatMoneyRu } from '../utils/formatRu';

/**
 * Раскрывающаяся панель с позициями source_document. Lazy fetch:
 * запрос /source-documents/{id} выполняется только при первом раскрытии,
 * результат кешируется react-query — повторное раскрытие/сворачивание не
 * дёргает сеть.
 *
 * Для kind='os2_transfer' добавляется колонка «Инв.№» (инвентарный номер
 * основного средства). Для ТН и УПД её нет.
 */
export function ExpandedSourceDocumentItems({
  id,
  kind,
}: {
  id: string;
  kind: SourceDocumentDetail['kind'];
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['source-document-detail', id],
    queryFn: () => api.get<SourceDocumentDetail>(`/source-documents/${id}`),
  });

  if (isLoading) {
    return (
      <div style={{ padding: 12, textAlign: 'center' }}>
        <Spin size="small" />
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: 12 }}>
        <Typography.Text type="danger">
          Не удалось загрузить позиции: {(error as Error).message}
        </Typography.Text>
      </div>
    );
  }
  const items = data?.items ?? [];
  if (items.length === 0) {
    return (
      <div style={{ padding: 12 }}>
        <Typography.Text type="secondary">Позиций нет</Typography.Text>
      </div>
    );
  }

  const showInv = kind === 'os2_transfer';
  type Item = (typeof items)[number];
  const columns: NonNullable<Parameters<typeof Table<Item>>[0]['columns']> = [
    { title: '№', dataIndex: 'lineNo', width: 50 },
    { title: 'Название', dataIndex: 'nameRaw' },
  ];
  if (showInv) {
    columns.push({
      title: 'Инв.№',
      dataIndex: 'inventoryNumber',
      width: 110,
      render: (v: string | null) => v ?? '—',
    });
  }
  columns.push(
    {
      title: 'Кол-во',
      dataIndex: 'qty',
      width: 90,
      render: (v: string | null) => formatDecimal(v),
    },
    { title: 'Ед.', dataIndex: 'unit', width: 60 },
    {
      title: 'Цена',
      dataIndex: 'price',
      width: 130,
      render: (v: string | null) => formatMoneyRu(v),
    },
    {
      title: 'Сумма НДС',
      dataIndex: 'vatSum',
      width: 120,
      render: (v: string | null) => formatMoneyRu(v),
    },
    {
      title: 'Сумма',
      dataIndex: 'sum',
      width: 130,
      render: (v: string | null) => formatMoneyRu(v),
    },
  );

  return (
    <Table<Item>
      dataSource={items}
      columns={columns}
      rowKey="id"
      size="small"
      pagination={false}
      style={{ background: 'transparent' }}
    />
  );
}
