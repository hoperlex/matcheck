import { Drawer, Empty, Spin, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { LlmCall } from '@matcheck/contracts';
import { api } from '../../services/api';

type Resp = { items: LlmCall[] };

/**
 * Админский журнал общения с LLM для конкретного документа. Открывается из
 * SourceDocumentDetailModal по кнопке «Логи распознавания». Помогает
 * диагностировать, почему модель вернула null в volumeM3, перепутала
 * колонки в УПД и т.п. — показывает сырой ответ провайдера до Zod-парсинга.
 */
export function LlmCallsDrawer({
  sourceDocumentId,
  open,
  onClose,
}: {
  sourceDocumentId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: ['source-document-llm-calls', sourceDocumentId],
    queryFn: () =>
      api.get<Resp>(`/source-documents/${sourceDocumentId}/llm-calls`),
    enabled: !!sourceDocumentId && open,
  });

  return (
    <Drawer
      title="Логи распознавания (LLM)"
      open={open}
      onClose={onClose}
      width={720}
      destroyOnClose
      maskClosable={false}
      keyboard={false}
    >
      {q.isLoading ? (
        <Spin />
      ) : !q.data || q.data.items.length === 0 ? (
        <Empty description="Нет записей" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {q.data.items.map((c) => (
            <div
              key={c.id}
              style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: 12 }}
            >
              <div style={{ marginBottom: 8 }}>
                <Tag color={c.errorCode ? 'red' : 'green'}>
                  {c.errorCode ?? 'ok'}
                </Tag>
                <Tag>{c.model ?? '—'}</Tag>
                <Tag color="blue">{c.latencyMs} мс</Tag>
                {c.promptTokens != null && (
                  <Tag>входные токены: {c.promptTokens}</Tag>
                )}
                {c.completionTokens != null && (
                  <Tag>выходные токены: {c.completionTokens}</Tag>
                )}
                <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                  {new Date(c.createdAt).toLocaleString('ru-RU')}
                </Typography.Text>
              </div>
              {c.errorMessage && (
                <Typography.Paragraph type="danger" style={{ whiteSpace: 'pre-wrap' }}>
                  {c.errorMessage}
                </Typography.Paragraph>
              )}
              <details style={{ marginBottom: 8 }}>
                <summary style={{ cursor: 'pointer' }}>Запрос (messages)</summary>
                <pre
                  style={{
                    background: '#fafafa',
                    padding: 8,
                    borderRadius: 4,
                    fontSize: 12,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: 400,
                    overflow: 'auto',
                  }}
                >
                  {JSON.stringify(c.requestMessages, null, 2)}
                </pre>
              </details>
              <details>
                <summary style={{ cursor: 'pointer' }}>Сырой ответ модели</summary>
                <pre
                  style={{
                    background: '#fafafa',
                    padding: 8,
                    borderRadius: 4,
                    fontSize: 12,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: 400,
                    overflow: 'auto',
                  }}
                >
                  {c.responseRaw ?? '(пусто)'}
                </pre>
              </details>
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}
