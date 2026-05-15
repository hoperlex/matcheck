import type { MouseEvent } from 'react';
import { useState } from 'react';
import { Button, Card, Popconfirm, Segmented, Space, Tabs, Tag, Typography, message } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SourceDirection, SourceDocumentListResponseSchema } from '@matcheck/contracts';
import type { z } from 'zod';
import { api, ApiError } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { formatDecimal } from '../../shared/utils/formatDecimal';
import { UpdPdfUploadModal } from './UpdPdfUploadModal';
import { UpdXmlUploadModal } from './UpdXmlUploadModal';
import { SourceDocumentDetailModal } from './SourceDocumentDetailModal';

type List = z.infer<typeof SourceDocumentListResponseSchema>;
type Row = List['items'][number];

export default function InboxPage() {
  const [direction, setDirection] = useState<SourceDirection>('inbound');
  const [kind, setKind] = useState<'all' | 'upd' | 'request'>('all');
  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [xmlModalOpen, setXmlModalOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const qc = useQueryClient();

  const list = useQuery({
    queryKey: ['source-documents', { direction, kind }],
    queryFn: () => {
      const params = new URLSearchParams({ direction });
      if (kind !== 'all') params.set('kind', kind);
      return api.get<List>(`/source-documents?${params.toString()}`);
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/source-documents/${id}`),
    onSuccess: async () => {
      message.success('УПД удалён');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['source-documents'] }),
        qc.invalidateQueries({ queryKey: ['source-documents', 'unaccepted-upd', 'list'] }),
      ]);
    },
    onError: (err: Error) => {
      if (err instanceof ApiError && err.code === 'has_references') {
        message.error(err.message);
        return;
      }
      message.error(err.message);
    },
  });

  const renderDeleteButton = (r: Row) => (
    <Popconfirm
      title="Удалить УПД?"
      description="Документ, его позиции и оригинальный файл будут удалены безвозвратно."
      okText="Да, удалить"
      cancelText="Нет"
      okButtonProps={{ danger: true }}
      onConfirm={() => del.mutate(r.id)}
    >
      <Button
        danger
        size="small"
        shape="circle"
        icon={<DeleteOutlined />}
        loading={del.isPending && del.variables === r.id}
        onClick={(e) => e.stopPropagation()}
      />
    </Popconfirm>
  );

  return (
    <div>
      <Typography.Title level={3} style={{ margin: '0 0 12px' }}>
        Документы
      </Typography.Title>
      <Tabs
        activeKey={direction}
        onChange={(k) => setDirection(k as SourceDirection)}
        items={[
          { key: 'inbound', label: 'Приёмка' },
          { key: 'outbound', label: 'Отгрузка' },
        ]}
      />
      <Space style={{ marginBottom: 16 }} wrap>
        <Segmented
          value={kind}
          onChange={(v) => setKind(v as 'all' | 'upd' | 'request')}
          options={[
            { label: 'Все', value: 'all' },
            { label: 'УПД', value: 'upd' },
            { label: 'Заявки', value: 'request' },
          ]}
        />
        <Button type="primary" onClick={() => setXmlModalOpen(true)}>
          Загрузить УПД (XML)
        </Button>
        <Button onClick={() => setPdfModalOpen(true)}>Загрузить УПД (PDF)</Button>
      </Space>
      <ResponsiveTable<Row>
        items={list.data?.items ?? []}
        loading={list.isLoading}
        rowKey="id"
        onRowClick={(r) => setSelectedId(r.id)}
        columns={[
          {
            title: 'Тип',
            dataIndex: 'kind',
            render: (k: Row['kind']) => (
              <Tag color={k === 'upd' ? 'blue' : 'gold'}>{k === 'upd' ? 'УПД' : 'Заявка'}</Tag>
            ),
          },
          { title: '№', dataIndex: 'docNumber' },
          { title: 'Дата', dataIndex: 'docDate' },
          {
            title: 'Объект',
            dataIndex: 'siteName',
            render: (v: string | null | undefined) => v ?? '—',
          },
          {
            title: 'Подрядчик',
            dataIndex: 'contractorName',
            render: (v: string | null | undefined) => v ?? '—',
          },
          {
            title: 'Поставщик',
            dataIndex: 'supplierName',
            render: (v: string | null | undefined) => v ?? '—',
          },
          {
            title: 'Сумма',
            dataIndex: 'totalSum',
            render: (v: string | null) => formatDecimal(v) || '—',
          },
          { title: 'Происхождение', dataIndex: 'origin' },
          {
            title: '',
            key: 'actions',
            width: 56,
            align: 'right' as const,
            onCell: () => ({
              onClick: (e: MouseEvent) => e.stopPropagation(),
            }),
            render: (_: unknown, r: Row) => renderDeleteButton(r),
          },
        ]}
        cardRender={(r) => (
          <Card style={{ width: '100%' }} size="small">
            <Space direction="vertical" size={2} style={{ width: '100%', position: 'relative' }}>
              <Tag color={r.kind === 'upd' ? 'blue' : 'gold'}>
                {r.kind === 'upd' ? 'УПД' : 'Заявка'}
              </Tag>
              <Typography.Text strong>{r.docNumber ?? '— без номера —'}</Typography.Text>
              <Typography.Text type="secondary">
                {r.docDate ?? '—'} · {formatDecimal(r.totalSum) || '—'} ₽
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {r.siteName ?? '—'} · {r.contractorName ?? '—'} · {r.supplierName ?? '—'}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {r.origin}
              </Typography.Text>
              <div
                style={{ position: 'absolute', top: 0, right: 0 }}
                onClick={(e) => e.stopPropagation()}
              >
                {renderDeleteButton(r)}
              </div>
            </Space>
          </Card>
        )}
      />
      <UpdPdfUploadModal
        open={pdfModalOpen}
        direction={direction}
        onClose={() => setPdfModalOpen(false)}
      />
      <UpdXmlUploadModal
        open={xmlModalOpen}
        direction={direction}
        onClose={() => setXmlModalOpen(false)}
      />
      <SourceDocumentDetailModal
        id={selectedId}
        open={!!selectedId}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}
