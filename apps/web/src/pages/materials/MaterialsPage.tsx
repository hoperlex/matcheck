import { useState } from 'react';
import { Card, Input, Space, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { MaterialJournalResponseSchema } from '@matcheck/contracts';
import type { z } from 'zod';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { SourceDocumentDetailModal } from '../inbox/SourceDocumentDetailModal';

type JournalResponse = z.infer<typeof MaterialJournalResponseSchema>;
type Row = JournalResponse['items'][number];

const formatDocDate = (v: string | null) =>
  v ? v.split('-').reverse().join('.') : '—';

const trimQty = (s: string) =>
  s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;

export default function MaterialsPage() {
  const [q, setQ] = useState('');
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['materials-journal', { q }],
    queryFn: () =>
      api.get<JournalResponse>(
        `/materials/journal${q ? `?q=${encodeURIComponent(q)}` : ''}`,
      ),
  });

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Typography.Title level={3} style={{ margin: 0 }}>
          Материалы
        </Typography.Title>
        <Input.Search
          placeholder="Поиск по названию"
          allowClear
          onSearch={setQ}
          style={{ width: 320 }}
        />
      </Space>
      <ResponsiveTable<Row>
        items={list.data?.items ?? []}
        loading={list.isLoading}
        rowKey="id"
        onRowClick={(r) => r.sourceDocumentId && setSelectedSourceId(r.sourceDocumentId)}
        columns={[
          { title: 'Материал', dataIndex: 'materialName' },
          {
            title: 'Кол-во',
            dataIndex: 'qty',
            render: (v: string | null) => trimQty(v ?? '0'),
            width: 110,
          },
          { title: 'Ед.', dataIndex: 'unit', width: 80 },
          { title: 'Поставщик', dataIndex: 'supplierName', render: (v) => v ?? '—' },
          {
            title: '№ УПД',
            dataIndex: 'docNumber',
            render: (v: string | null) => v ?? '—',
            width: 140,
          },
          {
            title: 'Дата УПД',
            dataIndex: 'docDate',
            render: (v: string | null) => formatDocDate(v),
            width: 110,
          },
          {
            title: 'Дата приёмки',
            dataIndex: 'arrivedAt',
            render: (v: string | null) =>
              v ? new Date(v).toLocaleDateString('ru-RU') : '—',
            width: 130,
          },
        ]}
        cardRender={(r) => (
          <Card style={{ width: '100%' }} size="small">
            <Space direction="vertical" size={2}>
              <Typography.Text strong>{r.materialName}</Typography.Text>
              <Typography.Text>
                {trimQty(r.qty)} {r.unit}
              </Typography.Text>
              <Typography.Text type="secondary">
                {r.supplierName ?? '— поставщик не указан —'}
              </Typography.Text>
              <Space wrap size={4}>
                {r.docNumber && <Tag color="blue">УПД {r.docNumber}</Tag>}
                {r.docDate && (
                  <Typography.Text type="secondary">от {formatDocDate(r.docDate)}</Typography.Text>
                )}
                {r.arrivedAt && (
                  <Typography.Text type="secondary">
                    · приёмка {new Date(r.arrivedAt).toLocaleDateString('ru-RU')}
                  </Typography.Text>
                )}
              </Space>
            </Space>
          </Card>
        )}
      />
      <SourceDocumentDetailModal
        id={selectedSourceId}
        open={!!selectedSourceId}
        onClose={() => setSelectedSourceId(null)}
      />
    </div>
  );
}
