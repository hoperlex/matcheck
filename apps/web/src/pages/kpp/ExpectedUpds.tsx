import { Card, Space, Tag, Tooltip, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type {
  Counterparty,
  SourceDocument,
  SourceDocumentListResponseSchema,
  UpdCheck,
  UpdValidation,
} from '@matcheck/contracts';
import type { z } from 'zod';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';

type List = z.infer<typeof SourceDocumentListResponseSchema>;

function checkLabel(c: UpdCheck): string {
  const row = typeof c.scope === 'object' && c.scope ? c.scope.row : null;
  switch (c.name) {
    case 'sum_total':
      return 'Σ сумм по строкам vs итог';
    case 'vat_total':
      return 'Σ НДС по строкам vs итог';
    case 'items_count':
      return 'Кол-во позиций';
    case 'row_qty_price':
      return `Строка ${row ?? '?'}: qty×price`;
    case 'row_vat_rate':
      return `Строка ${row ?? '?'}: НДС%`;
  }
}

function MismatchTag({ v }: { v: UpdValidation }) {
  const fails = v.checks.filter((c) => !c.ok);
  if (fails.length === 0) return null;
  const tooltip = (
    <Space direction="vertical" size={2}>
      {fails.slice(0, 5).map((c, idx) => (
        <Typography.Text key={idx} style={{ color: 'inherit' }}>
          {checkLabel(c)}: {c.expected ?? '—'} vs {c.actual ?? '—'} (Δ {c.diff ?? '—'})
        </Typography.Text>
      ))}
      {fails.length > 5 ? <Typography.Text>… и ещё {fails.length - 5}</Typography.Text> : null}
    </Space>
  );
  return (
    <Tooltip title={tooltip}>
      <Tag color="warning" style={{ marginLeft: 6 }}>
        ⚠ расхождение
      </Tag>
    </Tooltip>
  );
}

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
          render: (_: unknown, r: SourceDocument) => (
            <span>
              {r.totalSum ? `${r.totalSum} ₽` : '—'}
              {r.validation?.hasMismatch ? <MismatchTag v={r.validation} /> : null}
            </span>
          ),
        },
      ]}
      cardRender={(r) => (
        <Card style={{ width: '100%' }} size="small">
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Space>
              <Tag color="blue">{r.docNumber ?? '— без номера —'}</Tag>
              <Typography.Text strong>{r.docDate ?? '—'}</Typography.Text>
              {r.validation?.hasMismatch ? <MismatchTag v={r.validation} /> : null}
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
