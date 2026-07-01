import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Drawer,
  Empty,
  Input,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import { SendOutlined, LinkOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type {
  ManagerShareMessageCreateResponse,
  ShareMessage,
  ShareMessageThreadDetailResponse,
} from '@matcheck/contracts';
import { api } from '../services/api';
import { formatDateRu } from '../shared/utils/formatRu';

/**
 * Drawer чата по share-ссылке. Открывается из NotificationsBell.
 * Polling каждые 15 сек чтобы видеть новые сообщения. На mount —
 * /mark-read (открытие чата = подтверждение прочтения предыдущих).
 */
export function ShareThreadDrawer({
  tokenId,
  open,
  onClose,
}: {
  tokenId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const markedRef = useRef<string | null>(null);

  const detail = useQuery({
    queryKey: ['share-messages', 'thread', tokenId],
    queryFn: () =>
      api.get<ShareMessageThreadDetailResponse>(`/share-messages/threads/${tokenId}`),
    enabled: open && !!tokenId,
    // Открытый Drawer = активный разговор — опрашиваем каждые 3 сек, чтобы
    // сообщение внешнего пользователя долетало почти мгновенно.
    refetchInterval: open && !!tokenId ? 3_000 : false,
    refetchOnWindowFocus: true,
  });

  const markRead = useMutation({
    mutationFn: () => api.post(`/share-messages/threads/${tokenId}/mark-read`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['share-messages', 'unread-count'] });
      void qc.invalidateQueries({ queryKey: ['share-messages', 'threads'] });
    },
  });

  // Помечаем все external-сообщения прочитанными ровно один раз при открытии
  // на конкретный tokenId. Защита от повторов через ref — иначе useEffect
  // на меняющемся detail-объекте мог бы стрелять каждые 15 сек.
  useEffect(() => {
    if (!open || !tokenId) {
      markedRef.current = null;
      return;
    }
    if (markedRef.current === tokenId) return;
    markedRef.current = tokenId;
    markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tokenId]);

  // Скролл вниз при появлении новых сообщений (чат-стандарт).
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [detail.data?.messages.length]);

  const send = useMutation<
    ManagerShareMessageCreateResponse,
    Error,
    string,
    { prev: ShareMessageThreadDetailResponse | undefined }
  >({
    mutationFn: (body: string) =>
      api.post<ManagerShareMessageCreateResponse>(
        `/share-messages/threads/${tokenId}`,
        { body },
      ),
    // Optimistic update — менеджер видит свой bubble мгновенно, без
    // ожидания HTTP-ответа. На onError откатываем.
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: ['share-messages', 'thread', tokenId] });
      const prev = qc.getQueryData<ShareMessageThreadDetailResponse>([
        'share-messages',
        'thread',
        tokenId,
      ]);
      if (prev) {
        const draftMsg: ShareMessage = {
          id: `temp-${Date.now()}`,
          senderType: 'manager',
          senderName: 'Вы',
          senderEmail: null,
          body,
          createdAt: new Date().toISOString(),
          isRead: true,
        };
        qc.setQueryData<ShareMessageThreadDetailResponse>(
          ['share-messages', 'thread', tokenId],
          { ...prev, messages: [...prev.messages, draftMsg] },
        );
      }
      setDraft('');
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) {
        qc.setQueryData(['share-messages', 'thread', tokenId], ctx.prev);
      }
      message.error(err.message);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['share-messages', 'thread', tokenId] });
      void qc.invalidateQueries({ queryKey: ['share-messages', 'unread-count'] });
      void qc.invalidateQueries({ queryKey: ['share-messages', 'threads'] });
    },
  });

  const thread = detail.data?.thread;
  const messages = useMemo(() => detail.data?.messages ?? [], [detail.data]);
  const isTokenInactive =
    thread?.tokenRevokedAt !== null && thread?.tokenRevokedAt !== undefined
      ? true
      : thread?.tokenExpiresAt
        ? new Date(thread.tokenExpiresAt).getTime() <= Date.now()
        : false;

  const openInOperations = () => {
    if (!thread) return;
    const url =
      thread.entityType === 'delivery'
        ? `/operations?type=delivery&delivery=${thread.entityId}&from=accepted`
        : `/operations?type=shipment&shipment=${thread.entityId}&from=list`;
    onClose();
    navigate(url);
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={
        thread ? (
          <Space size={6} wrap>
            <Typography.Text strong>{thread.entityLabel}</Typography.Text>
            {isTokenInactive && (
              <Tag color="default">
                {thread.tokenRevokedAt ? 'Ссылка отозвана' : 'Ссылка истекла'}
              </Tag>
            )}
          </Space>
        ) : (
          'Сообщения'
        )
      }
      width="min(560px, 95vw)"
      destroyOnClose
      footer={
        <div style={{ display: 'flex', gap: 8 }}>
          <Input.TextArea
            placeholder={
              isTokenInactive
                ? 'Ссылка неактивна — ответ не дойдёт'
                : 'Ваш ответ внешнему получателю…'
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoSize={{ minRows: 2, maxRows: 6 }}
            maxLength={4000}
            disabled={isTokenInactive || send.isPending}
            onPressEnter={(e) => {
              if (e.shiftKey) return;
              e.preventDefault();
              if (draft.trim()) send.mutate(draft.trim());
            }}
          />
          <Button
            type="primary"
            icon={<SendOutlined />}
            loading={send.isPending}
            disabled={isTokenInactive || !draft.trim()}
            onClick={() => send.mutate(draft.trim())}
          >
            Отправить
          </Button>
        </div>
      }
      extra={
        thread ? (
          <Button size="small" icon={<LinkOutlined />} onClick={openInOperations}>
            Открыть в Операциях
          </Button>
        ) : null
      }
      styles={{ body: { padding: 12 } }}
    >
      {isTokenInactive && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message={
            thread?.tokenRevokedAt
              ? 'Ссылка отозвана — внешний пользователь не видит чат и не получит ваш ответ.'
              : 'Срок действия ссылки истёк — внешний пользователь не видит чат.'
          }
        />
      )}
      {detail.isLoading && (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
        </div>
      )}
      {!detail.isLoading && messages.length === 0 && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Пока сообщений нет"
          style={{ marginTop: 24 }}
        />
      )}
      <div
        ref={scrollRef}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          maxHeight: 'calc(100vh - 280px)',
          overflowY: 'auto',
          paddingRight: 4,
        }}
      >
        {messages.map((m) => (
          <Bubble key={m.id} m={m} />
        ))}
      </div>
    </Drawer>
  );
}

function Bubble({ m }: { m: ShareMessage }) {
  const isManager = m.senderType === 'manager';
  // Менеджер — справа (синий пузырь), внешний — слева (серый).
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isManager ? 'flex-end' : 'flex-start',
      }}
    >
      <div
        style={{
          maxWidth: '78%',
          background: isManager ? '#e6f4ff' : '#fafafa',
          border: '1px solid #f0f0f0',
          borderRadius: 8,
          padding: '6px 10px',
        }}
      >
        <div style={{ display: 'flex', gap: 8, fontSize: 11, color: '#8c8c8c' }}>
          <span style={{ fontWeight: 600 }}>
            {m.senderName ?? (isManager ? 'Менеджер' : 'Гость')}
          </span>
          <span>{formatDateRu(m.createdAt)}</span>
        </div>
        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 2 }}>
          {m.body}
        </div>
        {!isManager && m.senderEmail && (
          <div style={{ fontSize: 11, color: '#8c8c8c', marginTop: 2 }}>
            <a href={`mailto:${encodeURIComponent(m.senderEmail)}`}>{m.senderEmail}</a>
          </div>
        )}
      </div>
    </div>
  );
}
