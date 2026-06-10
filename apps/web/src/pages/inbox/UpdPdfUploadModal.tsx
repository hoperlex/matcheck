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
import { InboxOutlined, FilePdfOutlined } from '@ant-design/icons';
import type { UploadFile, UploadProps } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Dayjs } from 'dayjs';
import type {
  ResponsiblePerson,
  SourceDirection,
  UpdPdfQueueResponse,
} from '@matcheck/contracts';
import { api, apiUploadFile, ApiError } from '../../services/api';
import { CustomerCounterpartySelect } from './CustomerCounterpartySelect';
import { ResponsiblePersonSelect } from '../../components/ResponsiblePersonSelect';
import { SiteSelect } from './SiteSelect';

type FileStatus = 'pending' | 'uploading' | 'done' | 'error' | 'duplicate';
type FileRow = {
  uid: string;
  file: File;
  status: FileStatus;
  message?: string;
};

/**
 * Множественная загрузка PDF УПД в очередь распознавания. После выбора
 * контрагента/объекта/направления и файлов модалка отправляет каждый файл
 * отдельным POST на /source-documents/upload-upd-pdf и закрывается, не
 * дожидаясь распознавания. Сами файлы появляются в списке «Документы»
 * со статусом «в очереди» и обновляются по поллингу.
 */
export function UpdPdfUploadModal({
  open,
  direction,
  onClose,
}: {
  open: boolean;
  direction: SourceDirection;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  // Получатель — переключатель: контрагент-подрядчик или МОЛ. Не обязателен,
  // диспетчер может загрузить УПД и без него (потом проставит инспектор).
  const [recipientKind, setRecipientKind] = useState<'counterparty' | 'mol'>(
    'counterparty',
  );
  const [contractorId, setContractorId] = useState<string | null>(null);
  const [recipientMolId, setRecipientMolId] = useState<string | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [expectedDate, setExpectedDate] = useState<Dayjs | null>(null);
  const [rows, setRows] = useState<FileRow[]>([]);
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
    accept: 'application/pdf',
    multiple: true,
    showUploadList: false,
    beforeUpload: (file) => {
      const fileLike = file as unknown as File;
      setRows((prev) => [
        ...prev,
        {
          uid: `${fileLike.name}-${fileLike.size}-${Date.now()}-${Math.random()}`,
          file: fileLike,
          status: 'pending',
        },
      ]);
      // false — Ant Design не пытается грузить сам, мы сделаем это вручную.
      return false;
    },
    fileList: [] as UploadFile[],
  };

  async function startUpload() {
    if (!siteId) return;
    setUploading(true);
    // Каждый файл — независимый POST. Можно слать параллельно, но при 10–20
    // больших PDF параллельные запросы упрутся в API multipart-лимиты;
    // делаем последовательно — это просто, и пользователь сразу видит
    // прогресс по строкам.
    for (const row of rows) {
      if (row.status === 'done' || row.status === 'duplicate') continue;
      setRows((prev) =>
        prev.map((r) => (r.uid === row.uid ? { ...r, status: 'uploading' } : r)),
      );
      try {
        // Получатель опционален: в зависимости от выбора переключателя
        // отправляем либо contractorId, либо recipientMolId, либо ни того
        // ни другого. Multipart требует строки — пустые значения опускаем.
        const recipientFields: Record<string, string> = {};
        if (recipientKind === 'counterparty' && contractorId) {
          recipientFields.contractorId = contractorId;
        } else if (recipientKind === 'mol' && recipientMolId) {
          recipientFields.recipientMolId = recipientMolId;
        }
        const res = await apiUploadFile<UpdPdfQueueResponse>(
          '/source-documents/upload-upd-pdf',
          row.file,
          {
            fields: {
              direction,
              siteId,
              ...recipientFields,
              ...(expectedDate ? { expectedDate: expectedDate.format('YYYY-MM-DD') } : {}),
            },
          },
        );
        setRows((prev) =>
          prev.map((r) =>
            r.uid === row.uid
              ? {
                  ...r,
                  status: res.alreadyExists ? 'duplicate' : 'done',
                  message: res.alreadyExists ? 'Уже загружен' : 'В очереди',
                }
              : r,
          ),
        );
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? err.message || `HTTP ${err.status}`
            : err instanceof Error
              ? err.message
              : String(err);
        setRows((prev) =>
          prev.map((r) => (r.uid === row.uid ? { ...r, status: 'error', message: msg } : r)),
        );
      }
    }
    setUploading(false);
    await qc.invalidateQueries({ queryKey: ['source-documents'] });
    const errored = rows.filter((r) => r.status === 'error').length;
    if (errored === 0) {
      message.success('Все файлы поставлены в очередь');
      // Небольшая задержка чтобы юзер успел увидеть итоговые статусы строк.
      setTimeout(() => close(), 600);
    } else {
      message.warning(`Часть файлов не удалось загрузить: ${errored}`);
    }
  }

  return (
    <Modal
      open={open}
      title={`Загрузить УПД (PDF) для ${direction === 'inbound' ? 'приёмки' : 'отгрузки'}`}
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
            {rows.length > 0
              ? `Загрузить ${rows.length} ${pluralFiles(rows.length)}`
              : 'Загрузить'}
          </Button>
        </Space>
      }
      width={720}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="Распознавание идёт в фоне — окно закроется сразу после загрузки."
        description="Документы появятся в списке со статусом «в очереди» и обновятся автоматически по мере обработки."
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
        <Form.Item label="Файлы PDF" required>
          <Upload.Dragger {...uploadProps} disabled={uploading}>
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">Перетащите PDF-файлы или нажмите для выбора</p>
            <p className="ant-upload-hint">
              Можно выбрать сразу несколько файлов. Лимит на файл — 10 МБ.
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
                <Tag color={statusColor(r.status)} key="status">
                  {statusLabel(r.status)}
                </Tag>,
                !uploading && r.status !== 'done' && r.status !== 'duplicate' ? (
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
                avatar={<FilePdfOutlined style={{ fontSize: 20 }} />}
                title={r.file.name}
                description={
                  <Typography.Text type={r.status === 'error' ? 'danger' : undefined}>
                    {r.message ?? formatSize(r.file.size)}
                  </Typography.Text>
                }
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

function statusColor(s: FileStatus): string {
  switch (s) {
    case 'pending':
      return 'default';
    case 'uploading':
      return 'processing';
    case 'done':
      return 'green';
    case 'duplicate':
      return 'gold';
    case 'error':
      return 'red';
  }
}

function statusLabel(s: FileStatus): string {
  switch (s) {
    case 'pending':
      return 'ожидание';
    case 'uploading':
      return 'отправка…';
    case 'done':
      return 'в очереди';
    case 'duplicate':
      return 'дубликат';
    case 'error':
      return 'ошибка';
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(2)} МБ`;
}
