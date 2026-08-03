import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  DatePicker,
  Descriptions,
  Image,
  Modal,
  Popconfirm,
  Segmented,
  Space,
  Tag,
  Typography,
  message,
} from 'antd';
import { DownloadOutlined, FileTextOutlined, UndoOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import type {
  MailMessageBody,
  MailMessageDetail,
  MailResolveResponse,
} from '@matcheck/contracts';
import { api, apiDownload } from '../../services/api';
import type { ApiError } from '../../services/api';
import { SiteSelect } from './SiteSelect';

const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|heic|tiff?)$/i;
const PDF_RE = /\.pdf$/i;

function stateTag(state: MailMessageDetail['attachments'][number]['state']) {
  switch (state) {
    case 'kept':
      return <Tag color="green">в пакет</Tag>;
    case 'restored':
      return <Tag color="green">возвращено</Tag>;
    case 'suspected_signature':
      return <Tag color="gold">похоже на подпись</Tag>;
    default:
      return <Tag>отброшено</Tag>;
  }
}

/**
 * Карточка разбора письма: что пришло, какие файлы уйдут в пакет и на какой
 * объект их отправить.
 *
 * Объект выбирается руками — это единственное, чего система не знает: в УПД его
 * нет, а по отправителю он не определяется. Подсказка матчера подставляется
 * заранее, но подтверждает всегда человек.
 */
export function MailReviewModal({
  messageId,
  onClose,
}: {
  messageId: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [siteId, setSiteId] = useState<string | null>(null);
  const [direction, setDirection] = useState<'inbound' | 'outbound'>('inbound');
  const [expectedDate, setExpectedDate] = useState<dayjs.Dayjs | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['mail-message', messageId],
    queryFn: () => api.get<MailMessageDetail>(`/mail/messages/${messageId}`),
    enabled: !!messageId,
  });

  // Тело письма в БД не хранится — оно достаётся из сохранённого оригинала,
  // поэтому запрос отдельный и без повторов: недоступное хранилище не должно
  // задерживать карточку.
  const body = useQuery({
    queryKey: ['mail-message-body', messageId],
    queryFn: () => api.get<MailMessageBody>(`/mail/messages/${messageId}/body`),
    enabled: !!messageId,
    retry: false,
  });

  // Подсказку подставляем при открытии, но пользователь волен её сменить.
  useEffect(() => {
    if (!detail.data) return;
    setSiteId(detail.data.suggestedSiteId ?? null);
    setConflict(null);
    setActiveId(detail.data.attachments.find((a) => a.willBeIngested)?.id ?? null);
  }, [detail.data]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['mail-messages'] });
    void qc.invalidateQueries({ queryKey: ['mail-review-summary'] });
    // Пакет уходит в распознавание — список документов обновится сам.
    void qc.invalidateQueries({ queryKey: ['source-documents'] });
  };

  const resolve = useMutation({
    mutationFn: () =>
      api.post<MailResolveResponse>(`/mail/messages/${messageId}/resolve`, {
        siteId,
        direction,
        expectedDate: expectedDate ? expectedDate.format('YYYY-MM-DD') : null,
      }),
    onSuccess: (res) => {
      message.success(
        res.outcome === 'reused'
          ? 'Этот комплект уже загружен — письмо привязано к существующему пакету'
          : 'Документы отправлены на распознавание',
      );
      invalidate();
      onClose();
    },
    onError: (e: unknown) => {
      const err = e as ApiError;
      // Конфликт областей — не техническая ошибка, а решение для человека:
      // показываем прямо в карточке и не закрываем её.
      if (err.status === 409) {
        setConflict(err.message || 'Тот же комплект уже загружен на другой объект');
        return;
      }
      message.error(err.message || 'Не удалось создать документы');
    },
  });

  const reject = useMutation({
    mutationFn: () => api.post(`/mail/messages/${messageId}/reject`, {}),
    onSuccess: () => {
      message.success('Письмо отклонено');
      invalidate();
      onClose();
    },
    onError: (e: unknown) => message.error((e as ApiError).message || 'Не удалось отклонить'),
  });

  const restore = useMutation({
    mutationFn: (attachmentId: string) =>
      api.post(`/mail/messages/${messageId}/attachments/${attachmentId}/restore`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mail-message', messageId] });
    },
    onError: (e: unknown) => message.error((e as ApiError).message || 'Не удалось вернуть файл'),
  });

  const data = detail.data;
  const ingestable = data?.attachments.filter((a) => a.willBeIngested) ?? [];
  const active = data?.attachments.find((a) => a.id === activeId) ?? null;
  const activeUrl = active
    ? `/api/v1/mail/messages/${messageId}/attachments/${active.id}/raw`
    : null;

  const download = async (attachmentId: string, filename: string | null) => {
    try {
      const { blob } = await apiDownload(
        `/mail/messages/${messageId}/attachments/${attachmentId}/raw?download=1`,
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename ?? 'attachment';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      message.error('Не удалось скачать файл');
    }
  };

  return (
    <Modal
      open={!!messageId}
      onCancel={onClose}
      title="Разбор письма"
      // Почти во весь экран: оператор сверяет скан документа с выбором объекта,
      // и в маленьком окне предпросмотр бесполезен — приходилось бы скачивать
      // файл. Тело со своим скроллом, чтобы шапка и кнопки оставались на месте.
      width="85vw"
      style={{ top: '7.5vh', maxWidth: '85vw', paddingBottom: 0 }}
      styles={{ body: { height: 'calc(85vh - 108px)', overflow: 'hidden', paddingTop: 12 } }}
      destroyOnClose
      footer={
        <Space>
          <Popconfirm
            title="Отклонить письмо?"
            description="Документы созданы не будут. Письмо останется в истории."
            okText="Отклонить"
            cancelText="Отмена"
            okButtonProps={{ danger: true }}
            onConfirm={() => reject.mutate()}
          >
            <Button danger loading={reject.isPending}>
              Отклонить
            </Button>
          </Popconfirm>
          <Button onClick={onClose}>Закрыть</Button>
          <Button
            type="primary"
            loading={resolve.isPending}
            disabled={!siteId || ingestable.length === 0}
            onClick={() => resolve.mutate()}
          >
            Создать документы
          </Button>
        </Space>
      }
    >
      {data && (
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}
        >
          <Descriptions size="small" column={3} bordered>
            <Descriptions.Item label="От кого">{data.fromAddress ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Получено">
              {data.receivedAt ? dayjs(data.receivedAt).format('DD.MM.YYYY HH:mm') : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Ящик">{data.accountName}</Descriptions.Item>
            <Descriptions.Item label="Тема" span={3}>
              {data.subject ?? '—'}
            </Descriptions.Item>
          </Descriptions>

          {conflict && (
            <Alert
              type="warning"
              showIcon
              message="Такой комплект уже загружен на другой объект"
              description={conflict}
            />
          )}
          {data.suggestedSiteId && (
            <Alert
              type="info"
              showIcon
              message={`Предполагаемый объект: ${data.suggestedSiteCode ?? ''} ${
                data.suggestedSiteName ?? ''
              }`}
              description="Подсказка по тексту письма или имени файла. Проверьте, прежде чем подтверждать: автоматически по такой подсказке документы не создаются."
            />
          )}
          {ingestable.length === 0 && (
            <Alert
              type="warning"
              showIcon
              message="В письме нет файлов для пакета"
              description="Все вложения отброшены. Верните нужный файл кнопкой «Вернуть» или отклоните письмо."
            />
          )}

          {/* Две колонки на всю оставшуюся высоту: слева решение оператора,
              справа документ. Скроллится каждая отдельно — список вложений не
              уводит предпросмотр за край экрана. */}
          <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>
            <div
              style={{
                width: 380,
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                overflowY: 'auto',
              }}
            >
              {/* Текст письма: объект подрядчики часто называют именно в теле,
                  а не в теме. Грузится отдельным запросом — сбой чтения письма
                  из хранилища не должен ломать разбор целиком. */}
              <Typography.Text strong>Текст письма</Typography.Text>
              <div
                style={{
                  border: '1px solid #f0f0f0',
                  borderRadius: 6,
                  background: '#fafafa',
                  padding: '6px 8px',
                  maxHeight: 180,
                  overflowY: 'auto',
                  fontSize: 13,
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                }}
              >
                {body.isPending ? (
                  <Typography.Text type="secondary">Загружаем текст письма…</Typography.Text>
                ) : body.isError ? (
                  <Typography.Text type="secondary">
                    Не удалось прочитать текст письма. Вложения и разбор это не затрагивает.
                  </Typography.Text>
                ) : body.data?.text ? (
                  <>
                    {body.data.text}
                    {body.data.truncated && (
                      <Typography.Paragraph
                        type="secondary"
                        style={{ fontSize: 12, marginBottom: 0, marginTop: 8 }}
                      >
                        Показаны первые 20 000 символов.
                      </Typography.Paragraph>
                    )}
                  </>
                ) : (
                  <Typography.Text type="secondary">
                    В письме нет текста — только вложения.
                  </Typography.Text>
                )}
              </div>

              <Typography.Text strong>Вложения ({data.attachments.length})</Typography.Text>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {data.attachments.map((a) => (
                  <div
                    key={a.id}
                    onClick={() => setActiveId(a.id)}
                    style={{
                      border: `1px solid ${a.id === activeId ? '#1677ff' : '#f0f0f0'}`,
                      borderRadius: 6,
                      padding: '6px 8px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <FileTextOutlined />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {a.filename ?? `Файл ${a.idx + 1}`}
                      </div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {Math.max(1, Math.round(a.sizeBytes / 1024))} КБ {stateTag(a.state)}
                        {a.skipReason ? ` · ${a.skipReason}` : ''}
                      </Typography.Text>
                    </div>
                    <Space size={4} onClick={(e) => e.stopPropagation()}>
                      {/* Только отложенное как подпись: отброшенное по типу или
                          размеру в хранилище не залито, возвращать нечего. */}
                      {a.state === 'suspected_signature' && (
                        <Button
                          size="small"
                          icon={<UndoOutlined />}
                          loading={restore.isPending}
                          onClick={() => restore.mutate(a.id)}
                        >
                          Вернуть
                        </Button>
                      )}
                      <Button
                        size="small"
                        icon={<DownloadOutlined />}
                        onClick={() => void download(a.id, a.filename)}
                      />
                    </Space>
                  </div>
                ))}
              </div>

              <Typography.Text strong>Куда отправить</Typography.Text>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <SiteSelect value={siteId} onChange={setSiteId} />
                <Segmented
                  block
                  value={direction}
                  onChange={(v) => setDirection(v as 'inbound' | 'outbound')}
                  options={[
                    { label: 'Приёмка', value: 'inbound' },
                    { label: 'Отгрузка', value: 'outbound' },
                  ]}
                />
                <div>
                  <DatePicker
                    style={{ width: '100%' }}
                    format="DD.MM.YYYY"
                    placeholder="Дата поставки (необязательно)"
                    value={expectedDate}
                    onChange={setExpectedDate}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Без даты документ придёт инспектору в группу «Остальные».
                  </Typography.Text>
                </div>
              </div>
            </div>

            {/* Предпросмотр занимает всю оставшуюся ширину и высоту: оператор
                сверяет объект по самому документу, а не по имени файла. */}
            <div
              style={{
                flex: 1,
                minWidth: 0,
                border: '1px solid #f0f0f0',
                borderRadius: 6,
                overflow: 'hidden',
                background: '#fafafa',
              }}
            >
              {activeUrl && active ? (
                IMAGE_RE.test(active.filename ?? '') ? (
                  <Image
                    src={activeUrl}
                    wrapperStyle={{
                      width: '100%',
                      height: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                    preview={{ mask: 'Открыть' }}
                  />
                ) : PDF_RE.test(active.filename ?? '') ? (
                  <iframe
                    key={active.id}
                    src={activeUrl}
                    title={active.filename ?? 'Вложение'}
                    style={{ width: '100%', height: '100%', border: 0 }}
                  />
                ) : (
                  <div style={{ padding: 16 }}>
                    <Typography.Text type="secondary">
                      Предпросмотр недоступен — скачайте файл кнопкой слева.
                    </Typography.Text>
                  </div>
                )
              ) : (
                <div style={{ padding: 16 }}>
                  <Typography.Text type="secondary">
                    Выберите вложение слева, чтобы посмотреть его.
                  </Typography.Text>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
