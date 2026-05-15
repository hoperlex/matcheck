import { Modal, Table, Tabs, Tag, Typography, Spin, Alert, Space, Button, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SourceDirection,
  SourceDocumentDetail,
  SourceDocumentFileResponse,
} from '@matcheck/contracts';
import { api, ApiError } from '../../services/api';
import { formatDecimal } from '../../shared/utils/formatDecimal';

type Item = SourceDocumentDetail['items'][number];

function directionLabel(d: SourceDirection): string {
  return d === 'inbound' ? 'Приёмка' : 'Отгрузка';
}

export function SourceDocumentDetailModal({
  id,
  open,
  onClose,
}: {
  id: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();

  const detail = useQuery({
    queryKey: ['source-document', id],
    queryFn: () => api.get<SourceDocumentDetail>(`/source-documents/${id}`),
    enabled: open && !!id,
  });

  const file = useQuery({
    queryKey: ['source-document-file', id],
    queryFn: () => api.get<SourceDocumentFileResponse>(`/source-documents/${id}/file`),
    enabled: open && !!id,
    retry: false,
  });

  const switchDirection = useMutation({
    mutationFn: (next: SourceDirection) =>
      api.patch<SourceDocumentDetail>(`/source-documents/${id}/direction`, { direction: next }),
    onSuccess: () => {
      message.success('Направление обновлено');
      void qc.invalidateQueries({ queryKey: ['source-documents'] });
      void qc.invalidateQueries({ queryKey: ['source-document', id] });
    },
    onError: (err: Error) => message.error(`Не удалось: ${err.message}`),
  });

  const sd = detail.data;
  const items = sd?.items ?? [];
  const nextDirection: SourceDirection | null = sd
    ? sd.direction === 'inbound'
      ? 'outbound'
      : 'inbound'
    : null;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={
        sd ? (
          <Space wrap>
            <Tag color={sd.direction === 'inbound' ? 'green' : 'purple'}>
              {directionLabel(sd.direction)}
            </Tag>
            <Tag color={sd.kind === 'upd' ? 'blue' : 'gold'}>
              {sd.kind === 'upd' ? 'УПД' : 'Заявка'}
            </Tag>
            {sd.siteName ? <Tag>Объект: {sd.siteName}</Tag> : null}
            {sd.contractorName ? <Tag>Подрядчик: {sd.contractorName}</Tag> : null}
            {sd.supplierName ? <Tag>Поставщик: {sd.supplierName}</Tag> : null}
            <span>
              {sd.docNumber ?? '— без номера —'}
              {sd.docDate ? ` от ${sd.docDate}` : ''}
            </span>
          </Space>
        ) : (
          'Документ'
        )
      }
      width="90vw"
      style={{ top: 20 }}
      footer={
        sd && nextDirection ? (
          <Button
            onClick={() => switchDirection.mutate(nextDirection)}
            loading={switchDirection.isPending}
          >
            Перевести в «{directionLabel(nextDirection)}»
          </Button>
        ) : null
      }
      destroyOnClose
    >
      {detail.isLoading && (
        <Space direction="vertical" align="center" style={{ width: '100%', padding: 32 }}>
          <Spin size="large" />
        </Space>
      )}
      {detail.error && (
        <Alert
          type="error"
          message="Не удалось загрузить документ"
          description={(detail.error as Error).message}
          showIcon
        />
      )}
      {sd && (
        <Tabs
          defaultActiveKey="items"
          items={[
            {
              key: 'items',
              label: `Позиции (${items.length})`,
              children: (
                <>
                  <Table<Item>
                    dataSource={items}
                    rowKey="id"
                    size="small"
                    pagination={false}
                    scroll={{ y: '60vh' }}
                    columns={[
                      { title: '№', dataIndex: 'lineNo', width: 50 },
                      { title: 'Наименование', dataIndex: 'nameRaw' },
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
                        width: 100,
                        render: (v: string | null) => formatDecimal(v),
                      },
                      {
                        title: 'Сумма',
                        dataIndex: 'sum',
                        width: 110,
                        render: (v: string | null) => formatDecimal(v),
                      },
                      {
                        title: 'Ставка НДС',
                        dataIndex: 'vatRate',
                        width: 90,
                        render: (v: string | null) => formatDecimal(v),
                      },
                      {
                        title: 'Сумма НДС',
                        dataIndex: 'vatSum',
                        width: 110,
                        render: (v: string | null) => formatDecimal(v),
                      },
                    ]}
                  />
                  <Space style={{ marginTop: 12 }}>
                    <Typography.Text>
                      <b>Итого:</b> {formatDecimal(sd.totalSum) || '—'}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      НДС: {formatDecimal(sd.vatSum) || '—'}
                    </Typography.Text>
                  </Space>
                </>
              ),
            },
            {
              key: 'original',
              label: 'Оригинал',
              children: file.isLoading ? (
                <Spin />
              ) : file.data ? (
                <iframe
                  src={`/api/v1/source-documents/${id}/file/raw`}
                  title="Оригинал документа"
                  style={{ width: '100%', height: '75vh', border: '1px solid #f0f0f0' }}
                />
              ) : (
                <Typography.Text type="secondary">
                  {file.error instanceof ApiError && file.error.status === 404
                    ? 'Оригинальный файл недоступен (документ загружен из XML).'
                    : 'Не удалось получить оригинал.'}
                </Typography.Text>
              ),
            },
          ]}
        />
      )}
    </Modal>
  );
}
