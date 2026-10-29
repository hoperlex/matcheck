import { Button, Popconfirm, Space, Tooltip, Typography, message } from 'antd';
import { CheckSquareOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { usePermissions } from '../hooks/usePermissions';
import { formatDateRu } from '../utils/formatRu';

/**
 * Отметка «Диспетчер» у приёмки — рядом с «Проверено». Те же право (`review`)
 * и гейт зрелости, что у отметки проверки, но она независима от неё и
 * снимается: кнопка одна, и случайное нажатие должно быть обратимым.
 */

// Симметрично гейту на бэке (PATCH /deliveries/:id/dispatcher-check).
const MATURE = new Set(['filled', 'confirmed_mol']);

export function DispatcherCheckControl({
  id,
  statusCode,
  checkedAt,
  checkedByUserEmail,
  pendingDeletion,
}: {
  id: string;
  statusCode: string;
  checkedAt: string | null | undefined;
  checkedByUserEmail: string | null | undefined;
  pendingDeletion: boolean;
}) {
  const { can } = usePermissions();
  const canManage = can('operations.deliveries', 'review');
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: (checked: boolean) =>
      api.patch<unknown>(`/deliveries/${id}/dispatcher-check`, { checked }),
    onSuccess: (_data, checked) => {
      message.success(checked ? 'Отметка диспетчера поставлена' : 'Отметка диспетчера снята');
      void qc.invalidateQueries({ queryKey: ['deliveries'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  // Поля отметки в DTO пустые у ролей без права — показывать нечего.
  if (!canManage) return null;

  const checked = !!checkedAt;
  const disabled = !MATURE.has(statusCode) || pendingDeletion || mutation.isPending;
  const tooltip = pendingDeletion
    ? 'Документ помечен на удаление — отметка недоступна'
    : !MATURE.has(statusCode)
      ? 'Отметка доступна только для оформленных записей'
      : '';

  const button = (
    <Button
      size="small"
      type={checked ? 'primary' : 'default'}
      icon={<CheckSquareOutlined />}
      disabled={disabled}
      loading={mutation.isPending}
      onClick={checked ? undefined : () => mutation.mutate(true)}
    >
      Диспетчер
    </Button>
  );

  return (
    <Space size={8} align="center">
      <Tooltip title={tooltip}>
        {checked && !disabled ? (
          <Popconfirm
            title="Снять отметку диспетчера?"
            okText="Снять"
            cancelText="Отмена"
            onConfirm={() => mutation.mutate(false)}
          >
            {button}
          </Popconfirm>
        ) : (
          <span>{button}</span>
        )}
      </Tooltip>
      {checkedAt ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {`${formatDateRu(checkedAt)} ${new Date(checkedAt).toTimeString().slice(0, 5)}`}
          {checkedByUserEmail ? ` · ${checkedByUserEmail}` : ''}
        </Typography.Text>
      ) : (
        <Typography.Text type="secondary">диспетчер не отметил</Typography.Text>
      )}
    </Space>
  );
}
