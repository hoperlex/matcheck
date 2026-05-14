import { Card, Space, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type {
  Counterparty,
  SourceDocument,
  SourceDocumentListResponseSchema,
} from '@matcheck/contracts';
import type { z } from 'zod';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';

type List = z.infer<typeof SourceDocumentListResponseSchema>;

export function ExpectedUpds({ onOpen }: { onOpen: (upd: SourceDocument) => void }) {
  const list = useQuery({
    queryKey: ['source-documents', 'unaccepted-upd', 'list'],
    queryFn: () => api.get<List>('/source-documents?kind=upd&unaccepted=true&limit=100'),
  });

  const counterparties = useQuery({
    queryKey: ['counterparties'],
    queryFn: () =>
      api.get<{ items: Counterparty[]; total: number }>('/counterparties'),
  });

  const suppliersMap = new Map<string, string>();
  for (const c of counterparties.data?.items ?? []) {
    suppliersMap.set(c.id, c.name);
  }
  const supplierName = (id: string | null | undefined) =>
    id ? suppliersMap.get(id) ?? '—' : '—';

  return (
    <ResponsiveTable<SourceDocument>
      items={list.data?.items ?? []}
      loading={list.isLoading}
      rowKey="id"
      onRowClick={(r) => onOpen(r)}
      emptyText="Нет ожидаемых УПД"
      columns={[
        {
          title: 'Номер',
          dataIndex: 'docNumber',
          render: (v: string | null) => v ?? '— без номера —',
        },
        { title: 'Дата', dataIndex: 'docDate', render: (v: string | null) => v ?? '—' },
        {
          title: 'Поставщик',
          key: 'supplier',
          render: (_: unknown, r: SourceDocument) => supplierName(r.supplierId),
        },
        {
          title: 'Сумма',
          key: 'total',
          render: (_: unknown, r: SourceDocument) => (r.totalSum ? `${r.totalSum} ₽` : '—'),
        },
      ]}
      cardRender={(r) => (
        <Card style={{ width: '100%' }} size="small">
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Space>
              <Tag color="blue">{r.docNumber ?? '— без номера —'}</Tag>
              <Typography.Text strong>{r.docDate ?? '—'}</Typography.Text>
            </Space>
            <Typography.Text type="secondary">
              {supplierName(r.supplierId)}
              {r.totalSum ? ` · ${r.totalSum} ₽` : ''}
            </Typography.Text>
          </Space>
        </Card>
      )}
    />
  );
}
