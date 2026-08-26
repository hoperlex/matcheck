import { Alert, Button, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import type { MailReceiptDto } from '@matcheck/contracts';
import { api } from '../../services/api';
import type { ApiError } from '../../services/api';

type List = { items: MailReceiptDto[]; total: number };

function reasonOf(r: MailReceiptDto): string {
  switch (r.status) {
    case 'skipped_by_size':
      return 'письмо больше лимита';
    case 'fetch_failed':
      return 'не удалось скачать';
    case 'parse_failed':
      return 'не удалось разобрать';
    default:
      return r.status;
  }
}

function sizeMb(bytes: number | null): string {
  if (!bytes) return '—';
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/**
 * Письма, которые не удалось забрать из ящика.
 *
 * Показывается только когда такие письма есть. Это не «ошибки системы», а
 * случаи, требующие решения человека: письмо больше лимита, оборвалась связь,
 * повреждён MIME. После исчерпания попыток обычный проход к ним не вернётся —
 * граница ящика их перешагнула, — поэтому единственный путь обратно проходит
 * через кнопку повтора.
 */
export function MailFetchProblems() {
  const qc = useQueryClient();

  const list = useQuery({
    queryKey: ['mail-receipts', 'problems'],
    queryFn: () => api.get<List>('/mail/receipts?scope=problems'),
    staleTime: 60_000,
  });

  const replay = useMutation({
    mutationFn: (id: string) => api.post(`/mail/receipts/${id}/replay`, {}),
    onSuccess: () => {
      message.success('Письмо будет забрано при ближайшей проверке ящика');
      void qc.invalidateQueries({ queryKey: ['mail-receipts'] });
    },
    onError: (e: unknown) =>
      message.error((e as ApiError).message || 'Не удалось запросить повтор'),
  });

  const items = list.data?.items ?? [];
  if (items.length === 0) return null;

  return (
    <Alert
      style={{ marginBottom: 12 }}
      type="warning"
      showIcon
      // total, а не items.length: сервер отдаёт срез (по умолчанию 200), и на
      // большем числе проблем заголовок показывал бы размер страницы вместо
      // настоящего количества.
      message={`Не удалось забрать писем: ${list.data?.total ?? items.length}`}
      description={
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            Эти письма остались в ящике. Проверьте причину и запросите повторный забор — письмо
            будет скачано при ближайшей проверке, не затрагивая остальные.
          </Typography.Text>
          <Table<MailReceiptDto>
            size="small"
            pagination={false}
            rowKey="id"
            dataSource={items}
            columns={[
              {
                title: 'Когда',
                dataIndex: 'updatedAt',
                width: 130,
                render: (v: string) => dayjs(v).format('DD.MM.YYYY HH:mm'),
              },
              { title: 'Ящик', dataIndex: 'accountName', width: 160 },
              {
                title: 'Причина',
                dataIndex: 'status',
                width: 180,
                render: (_: unknown, r) => (
                  <Tooltip title={r.lastError ?? ''}>
                    <Tag color={r.status === 'skipped_by_size' ? 'gold' : 'orange'}>
                      {reasonOf(r)}
                    </Tag>
                  </Tooltip>
                ),
              },
              {
                title: 'Размер',
                dataIndex: 'sizeBytes',
                width: 90,
                render: (v: number | null) => sizeMb(v),
              },
              { title: 'Попыток', dataIndex: 'attempts', width: 80 },
              {
                title: '',
                key: 'actions',
                width: 150,
                render: (_: unknown, r) =>
                  r.replayRequested ? (
                    <Tag color="blue">повтор запрошен</Tag>
                  ) : (
                    <Button
                      size="small"
                      icon={<ReloadOutlined />}
                      loading={replay.isPending}
                      disabled={!r.canReplay}
                      onClick={() => replay.mutate(r.id)}
                    >
                      Забрать снова
                    </Button>
                  ),
              },
            ]}
          />
        </Space>
      }
    />
  );
}
