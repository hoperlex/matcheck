import { useState } from 'react';
import { Alert, Button, Modal, Space, Spin, Typography, Upload, message } from 'antd';
import type { UploadProps } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import type { SourceDirection, UpdDuplicateExisting } from '@matcheck/contracts';
import { api, ApiError } from '../../services/api';
import { ContractorSelect } from './ContractorSelect';

type Stage = 'select' | 'uploading' | 'conflict';

function readDuplicateExisting(err: unknown): UpdDuplicateExisting | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== 'duplicate_upd') {
    return null;
  }
  const payload = err.payload as { existing?: UpdDuplicateExisting } | null;
  return payload?.existing ?? null;
}

export function UpdXmlUploadModal({
  open,
  direction,
  onClose,
}: {
  open: boolean;
  direction: SourceDirection;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [contractorId, setContractorId] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('select');
  const [pendingXml, setPendingXml] = useState<string | null>(null);
  const [conflict, setConflict] = useState<UpdDuplicateExisting | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setContractorId(null);
    setStage('select');
    setPendingXml(null);
    setConflict(null);
    setError(null);
  }

  function close() {
    reset();
    onClose();
  }

  async function send(xml: string, replaceExistingId?: string): Promise<void> {
    if (!contractorId) {
      message.warning('Сначала выберите подрядчика');
      return;
    }
    setError(null);
    setStage('uploading');
    try {
      await api.post('/source-documents/upload-upd', {
        xml,
        direction,
        contractorId,
        ...(replaceExistingId ? { replaceExistingId } : {}),
      });
      message.success(replaceExistingId ? 'УПД заменён' : 'УПД загружен');
      void qc.invalidateQueries({ queryKey: ['source-documents'] });
      close();
    } catch (err) {
      const existing = readDuplicateExisting(err);
      if (existing) {
        setPendingXml(xml);
        setConflict(existing);
        setStage('conflict');
        return;
      }
      if (err instanceof ApiError && err.code === 'has_references') {
        message.error(err.message);
        setStage('select');
        return;
      }
      const msg = err instanceof ApiError ? err.message : 'Не удалось загрузить XML';
      setError(msg);
      setStage('select');
    }
  }

  const uploadProps: UploadProps = {
    accept: '.xml',
    maxCount: 1,
    showUploadList: false,
    disabled: !contractorId || stage === 'uploading',
    beforeUpload: async (file) => {
      if (!contractorId) {
        message.warning('Сначала выберите подрядчика');
        return false;
      }
      const f = file as unknown as File;
      const xml = await f.text();
      await send(xml);
      return false;
    },
  };

  const replaceExisting = () => {
    if (conflict && pendingXml) void send(pendingXml, conflict.id);
  };

  let footer: React.ReactNode = null;
  if (stage === 'conflict') {
    footer = [
      <Button key="skip" onClick={close}>
        Пропустить
      </Button>,
      <Button key="replace" type="primary" danger onClick={replaceExisting}>
        Заменить существующий
      </Button>,
    ];
  }

  return (
    <Modal
      open={open}
      onCancel={close}
      title="Загрузка УПД (XML)"
      footer={footer}
      destroyOnClose
    >
      {error && (
        <Alert type="error" message={error} showIcon style={{ marginBottom: 12 }} closable />
      )}

      {(stage === 'select' || stage === 'uploading') && (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Typography.Text strong>Подрядчик</Typography.Text>
            <div style={{ marginTop: 4 }}>
              <ContractorSelect
                value={contractorId}
                onChange={setContractorId}
                disabled={stage === 'uploading'}
              />
            </div>
          </div>
          <Upload.Dragger {...uploadProps}>
            <p style={{ fontSize: 16, marginBottom: 8 }}>
              {stage === 'uploading' ? (
                <Spin />
              ) : (
                'Перетащите XML сюда или кликните для выбора'
              )}
            </p>
            <Typography.Text type="secondary">
              {contractorId
                ? 'XML формата УПД (электронный документ из ЭДО).'
                : 'Сначала выберите подрядчика выше.'}
            </Typography.Text>
          </Upload.Dragger>
        </Space>
      )}

      {stage === 'conflict' && conflict && (
        <Alert
          type="warning"
          showIcon
          message="Такой УПД уже загружен"
          description={
            <Space direction="vertical" size={2}>
              <Typography.Text>
                № <b>{conflict.docNumber ?? '— без номера —'}</b>
                {conflict.docDate ? ` от ${conflict.docDate}` : ''}
              </Typography.Text>
              {conflict.totalSum ? (
                <Typography.Text type="secondary">Сумма: {conflict.totalSum} ₽</Typography.Text>
              ) : null}
              <Typography.Text type="secondary">
                Загружен: {new Date(conflict.createdAt).toLocaleString()}
              </Typography.Text>
              <Typography.Text style={{ marginTop: 8 }}>
                «Заменить» удалит старый документ и загрузит новый.
                Если старый уже привязан к приёмке/отгрузке — заменить не получится,
                сначала отвяжите его.
              </Typography.Text>
            </Space>
          }
        />
      )}
    </Modal>
  );
}
