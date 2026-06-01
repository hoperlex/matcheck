import { useState } from 'react';
import {
  Alert,
  Button,
  DatePicker,
  Form,
  List,
  Modal,
  Segmented,
  Select,
  Space,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import { InboxOutlined, FileImageOutlined } from '@ant-design/icons';
import type { UploadFile, UploadProps } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Dayjs } from 'dayjs';
import type {
  ResponsiblePerson,
  SourceDirection,
  UpdPdfQueueResponse,
} from '@matcheck/contracts';
import { api, apiUploadFiles, ApiError } from '../../services/api';
import { ContractorSelect } from './ContractorSelect';
import { SiteSelect } from './SiteSelect';

type Row = {
  uid: string;
  file: File;
};

/**
 * Загрузка пакета файлов для распознавания накладных — ТН (форма 2116) и
 * ОС-2 (внутреннее перемещение основных средств). LLM на сервере сама
 * классифицирует каждый файл и возвращает массив документов. Один пакет
 * фото может породить N source_documents разных форм — например ТН + ОС-2
 * из одной пачки. Паспорта качества, рукописные накладные и прочие
 * документы игнорируются.
 */
export function WaybillUploadModal({
  open,
  direction,
  onClose,
}: {
  open: boolean;
  direction: SourceDirection;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [recipientKind, setRecipientKind] = useState<'counterparty' | 'mol'>(
    'counterparty',
  );
  const [contractorId, setContractorId] = useState<string | null>(null);
  const [recipientMolId, setRecipientMolId] = useState<string | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [expectedDate, setExpectedDate] = useState<Dayjs | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [uploading, setUploading] = useState(false);

  const responsiblePersonsQuery = useQuery({
    queryKey: ['responsible-persons', 'active'],
    queryFn: () =>
      api.get<{ items: ResponsiblePerson[]; total: number }>(
        '/responsible-persons?activeOnly=true&limit=500',
      ),
  });
  const responsiblePersons = responsiblePersonsQuery.data?.items ?? [];

  function reset() {
    setRecipientKind('counterparty');
    setContractorId(null);
    setRecipientMolId(null);
    setSiteId(null);
    setExpectedDate(null);
    setRows([]);
    setUploading(false);
  }

  function close() {
    if (uploading) return;
    reset();
    onClose();
  }

  const canUpload = !!siteId && rows.length > 0 && !uploading;

  const uploadProps: UploadProps = {
    // Принимаем JPG/PNG/WEBP/HEIC/PDF — vision-LLM работает со всеми. Один
    // пакет может содержать смесь форматов (например 2 фото + 1 PDF).
    accept: 'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf',
    multiple: true,
    showUploadList: false,
    beforeUpload: (file) => {
      const fileLike = file as unknown as File;
      setRows((prev) => [
        ...prev,
        {
          uid: `${fileLike.name}-${fileLike.size}-${Date.now()}-${Math.random()}`,
          file: fileLike,
        },
      ]);
      return false;
    },
    fileList: [] as UploadFile[],
  };

  async function startUpload() {
    if (!siteId || rows.length === 0) return;
    setUploading(true);
    try {
      const recipientFields: Record<string, string> = {};
      if (recipientKind === 'counterparty' && contractorId) {
        recipientFields.contractorId = contractorId;
      } else if (recipientKind === 'mol' && recipientMolId) {
        recipientFields.recipientMolId = recipientMolId;
      }
      const res = await apiUploadFiles<UpdPdfQueueResponse>(
        '/source-documents/upload-waybill',
        rows.map((r) => r.file),
        {
          fields: {
            direction,
            siteId,
            ...recipientFields,
            ...(expectedDate ? { expectedDate: expectedDate.format('YYYY-MM-DD') } : {}),
          },
        },
      );
      if (res.alreadyExists) {
        message.info('Этот пакет уже был загружен ранее');
      } else {
        message.success('Пакет поставлен в очередь распознавания');
      }
      await qc.invalidateQueries({ queryKey: ['source-documents'] });
      close();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message || `HTTP ${err.status}`
          : err instanceof Error
            ? err.message
            : String(err);
      message.error(`Не удалось загрузить пакет: ${msg}`);
    } finally {
      setUploading(false);
    }
  }

  return (
    <Modal
      open={open}
      title={`Загрузить накладную для ${direction === 'inbound' ? 'приёмки' : 'отгрузки'}`}
      onCancel={close}
      maskClosable={false}
      keyboard={false}
      closable={!uploading}
      footer={
        <Space>
          <Button onClick={close} disabled={uploading}>
            {uploading ? 'Загрузка…' : 'Закрыть'}
          </Button>
          <Button type="primary" disabled={!canUpload} loading={uploading} onClick={startUpload}>
            {rows.length > 0 ? `Распознать (${rows.length})` : 'Распознать'}
          </Button>
        </Space>
      }
      width={720}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="Один пакет фото может содержать несколько накладных — каждая попадёт в Ожидаемые отдельной строкой."
        description="Распознаются печатные ТН (форма 2116) и накладные ОС-2 (внутреннее перемещение основных средств). Паспорта качества, рукописные накладные и прочие документы игнорируются. Поддерживаются JPG/PNG/WEBP/HEIC; PDF работает только при default-провайдере Google AI Studio."
      />
      <Form layout="vertical">
        <Form.Item label="Получатель">
          <Segmented
            block
            style={{ marginBottom: 8 }}
            value={recipientKind}
            onChange={(v) => {
              const next = v as 'counterparty' | 'mol';
              setRecipientKind(next);
              if (next === 'counterparty') setRecipientMolId(null);
              else setContractorId(null);
            }}
            options={[
              { label: 'Подрядчик', value: 'counterparty' },
              { label: 'МОЛ', value: 'mol' },
            ]}
            disabled={uploading}
          />
          {recipientKind === 'counterparty' ? (
            <ContractorSelect
              value={contractorId}
              onChange={setContractorId}
              disabled={uploading}
              placeholder="Выберите получателя"
            />
          ) : (
            <Select<string>
              style={{ width: '100%' }}
              placeholder="Выберите получателя"
              value={recipientMolId ?? undefined}
              onChange={(v) => setRecipientMolId(v ?? null)}
              allowClear
              showSearch
              optionFilterProp="label"
              loading={responsiblePersonsQuery.isLoading}
              disabled={uploading}
              options={responsiblePersons.map((m) => ({
                value: m.id,
                label: m.fullName,
              }))}
              notFoundContent={
                <Typography.Text type="secondary">
                  Заведите МОЛ в Справочниках
                </Typography.Text>
              }
            />
          )}
        </Form.Item>
        <Form.Item label="Объект" required>
          <SiteSelect value={siteId} onChange={setSiteId} disabled={uploading} />
        </Form.Item>
        <Form.Item label="Дата поставки" extra="Необязательное поле.">
          <DatePicker
            value={expectedDate}
            onChange={setExpectedDate}
            format="YYYY-MM-DD"
            disabled={uploading}
            style={{ width: '100%' }}
          />
        </Form.Item>
        <Form.Item label="Файлы (JPG/PNG/PDF)" required>
          <Upload.Dragger {...uploadProps} disabled={uploading}>
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">Перетащите фото или нажмите для выбора</p>
            <p className="ant-upload-hint">
              В пакете может быть несколько накладных. Лимит на файл — 10 МБ.
            </p>
          </Upload.Dragger>
        </Form.Item>
      </Form>

      {rows.length > 0 && (
        <List
          size="small"
          bordered
          dataSource={rows}
          renderItem={(r) => (
            <List.Item
              actions={[
                !uploading ? (
                  <Button
                    type="link"
                    size="small"
                    key="remove"
                    onClick={() => setRows((prev) => prev.filter((x) => x.uid !== r.uid))}
                  >
                    Убрать
                  </Button>
                ) : (
                  <Tag color="processing" key="status">
                    отправка…
                  </Tag>
                ),
              ]}
            >
              <List.Item.Meta
                avatar={<FileImageOutlined style={{ fontSize: 20 }} />}
                title={r.file.name}
                description={formatSize(r.file.size)}
              />
            </List.Item>
          )}
        />
      )}
    </Modal>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(2)} МБ`;
}
