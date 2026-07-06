import { useState } from 'react';
import { Button, Input, Modal, Space, Tag, Tooltip, Typography, message } from 'antd';
import { CheckCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { formatDateRu } from '../utils/formatRu';

/**
 * Отметка проверки качества (роль «Мониторинг»). Ортогональна операционному
 * статусу приёмки/отгрузки. Ставить/менять могут только admin/manager/monitor;
 * для прочих ролей review-поля вообще не приходят в DTO (null), а сам компонент
 * не рендерит управляющих элементов.
 */

const MANAGEMENT_ROLES = new Set(['admin', 'manager', 'monitor']);

// Статусы, при которых доступна проверка (оформленные записи). Симметрично
// гейту зрелости на бэке (routes/deliveries.ts, shipments.ts).
const MATURE_DELIVERY = new Set(['filled', 'confirmed_mol']);
const MATURE_SHIPMENT = new Set(['shipped', 'confirmed_mol']);

export type ReviewStateValue = 'approved' | 'issues' | null | undefined;

/** Компактный бейдж отметки проверки — в строке списка и в шапке карточки. */
export function ReviewBadge({ state }: { state: ReviewStateValue }) {
  if (state === 'approved') {
    return (
      <Tag color="green" icon={<CheckCircleOutlined />} style={{ marginInlineEnd: 0 }}>
        Проверено
      </Tag>
    );
  }
  if (state === 'issues') {
    return (
      <Tag color="red" icon={<WarningOutlined />} style={{ marginInlineEnd: 0 }}>
        Есть замечания
      </Tag>
    );
  }
  return null;
}

export function ReviewControls({
  entityType,
  id,
  statusCode,
  reviewState,
  reviewNote,
  reviewedByUserEmail,
  reviewedAt,
  updatedAt,
  pendingDeletion,
}: {
  entityType: 'delivery' | 'shipment';
  id: string;
  statusCode: string;
  reviewState: ReviewStateValue;
  reviewNote: string | null | undefined;
  reviewedByUserEmail: string | null | undefined;
  reviewedAt: string | null | undefined;
  updatedAt: string;
  pendingDeletion: boolean;
}) {
  const role = useAuthStore((s) => s.user?.role);
  const canManage = role != null && MANAGEMENT_ROLES.has(role);
  const qc = useQueryClient();
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [note, setNote] = useState('');

  const listKey = entityType === 'delivery' ? 'deliveries' : 'shipments';
  const path = `/${listKey}/${id}/review`;

  const mutation = useMutation({
    mutationFn: (body: { state: 'approved' | 'issues'; note?: string }) =>
      api.patch<unknown>(path, body),
    onSuccess: () => {
      message.success('Отметка проверки сохранена');
      // Список операций перечитается (там же обновятся бейджи). SSE тоже
      // разошлёт delivery_updated/shipment_updated — но локальная
      // инвалидация быстрее для того, кто поставил отметку.
      void qc.invalidateQueries({ queryKey: [listKey] });
      setIssuesOpen(false);
      setNote('');
    },
    onError: (err: Error) => message.error(err.message),
  });

  // Компонент управляющих элементов виден только менеджменту. Для прочих ролей
  // review-поля в DTO пустые, так что и показывать нечего.
  if (!canManage) return null;

  const mature =
    entityType === 'delivery' ? MATURE_DELIVERY.has(statusCode) : MATURE_SHIPMENT.has(statusCode);
  const disabled = !mature || pendingDeletion || mutation.isPending;
  const stale =
    !!reviewState &&
    !!reviewedAt &&
    new Date(updatedAt).getTime() > new Date(reviewedAt).getTime();

  const tooltip = pendingDeletion
    ? 'Документ помечен на удаление — проверка недоступна'
    : !mature
      ? 'Проверка доступна только для оформленных записей'
      : '';

  return (
    <div>
      <Space wrap size={8} align="center">
        <Typography.Text strong>Проверка:</Typography.Text>
        {reviewState ? (
          <ReviewBadge state={reviewState} />
        ) : (
          <Typography.Text type="secondary">не проверено</Typography.Text>
        )}
        {reviewedAt ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {`${formatDateRu(reviewedAt)} ${new Date(reviewedAt).toTimeString().slice(0, 5)}`}
            {reviewedByUserEmail ? ` · ${reviewedByUserEmail}` : ''}
          </Typography.Text>
        ) : null}
        <Tooltip title={tooltip}>
          <Button
            size="small"
            type={reviewState === 'approved' ? 'primary' : 'default'}
            icon={<CheckCircleOutlined />}
            disabled={disabled}
            loading={mutation.isPending}
            onClick={() => mutation.mutate({ state: 'approved' })}
          >
            Проверено
          </Button>
        </Tooltip>
        <Tooltip title={tooltip}>
          <Button
            size="small"
            danger
            icon={<WarningOutlined />}
            disabled={disabled}
            onClick={() => {
              setNote(reviewState === 'issues' ? (reviewNote ?? '') : '');
              setIssuesOpen(true);
            }}
          >
            Есть замечания
          </Button>
        </Tooltip>
      </Space>
      {reviewState === 'issues' && reviewNote ? (
        <div style={{ marginTop: 4 }}>
          <Typography.Text type="danger">Замечание: {reviewNote}</Typography.Text>
        </div>
      ) : null}
      {stale ? (
        <div style={{ marginTop: 4 }}>
          <Typography.Text type="warning">
            ⚠ Изменено после проверки — требуется перепроверка
          </Typography.Text>
        </div>
      ) : null}
      <Modal
        open={issuesOpen}
        title="Замечания по проверке"
        okText="Сохранить замечание"
        okButtonProps={{ danger: true, disabled: note.trim().length === 0 }}
        confirmLoading={mutation.isPending}
        onOk={() => mutation.mutate({ state: 'issues', note: note.trim() })}
        onCancel={() => setIssuesOpen(false)}
        destroyOnClose
      >
        <Input.TextArea
          rows={4}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
          showCount
          placeholder="Что не так: качество фото, материалы, суммы…"
        />
      </Modal>
    </div>
  );
}
