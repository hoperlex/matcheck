import { useMemo, useState } from 'react';
import { Alert, Button, Descriptions, Modal, Space, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SourceDocumentDetail } from '@matcheck/contracts';
import { api, ApiError } from '../../services/api';

type DuplicateDetails = {
  existingId?: string;
  supplierName?: string | null;
  docNumber?: string | null;
  docDate?: string | null;
};

/**
 * Диалог разрешения дубликата УПД. Открывается из списка «Документы» по
 * кнопке «Разрешить» на строке со статусом needs_resolution +
 * parseErrorCode='duplicate_upd'. Даёт две опции — skip (удалить только
 * что загруженный дубль) или replace (удалить старый и до-распознать новый).
 */
export function UpdResolveDuplicateModal({
  id,
  open,
  onClose,
}: {
  id: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [action, setAction] = useState<'skip' | 'replace' | null>(null);

  const detail = useQuery({
    queryKey: ['source-document', id],
    queryFn: () => api.get<SourceDocumentDetail>(`/source-documents/${id}`),
    enabled: !!id && open,
  });

  const details = useMemo<DuplicateDetails | null>(() => {
    const d = detail.data?.parseErrorDetails;
    if (!d || typeof d !== 'object') return null;
    return d as DuplicateDetails;
  }, [detail.data]);

  const resolve = useMutation({
    mutationFn: (a: 'skip' | 'replace') =>
      api.post<{ ok: true } | SourceDocumentDetail>(
        `/source-documents/${id}/resolve-duplicate`,
        { action: a },
      ),
    onSuccess: async () => {
      message.success(action === 'skip' ? 'Дубликат удалён' : 'Старый документ заменён');
      await qc.invalidateQueries({ queryKey: ['source-documents'] });
      setAction(null);
      onClose();
    },
    onError: (err: Error) => {
      if (err instanceof ApiError && err.code === 'has_references') {
        message.error(err.message);
        return;
      }
      message.error(err instanceof Error ? err.message : String(err));
    },
  });

  return (
    <Modal
      open={open}
      title="Дубликат УПД"
      onCancel={() => {
        if (!resolve.isPending) onClose();
      }}
      footer={null}
      width={560}
      maskClosable={false}
      keyboard={false}
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="В системе уже есть УПД с теми же реквизитами"
        description="Выберите, что сделать с этим документом."
      />
      <Descriptions size="small" column={1} bordered style={{ marginBottom: 16 }}>
        <Descriptions.Item label="Поставщик">{details?.supplierName ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="№ документа">{details?.docNumber ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Дата">{details?.docDate ?? '—'}</Descriptions.Item>
      </Descriptions>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Button
          danger
          block
          loading={resolve.isPending && action === 'skip'}
          disabled={resolve.isPending}
          onClick={() => {
            setAction('skip');
            resolve.mutate('skip');
          }}
        >
          Пропустить (удалить новый дубликат)
        </Button>
        <Button
          type="primary"
          block
          loading={resolve.isPending && action === 'replace'}
          disabled={resolve.isPending || !details?.existingId}
          onClick={() => {
            setAction('replace');
            resolve.mutate('replace');
          }}
        >
          Заменить (удалить старый, оставить новый)
        </Button>
      </Space>
    </Modal>
  );
}
