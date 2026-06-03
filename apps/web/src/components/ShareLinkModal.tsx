import { useState } from 'react';
import {
  Alert,
  Button,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import { CopyOutlined, LinkOutlined, StopOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ShareEntityType, ShareLink } from '@matcheck/contracts';
import { api, ApiError } from '../services/api';
import { formatDateRu } from '../shared/utils/formatRu';

type ListResp = { items: ShareLink[] };

/**
 * Модалка «Поделиться» — генерация и управление публичными ссылками на
 * приёмку/отгрузку. UX:
 *  - При открытии тянем список существующих ссылок (активные + истёкшие).
 *  - Кнопка «Сгенерировать» создаёт новую или возвращает уже активную
 *    (сервер делает дедуп по entityId — повторный клик не плодит токены).
 *  - Для каждой активной ссылки — кнопка «Скопировать» и «Отозвать».
 *  - Истёкшие/отозванные показаны в списке для аудита, но без действий.
 *
 * Безопасность: ссылка отображается в чистом виде один раз — пользователь
 * должен скопировать. Audit-данные (кто открывал, сколько раз) видны
 * автору ссылки.
 */
export function ShareLinkModal({
  entityType,
  entityId,
  open,
  onClose,
  title,
}: {
  entityType: ShareEntityType;
  entityId: string | null;
  open: boolean;
  onClose: () => void;
  title?: string;
}) {
  const qc = useQueryClient();

  const list = useQuery({
    queryKey: ['share-links', entityType, entityId],
    queryFn: () =>
      api.get<ListResp>(
        `/share-links?entityType=${entityType}&entityId=${entityId}`,
      ),
    enabled: open && entityId !== null,
  });

  const create = useMutation<ShareLink, Error, void>({
    mutationFn: () =>
      api.post<ShareLink>(`/${entityType === 'delivery' ? 'deliveries' : 'shipments'}/${entityId}/share-link`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['share-links', entityType, entityId] });
    },
    onError: (err) =>
      message.error(err instanceof ApiError ? err.message : 'Не удалось создать ссылку'),
  });

  const revoke = useMutation<ShareLink, Error, string>({
    mutationFn: (id) => api.post<ShareLink>(`/share-links/${id}/revoke`),
    onSuccess: () => {
      message.success('Ссылка отозвана');
      void qc.invalidateQueries({ queryKey: ['share-links', entityType, entityId] });
    },
    onError: (err) =>
      message.error(err instanceof ApiError ? err.message : 'Не удалось отозвать'),
  });

  const items = list.data?.items ?? [];
  const now = Date.now();
  const activeLinks = items.filter(
    (i) => !i.revokedAt && new Date(i.expiresAt).getTime() > now,
  );
  const inactiveLinks = items.filter(
    (i) => i.revokedAt || new Date(i.expiresAt).getTime() <= now,
  );

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={title ?? 'Поделиться ссылкой'}
      footer={null}
      width={560}
      destroyOnClose
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="Ссылка живёт 10 дней. Получатель видит фото и материалы read-only, без доступа в систему. Можно отозвать в любой момент."
      />

      {list.isLoading ? (
        <Spin />
      ) : (
        <>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {activeLinks.length === 0 && (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="Активных ссылок нет"
              >
                <Button
                  type="primary"
                  icon={<LinkOutlined />}
                  loading={create.isPending}
                  onClick={() => create.mutate()}
                >
                  Сгенерировать ссылку
                </Button>
              </Empty>
            )}

            {activeLinks.map((link) => (
              <ActiveLinkRow
                key={link.id}
                link={link}
                onRevoke={() => revoke.mutate(link.id)}
                revoking={revoke.isPending && revoke.variables === link.id}
              />
            ))}

            {activeLinks.length > 0 && (
              <Button
                icon={<LinkOutlined />}
                loading={create.isPending}
                onClick={() => create.mutate()}
              >
                Создать ещё одну ссылку
              </Button>
            )}

            {inactiveLinks.length > 0 && (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  История ({inactiveLinks.length})
                </Typography.Text>
                {inactiveLinks.slice(0, 5).map((link) => (
                  <InactiveLinkRow key={link.id} link={link} />
                ))}
              </>
            )}
          </Space>
        </>
      )}
    </Modal>
  );
}

function ActiveLinkRow({
  link,
  onRevoke,
  revoking,
}: {
  link: ShareLink;
  onRevoke: () => void;
  revoking: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      message.success('Ссылка скопирована');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      message.error('Не удалось скопировать');
    }
  };
  return (
    <div
      style={{
        border: '1px solid #d9d9d9',
        borderRadius: 6,
        padding: 12,
        background: '#fafafa',
      }}
    >
      <Space.Compact style={{ width: '100%', marginBottom: 8 }}>
        <Input value={link.url} readOnly />
        <Button
          type={copied ? 'default' : 'primary'}
          icon={<CopyOutlined />}
          onClick={copy}
        >
          {copied ? 'Скопировано' : 'Скопировать'}
        </Button>
      </Space.Compact>
      <Space wrap size={[8, 4]} style={{ fontSize: 12 }}>
        <Tag color="green" style={{ marginInlineEnd: 0 }}>
          Активна
        </Tag>
        <Typography.Text type="secondary">
          Истекает: {formatDateRu(link.expiresAt)}
        </Typography.Text>
        <Typography.Text type="secondary">
          Открыто:{' '}
          {link.accessedCount > 0
            ? `${link.accessedCount} ${link.lastAccessedAt ? `· последний раз ${formatDateRu(link.lastAccessedAt)}` : ''}`
            : '0 раз'}
        </Typography.Text>
        <Popconfirm
          title="Отозвать ссылку?"
          description="После отзыва получатель сразу потеряет доступ. Действие необратимо."
          okText="Отозвать"
          cancelText="Отмена"
          okButtonProps={{ danger: true, loading: revoking }}
          onConfirm={onRevoke}
        >
          <Button danger size="small" icon={<StopOutlined />}>
            Отозвать
          </Button>
        </Popconfirm>
      </Space>
    </div>
  );
}

function InactiveLinkRow({ link }: { link: ShareLink }) {
  const isRevoked = link.revokedAt !== null;
  return (
    <div
      style={{
        border: '1px solid #f0f0f0',
        borderRadius: 6,
        padding: 8,
        opacity: 0.6,
      }}
    >
      <Space size={[8, 4]} wrap style={{ fontSize: 12 }}>
        <Tag color="default" style={{ marginInlineEnd: 0 }}>
          {isRevoked ? 'Отозвана' : 'Истекла'}
        </Tag>
        <Typography.Text type="secondary">
          {isRevoked && link.revokedAt
            ? `Отозвана ${formatDateRu(link.revokedAt)}`
            : `Истекла ${formatDateRu(link.expiresAt)}`}
        </Typography.Text>
        {link.accessedCount > 0 && (
          <Typography.Text type="secondary">
            Открывалась {link.accessedCount} раз
          </Typography.Text>
        )}
      </Space>
    </div>
  );
}
