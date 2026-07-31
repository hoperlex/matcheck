import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Card, Segmented, Space, Tag, Tooltip, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import type { MailMessageDto, MailReviewFilter } from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { PageTabs, type PageTabItem } from '../../shared/ui/PageTabs';
import { MailFetchProblems } from './MailFetchProblems';
import { MailReviewModal } from './MailReviewModal';

type List = { items: MailMessageDto[]; total: number };

/**
 * Причина, по которой письмо не прошло само. Пользователю важно не имя кода, а
 * что с этим делать, поэтому расшифровываем.
 */
function reasonHint(row: MailMessageDto): { label: string; color: string; tip: string } {
  if (row.rejectReason === 'cross_scope_conflict') {
    return {
      label: 'Дубль на другом объекте',
      color: 'orange',
      tip: 'Такой же комплект файлов уже загружен на другую площадку. Проверьте, не повторная ли это отправка.',
    };
  }
  if (row.attachmentsCount === 0) {
    return {
      label: 'Нет файлов',
      color: 'default',
      tip: 'Все вложения отброшены фильтром. Откройте письмо и верните нужный файл, если он там есть.',
    };
  }
  if (row.suggestedSiteId) {
    return {
      label: 'Объект под вопросом',
      color: 'blue',
      tip: 'Подрядчик не написал «Объект: КОД». Есть подсказка по тексту письма — проверьте и подтвердите.',
    };
  }
  return {
    label: 'Объект не указан',
    color: 'gold',
    tip: 'В письме нет строки «Объект: КОД». Выберите объект вручную.',
  };
}

/**
 * «Разбор почты» — третья вкладка «Документов».
 *
 * Сюда попадает только то, что нельзя провести автоматически. Письмо с явным
 * маркером `Объект: КОД` становится документом само и в этом списке не
 * появляется — пустая вкладка означает, что почта работает как задумано.
 */
export default function MailReview() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(null);

  const filter = (params.get('status') ?? 'pending') as MailReviewFilter;

  const list = useQuery({
    queryKey: ['mail-messages', filter],
    queryFn: () => api.get<List>(`/mail/messages?status=${filter}`),
  });
  const summary = useQuery({
    queryKey: ['mail-review-summary'],
    queryFn: () => api.get<{ pending: number; configured: boolean }>('/mail/review/summary'),
    staleTime: 60_000,
  });

  const tabs: PageTabItem[] = [
    { key: 'inbound', label: 'Приёмка' },
    { key: 'outbound', label: 'Отгрузка' },
    { key: 'mail', label: 'Разбор почты', count: summary.data?.pending ?? null },
  ];

  return (
    <>
      <StickyPageHeader
        header={
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                flexWrap: 'wrap',
                marginBottom: 8,
              }}
            >
              <Typography.Title level={3} style={{ margin: 0 }}>
                Документы
              </Typography.Title>
              <PageTabs
                items={tabs}
                activeKey="mail"
                onChange={(k) => {
                  if (k === 'mail') return;
                  navigate(k === 'outbound' ? '/documents?direction=outbound' : '/documents');
                }}
              />
            </div>
            <Space style={{ marginBottom: 8 }}>
              <Segmented
                value={filter}
                onChange={(v) => setParams({ status: String(v) })}
                options={[
                  { label: 'Ждут разбора', value: 'pending' },
                  { label: 'Принятые', value: 'ingested' },
                  { label: 'Отклонённые', value: 'rejected' },
                  { label: 'Все', value: 'all' },
                ]}
              />
            </Space>
          </>
        }
      >
        {/* Незабранные письма — выше списка: пока они висят, часть документов
            вообще не дошла до портала. */}
        <MailFetchProblems />
        {summary.data && !summary.data.configured && (
          <Alert
            style={{ marginBottom: 12 }}
            type="info"
            showIcon
            message="Почтовый ящик для документов ещё не настроен"
            description="Заведите ящик в разделе «Администрирование → Почта» и включите опрос — после этого письма подрядчиков будут появляться здесь."
          />
        )}
        <ResponsiveTable<MailMessageDto>
          items={list.data?.items ?? []}
          loading={list.isLoading}
          rowKey="id"
          numbered
          onRowClick={(r) => setOpenId(r.id)}
          emptyText={
            filter === 'pending'
              ? 'Писем на разбор нет — всё, что пришло с указанным объектом, обработано автоматически'
              : 'Ничего не найдено'
          }
          cardRender={(r) => {
            const hint = reasonHint(r);
            return (
              <Card size="small" style={{ width: '100%' }}>
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Space size={4} wrap>
                    {r.status === 'ingested' ? (
                      <Tag color="green">принято</Tag>
                    ) : r.status === 'rejected' ? (
                      <Tag>отклонено</Tag>
                    ) : (
                      <Tag color={hint.color}>{hint.label}</Tag>
                    )}
                    {r.suggestedSiteCode && <Tag color="blue">{r.suggestedSiteCode}</Tag>}
                  </Space>
                  <Typography.Text strong>{r.subject ?? 'без темы'}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {r.fromAddress ?? '—'} ·{' '}
                    {dayjs(r.receivedAt ?? r.createdAt).format('DD.MM.YYYY HH:mm')}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Файлов в пакет: {r.attachmentsCount} из {r.attachmentsTotal}
                  </Typography.Text>
                </Space>
              </Card>
            );
          }}
          columns={[
            {
              title: 'Получено',
              dataIndex: 'receivedAt',
              width: 140,
              render: (v: string | null, r) =>
                dayjs(v ?? r.createdAt).format('DD.MM.YYYY HH:mm'),
            },
            {
              title: 'От кого',
              dataIndex: 'fromAddress',
              width: 200,
              render: (v: string | null) => v ?? '—',
            },
            {
              title: 'Тема',
              dataIndex: 'subject',
              render: (v: string | null) => v ?? <Typography.Text type="secondary">без темы</Typography.Text>,
            },
            {
              title: 'Файлы',
              dataIndex: 'attachmentsCount',
              width: 90,
              align: 'center',
              render: (v: number, r) =>
                r.attachmentsTotal > v ? (
                  <Tooltip title={`${r.attachmentsTotal - v} вложений отброшено фильтром`}>
                    <span>
                      {v} / {r.attachmentsTotal}
                    </span>
                  </Tooltip>
                ) : (
                  v
                ),
            },
            {
              title: 'Объект',
              dataIndex: 'suggestedSiteCode',
              width: 160,
              render: (v: string | null) =>
                v ? (
                  <Tooltip title="Подсказка по тексту письма — требует подтверждения">
                    <Tag color="blue">{v}</Tag>
                  </Tooltip>
                ) : (
                  <Typography.Text type="secondary">—</Typography.Text>
                ),
            },
            {
              title: 'Статус',
              dataIndex: 'status',
              width: 200,
              render: (_: unknown, r) => {
                if (r.status === 'ingested') return <Tag color="green">принято</Tag>;
                if (r.status === 'rejected') {
                  return (
                    <Tooltip title={r.rejectReason ?? ''}>
                      <Tag>отклонено</Tag>
                    </Tooltip>
                  );
                }
                const hint = reasonHint(r);
                return (
                  <Tooltip title={hint.tip}>
                    <Tag color={hint.color}>{hint.label}</Tag>
                  </Tooltip>
                );
              },
            },
          ]}
        />
      </StickyPageHeader>
      <MailReviewModal messageId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}
