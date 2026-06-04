import { useState } from 'react';
import { Badge, Button, Empty, List, Popover, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { BellOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type {
  ShareMessageThreadListResponse,
  ShareMessageThreadSummary,
  ShareMessageUnreadCountResponse,
} from '@matcheck/contracts';
import { api } from '../services/api';
import { useAuthStore } from '../stores/auth';
import { formatDateRu } from '../shared/utils/formatRu';
import { ShareThreadDrawer } from './ShareThreadDrawer';

/**
 * Иконка-колокольчик в шапке портала. Badge — число непрочитанных
 * сообщений от внешних пользователей по share-ссылкам, владелец которых
 * = текущий юзер (или все — для admin). Клик → Popover со списком тредов;
 * клик по треду → Drawer чата.
 *
 * Доступна только admin/manager (inspector_kpp не пользуется share).
 */
export function NotificationsBell({ collapsed = false }: { collapsed?: boolean }) {
  const role = useAuthStore((s) => s.user?.role);
  const enabled = role === 'admin' || role === 'manager';
  const [open, setOpen] = useState(false);
  const [drawerTokenId, setDrawerTokenId] = useState<string | null>(null);

  const unread = useQuery({
    queryKey: ['share-messages', 'unread-count'],
    queryFn: () =>
      api.get<ShareMessageUnreadCountResponse>('/share-messages/unread-count'),
    enabled,
    // 10 секунд — компромисс «вижу новое сообщение почти сразу» / «не
    // нагружаю бэк». Лёгкий запрос (один COUNT с partial-index), нагрузка
    // ничтожна. Refetch при возврате фокуса — мгновенное обновление,
    // когда менеджер возвращается к вкладке.
    refetchInterval: enabled ? 10_000 : false,
    refetchOnWindowFocus: true,
  });

  const threads = useQuery({
    queryKey: ['share-messages', 'threads'],
    queryFn: () =>
      api.get<ShareMessageThreadListResponse>('/share-messages/threads'),
    enabled: enabled && open,
  });

  if (!enabled) return null;

  const count = unread.data?.count ?? 0;

  const content = (
    <div style={{ width: 360, maxWidth: '90vw' }}>
      {threads.isLoading ? (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      ) : threads.data?.items.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Нет сообщений"
          style={{ margin: '16px 0' }}
        />
      ) : (
        <List<ShareMessageThreadSummary>
          dataSource={threads.data?.items ?? []}
          renderItem={(t) => (
            <List.Item
              style={{ cursor: 'pointer', padding: '8px 4px' }}
              onClick={() => {
                setOpen(false);
                setDrawerTokenId(t.tokenId);
              }}
            >
              <div style={{ width: '100%' }}>
                <Space
                  size={4}
                  style={{ width: '100%', justifyContent: 'space-between' }}
                  wrap
                >
                  <Typography.Text strong>{t.entityLabel}</Typography.Text>
                  {t.unreadCount > 0 && <Tag color="blue">{t.unreadCount}</Tag>}
                </Space>
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 12, display: 'block' }}
                >
                  {t.lastSenderName}: {t.lastBodyPreview}
                </Typography.Text>
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 11, display: 'block' }}
                >
                  {formatDateRu(t.lastMessageAt)}
                  {t.tokenRevokedAt
                    ? ' · ссылка отозвана'
                    : new Date(t.tokenExpiresAt).getTime() <= Date.now()
                      ? ' · ссылка истекла'
                      : ''}
                </Typography.Text>
              </div>
            </List.Item>
          )}
        />
      )}
    </div>
  );

  const bellButton = (
    <Tooltip title="Сообщения" placement={collapsed ? 'right' : 'top'}>
      <Badge count={count} overflowCount={99} size="small">
        <Button
          shape="circle"
          icon={<BellOutlined />}
          size={collapsed ? 'small' : 'middle'}
        />
      </Badge>
    </Tooltip>
  );

  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger="click"
        placement="topRight"
        title="Сообщения по share-ссылкам"
        content={content}
        destroyTooltipOnHide
      >
        {bellButton}
      </Popover>
      <ShareThreadDrawer
        tokenId={drawerTokenId}
        open={drawerTokenId !== null}
        onClose={() => setDrawerTokenId(null)}
      />
    </>
  );
}
