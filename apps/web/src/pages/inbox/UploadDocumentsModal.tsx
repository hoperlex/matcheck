import { useState } from 'react';
import {
  Alert,
  Button,
  DatePicker,
  Form,
  List,
  Modal,
  Segmented,
  Space,
  Typography,
  Upload,
  message,
} from 'antd';
import { InboxOutlined, FileTextOutlined } from '@ant-design/icons';
import type { UploadFile, UploadProps } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import type { Dayjs } from 'dayjs';
import type { SourceDirection } from '@matcheck/contracts';
import { apiUploadDocuments, ApiError } from '../../services/api';
import { CustomerCounterpartySelect } from './CustomerCounterpartySelect';
import { ResponsiblePersonSelect } from '../../components/ResponsiblePersonSelect';
import { SiteSelect } from './SiteSelect';

type FileRow = { uid: string; file: File };

/**
 * Единый вход «Загрузить документы» (экспериментальный, рядом со старыми
 * точечными кнопками). Юзер кидает ПАЧКУ любых файлов (PDF/Excel/фото), они
 * уходят одним POST на /upload-documents — система сама классифицирует каждый
 * файл и роутит в существующие парсеры. Поведение как у «Загрузить УПД» /
 * «Загрузить накладные»: после загрузки окно само закрывается, документы
 * появляются в списке со статусом «в очереди» и обновляются по поллингу.
 * Файлы, в типе которых система не уверена (фото/сканы/М-15), не создают
 * операционных документов — данные не портятся.
 */
export function UploadDocumentsModal({
  open,
  direction,
  onClose,
}: {
  open: boolean;
  direction: SourceDirection;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [recipientKind, setRecipientKind] = useState<'counterparty' | 'mol'>('counterparty');
  const [contractorId, setContractorId] = useState<string | null>(null);
  const [recipientMolId, setRecipientMolId] = useState<string | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [expectedDate, setExpectedDate] = useState<Dayjs | null>(null);
  const [rows, setRows] = useState<FileRow[]>([]);
  const [uploading, setUploading] = useState(false);

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
    accept:
      'application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,image/jpeg,image/png,image/webp,.pdf,.xlsx,.xls,.jpg,.jpeg,.png,.webp',
    multiple: true,
    showUploadList: false,
    beforeUpload: (file) => {
      const fileLike = file as unknown as File;
      setRows((prev) => [
        ...prev,
        { uid: `${fileLike.name}-${fileLike.size}-${Date.now()}-${Math.random()}`, file: fileLike },
      ]);
      return false;
    },
    fileList: [] as UploadFile[],
  };

  async function startUpload() {
    if (!siteId) return;
    setUploading(true);
    try {
      const recipientFields: Record<string, string> = {};
      if (recipientKind === 'counterparty' && contractorId) {
        recipientFields.contractorId = contractorId;
      } else if (recipientKind === 'mol' && recipientMolId) {
        recipientFields.recipientMolId = recipientMolId;
      }
      await apiUploadDocuments(
        rows.map((r) => r.file),
        {
          direction,
          siteId,
          ...recipientFields,
          ...(expectedDate ? { expectedDate: expectedDate.format('YYYY-MM-DD') } : {}),
        },
      );
      await qc.invalidateQueries({ queryKey: ['source-documents'] });
      setUploading(false);
      message.success('Документы загружены — распознавание идёт в фоне');
      // Небольшая задержка, как у «Загрузить УПД»: окно само закрывается.
      setTimeout(() => close(), 600);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message || `HTTP ${err.status}`
          : err instanceof Error
            ? err.message
            : String(err);
      message.error(`Не удалось загрузить: ${msg}`);
      setUploading(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Загрузить документы"
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
            {rows.length > 0 ? `Загрузить ${rows.length} ${pluralFiles(rows.length)}` : 'Загрузить'}
          </Button>
        </Space>
      }
      width={720}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="Один вход для любых документов: УПД, накладные, Excel, фото."
        description="Система сама определит тип каждого файла. Окно закроется сразу после загрузки — документы появятся в списке «Документы» и обновятся по мере распознавания. Файлы, тип которых не определён уверенно (фото/сканы), в данные не записываются."
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
            <CustomerCounterpartySelect
              value={contractorId}
              onChange={setContractorId}
              disabled={uploading}
              placeholder="Выберите получателя"
            />
          ) : (
            <ResponsiblePersonSelect
              value={recipientMolId}
              onChange={setRecipientMolId}
              placeholder="Выберите получателя"
              disabled={uploading}
              source="fot"
            />
          )}
        </Form.Item>
        <Form.Item label="Объект" required>
          <SiteSelect value={siteId} onChange={setSiteId} disabled={uploading} />
        </Form.Item>
        <Form.Item
          label="Дата поставки"
          extra="Необязательное поле. Применяется ко всем загружаемым файлам."
        >
          <DatePicker
            value={expectedDate}
            onChange={setExpectedDate}
            format="YYYY-MM-DD"
            disabled={uploading}
            style={{ width: '100%' }}
          />
        </Form.Item>
        <Form.Item label="Файлы (PDF / Excel / фото)" required>
          <Upload.Dragger {...uploadProps} disabled={uploading}>
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">
              Перетащите любые документы поставки либо нажмите для выбора
            </p>
            <p className="ant-upload-hint">
              УПД, накладные, Excel, фото — вперемешку. Можно сразу несколько. Лимит на файл — 10 МБ.
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
                ) : null,
              ]}
            >
              <List.Item.Meta
                avatar={<FileTextOutlined style={{ fontSize: 20 }} />}
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

function pluralFiles(n: number): string {
  const last = n % 10;
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'файлов';
  if (last === 1) return 'файл';
  if (last >= 2 && last <= 4) return 'файла';
  return 'файлов';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(2)} МБ`;
}
