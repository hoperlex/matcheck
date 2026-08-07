import { useState } from 'react';
import { Alert, Button, Input, Modal, Space, Tag, Typography, message } from 'antd';
import { CopyOutlined, LinkOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PasswordResetLink, PasswordResetState, UserDto } from '@matcheck/contracts';
import { api } from '../../services/api';
import { ApiError } from '../../services/api';
import { formatDateRu } from '../../shared/utils/formatRu';

/**
 * Ссылка на смену пароля для конкретного пользователя.
 *
 * Ссылку админ отправляет человеку сам — почтой, в мессенджере, голосом. Она
 * равносильна паролю, поэтому: показывается только по явному действию (в списке
 * пользователей её нет), живёт сутки, гаснет после первого использования и
 * может быть отозвана.
 */
export function PasswordResetLinkModal({
  user,
  state,
  open,
  onClose,
}: {
  user: UserDto;
  state: PasswordResetState | undefined;
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const [link, setLink] = useState<PasswordResetLink | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'password-resets'] });
  };

  const issue = useMutation({
    // Идемпотентно: если живая ссылка уже есть, вернётся она же, а не новая.
    mutationFn: () => api.post<PasswordResetLink>(`/admin/users/${user.id}/password-reset-link`),
    onSuccess: (res) => {
      setLink(res);
      refresh();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const reveal = useMutation({
    mutationFn: (linkId: string) =>
      api.post<PasswordResetLink>(`/admin/password-resets/${linkId}/reveal`),
    onSuccess: setLink,
    onError: (err: Error) => message.error(err.message),
  });

  const rotate = useMutation({
    mutationFn: (linkId: string) =>
      api.post<PasswordResetLink>(`/admin/password-resets/${linkId}/rotate`),
    onSuccess: (res) => {
      setLink(res);
      message.success('Выписана новая ссылка, прежняя больше не работает');
      refresh();
    },
    onError: (err: Error) => {
      // 409 — ссылку уже успел перевыпустить или отозвать кто-то другой.
      // Ошибка тут не нужна: достаточно перечитать состояние.
      if (err instanceof ApiError && err.status === 409) {
        setLink(null);
        refresh();
        message.info('Ссылку уже перевыпустили — обновили состояние');
        return;
      }
      message.error(err.message);
    },
  });

  const revoke = useMutation({
    mutationFn: (linkId: string) =>
      api.post<{ ok: true }>(`/admin/password-resets/${linkId}/revoke`),
    onSuccess: () => {
      setLink(null);
      message.success('Ссылка отозвана');
      refresh();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const closeRequest = useMutation({
    mutationFn: (requestId: string) =>
      api.post<{ ok: true }>(`/admin/password-resets/requests/${requestId}/close`),
    onSuccess: () => {
      message.success('Заявка закрыта');
      refresh();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      message.success('Ссылка скопирована');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      message.error('Не удалось скопировать');
    }
  };

  const hasLink = state?.hasActiveLink === true && state.linkId;

  return (
    <Modal
      open={open}
      onCancel={() => {
        // Ссылку в состоянии не держим: закрыли окно — секрет из памяти ушёл.
        setLink(null);
        onClose();
      }}
      footer={null}
      title={`Смена пароля: ${user.email}`}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {state?.requestedAt ? (
          <Alert
            type="info"
            showIcon
            message={`Пользователь запросил сброс ${formatDateRu(state.requestedAt)}`}
            action={
              state.requestId ? (
                <Button
                  size="small"
                  loading={closeRequest.isPending}
                  onClick={() => closeRequest.mutate(state.requestId!)}
                >
                  Закрыть заявку
                </Button>
              ) : null
            }
          />
        ) : null}

        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          Ссылка действует сутки и гаснет после первой смены пароля. Отправьте её человеку любым
          каналом — по ней он задаст пароль сам. Все его открытые сессии при этом завершатся.
        </Typography.Text>

        {link ? (
          <div
            style={{ border: '1px solid #d9d9d9', borderRadius: 6, padding: 12, background: '#fafafa' }}
          >
            <Space.Compact style={{ width: '100%', marginBottom: 8 }}>
              <Input value={link.url} readOnly />
              <Button type={copied ? 'default' : 'primary'} icon={<CopyOutlined />} onClick={copy}>
                {copied ? 'Скопировано' : 'Скопировать'}
              </Button>
            </Space.Compact>
            <Space wrap size={[8, 4]} style={{ fontSize: 12 }}>
              <Tag color="green" style={{ marginInlineEnd: 0 }}>
                Действует
              </Tag>
              <Typography.Text type="secondary">
                Истекает: {formatDateRu(link.expiresAt)}
              </Typography.Text>
            </Space>
          </div>
        ) : hasLink ? (
          <Button
            icon={<LinkOutlined />}
            loading={reveal.isPending}
            onClick={() => reveal.mutate(state!.linkId!)}
          >
            Показать выданную ссылку
          </Button>
        ) : (
          <Button
            type="primary"
            icon={<LinkOutlined />}
            loading={issue.isPending}
            onClick={() => issue.mutate()}
          >
            Выдать ссылку
          </Button>
        )}

        {hasLink ? (
          <Space wrap>
            <Button
              icon={<ReloadOutlined />}
              loading={rotate.isPending}
              onClick={() => rotate.mutate(state!.linkId!)}
            >
              Выписать новую
            </Button>
            <Button
              danger
              icon={<StopOutlined />}
              loading={revoke.isPending}
              onClick={() => revoke.mutate(state!.linkId!)}
            >
              Отозвать
            </Button>
          </Space>
        ) : null}
      </Space>
    </Modal>
  );
}
