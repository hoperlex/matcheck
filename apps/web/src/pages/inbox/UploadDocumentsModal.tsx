import { useState } from 'react';
import {
  Alert,
  Button,
  DatePicker,
  Form,
  List,
  Modal,
  Result,
  Segmented,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import { InboxOutlined, FileTextOutlined } from '@ant-design/icons';
import type { UploadFile, UploadProps } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Dayjs } from 'dayjs';
import type { SourceDirection, ImportItem } from '@matcheck/contracts';
import { apiUploadDocuments, apiGetImportResult, ApiError } from '../../services/api';
import { CustomerCounterpartySelect } from './CustomerCounterpartySelect';
import { ResponsiblePersonSelect } from '../../components/ResponsiblePersonSelect';
import { SiteSelect } from './SiteSelect';

type FileRow = { uid: string; file: File };

/**
 * Единый вход «Загрузить документы» (экспериментальный, переходный режим рядом
 * со старыми точечными кнопками). Юзер кидает ПАЧКУ любых файлов (PDF/Excel/
 * фото), они уходят одним POST на /upload-documents. Дальше система сама
 * классифицирует каждый файл и роутит в существующие парсеры, а модалка
 * показывает ЖУРНАЛ решений: что определено, чем обработано, что создано,
 * что ушло на ручную проверку. Данные не портятся: неуверенные файлы —
 * needs_review, без создания операционных документов.
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
  // null — стадия выбора файлов; иначе — стадия результата по bundleId.
  const [bundleId, setBundleId] = useState<string | null>(null);

  // Поллинг журнала решений, пока пакет обрабатывается router'ом.
  const resultQuery = useQuery({
    queryKey: ['import-result', bundleId],
    queryFn: () => apiGetImportResult(bundleId!),
    enabled: !!bundleId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'parsed' || s === 'parse_failed' ? false : 2000;
    },
  });

  function reset() {
    setRecipientKind('counterparty');
    setContractorId(null);
    setRecipientMolId(null);
    setSiteId(null);
    setExpectedDate(null);
    setRows([]);
    setUploading(false);
    setBundleId(null);
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
      const res = await apiUploadDocuments(
        rows.map((r) => r.file),
        {
          direction,
          siteId,
          ...recipientFields,
          ...(expectedDate ? { expectedDate: expectedDate.format('YYYY-MM-DD') } : {}),
        },
      );
      setBundleId(res.bundleId);
      // Список документов обновляем — созданные router'ом записи там появятся.
      await qc.invalidateQueries({ queryKey: ['source-documents'] });
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message || `HTTP ${err.status}`
          : err instanceof Error
            ? err.message
            : String(err);
      message.error(`Не удалось загрузить: ${msg}`);
    }
    setUploading(false);
  }

  const result = resultQuery.data;
  const inProgress = !!bundleId && result?.status !== 'parsed' && result?.status !== 'parse_failed';

  return (
    <Modal
      open={open}
      title="Загрузить документы"
      onCancel={close}
      maskClosable={false}
      keyboard={false}
      closable={!uploading}
      footer={
        bundleId ? (
          <Space>
            <Button
              onClick={() => {
                // «Загрузить ещё» — сбрасываем на стадию выбора, сохраняя объект.
                setRows([]);
                setBundleId(null);
              }}
              disabled={inProgress}
            >
              Загрузить ещё
            </Button>
            <Button type="primary" onClick={close} disabled={inProgress}>
              Готово
            </Button>
          </Space>
        ) : (
          <Space>
            <Button onClick={close} disabled={uploading}>
              {uploading ? 'Загрузка…' : 'Закрыть'}
            </Button>
            <Button type="primary" disabled={!canUpload} loading={uploading} onClick={startUpload}>
              {rows.length > 0 ? `Загрузить ${rows.length} ${pluralFiles(rows.length)}` : 'Загрузить'}
            </Button>
          </Space>
        )
      }
      width={760}
    >
      {bundleId ? (
        <ImportResultView
          items={result?.items ?? []}
          summary={result?.summary ?? { created: 0, needsReview: 0, failed: 0 }}
          inProgress={inProgress}
        />
      ) : (
        <>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="Один вход для любых документов: УПД, накладные, Excel, фото."
            description="Система сама определит тип каждого файла и покажет, что создано, а что отправлено на ручную проверку. Старые кнопки «Загрузить УПД» и «Загрузить накладные» остаются как точные инструменты."
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
        </>
      )}
    </Modal>
  );
}

// ──────────── Панель результата импорта (журнал решений) ────────────

function ImportResultView({
  items,
  summary,
  inProgress,
}: {
  items: ImportItem[];
  summary: { created: number; needsReview: number; failed: number };
  inProgress: boolean;
}) {
  if (items.length === 0) {
    return (
      <Result
        icon={<FileTextOutlined />}
        title={inProgress ? 'Распознаём пачку…' : 'Пакет обработан'}
        subTitle={
          inProgress
            ? 'Система классифицирует файлы и направляет их в нужные парсеры — это займёт несколько секунд.'
            : 'Журнал решений появится здесь.'
        }
      />
    );
  }
  return (
    <>
      <Space style={{ marginBottom: 12 }} wrap>
        <Typography.Text strong>Результат импорта:</Typography.Text>
        <Tag color="green">создано: {summary.created}</Tag>
        <Tag color="gold">на проверку: {summary.needsReview}</Tag>
        {summary.failed > 0 && <Tag color="red">ошибок: {summary.failed}</Tag>}
        {inProgress && <Tag color="processing">обрабатывается…</Tag>}
      </Space>
      <Table<ImportItem>
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={items}
        columns={[
          {
            title: 'Файл',
            dataIndex: 'sourceFilename',
            ellipsis: true,
          },
          {
            title: 'Тип',
            dataIndex: 'detectedKind',
            width: 130,
            render: (k: string | null) => <Tag color={kindColor(k)}>{kindLabel(k)}</Tag>,
          },
          {
            title: 'Статус',
            dataIndex: 'status',
            width: 130,
            render: (s: string) => <Tag color={statusColor(s)}>{statusLabel(s)}</Tag>,
          },
          {
            title: 'Решение',
            dataIndex: 'reason',
            ellipsis: true,
            render: (r: string | null) => (
              <Typography.Text type="secondary">{r ?? '—'}</Typography.Text>
            ),
          },
        ]}
      />
    </>
  );
}

function kindLabel(k: string | null): string {
  switch (k) {
    case 'upd':
      return 'УПД';
    case 'transport_waybill':
      return 'Накладная';
    case 'os2_transfer':
      return 'ОС-2';
    case 'm15':
      return 'М-15';
    default:
      return 'Не определено';
  }
}
function kindColor(k: string | null): string {
  switch (k) {
    case 'upd':
      return 'blue';
    case 'transport_waybill':
    case 'os2_transfer':
      return 'purple';
    case 'm15':
      return 'gold';
    default:
      return 'default';
  }
}
function statusLabel(s: string): string {
  switch (s) {
    case 'created':
      return 'создан';
    case 'needs_review':
      return 'на проверку';
    case 'failed':
      return 'ошибка';
    case 'skipped':
      return 'пропущен';
    default:
      return s;
  }
}
function statusColor(s: string): string {
  switch (s) {
    case 'created':
      return 'green';
    case 'needs_review':
      return 'gold';
    case 'failed':
      return 'red';
    default:
      return 'default';
  }
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
