import { useState } from 'react';
import { Card, Segmented, Typography, Tag, Space, Button, Upload, message } from 'antd';
import type { UploadProps } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SourceDocumentListResponseSchema } from '@matcheck/contracts';
import type { z } from 'zod';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { UpdPdfUploadModal } from './UpdPdfUploadModal';

type List = z.infer<typeof SourceDocumentListResponseSchema>;
type Row = List['items'][number];

export default function InboxPage() {
  const [kind, setKind] = useState<'all' | 'upd' | 'request'>('all');
  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const qc = useQueryClient();

  const list = useQuery({
    queryKey: ['source-documents', { kind }],
    queryFn: () => api.get<List>(`/source-documents${kind === 'all' ? '' : `?kind=${kind}`}`),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const xml = await file.text();
      return api.post('/source-documents/upload-upd', { xml });
    },
    onSuccess: () => {
      message.success('УПД загружен');
      void qc.invalidateQueries({ queryKey: ['source-documents'] });
    },
    onError: (err: Error) => message.error(`Не удалось: ${err.message}`),
  });

  const uploadProps: UploadProps = {
    accept: '.xml',
    showUploadList: false,
    beforeUpload(file) {
      upload.mutate(file);
      return false;
    },
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Typography.Title level={3} style={{ margin: 0 }}>
          Входящие
        </Typography.Title>
        <Segmented
          value={kind}
          onChange={(v) => setKind(v as 'all' | 'upd' | 'request')}
          options={[
            { label: 'Все', value: 'all' },
            { label: 'УПД', value: 'upd' },
            { label: 'Заявки', value: 'request' },
          ]}
        />
        <Upload {...uploadProps}>
          <Button type="primary">Загрузить УПД (XML)</Button>
        </Upload>
        <Button onClick={() => setPdfModalOpen(true)}>Загрузить УПД (PDF)</Button>
      </Space>
      <ResponsiveTable<Row>
        items={list.data?.items ?? []}
        loading={list.isLoading}
        rowKey="id"
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
          { title: 'Сумма', dataIndex: 'totalSum' },
          { title: 'Происхождение', dataIndex: 'origin' },
        ]}
        cardRender={(r) => (
          <Card style={{ width: '100%' }} size="small">
            <Space direction="vertical" size={2}>
              <Tag color={r.kind === 'upd' ? 'blue' : 'gold'}>
                {r.kind === 'upd' ? 'УПД' : 'Заявка'}
              </Tag>
              <Typography.Text strong>{r.docNumber ?? '— без номера —'}</Typography.Text>
              <Typography.Text type="secondary">
                {r.docDate ?? '—'} · {r.totalSum ?? '—'} ₽
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {r.origin}
              </Typography.Text>
            </Space>
          </Card>
        )}
      />
      <UpdPdfUploadModal open={pdfModalOpen} onClose={() => setPdfModalOpen(false)} />
    </div>
  );
}
