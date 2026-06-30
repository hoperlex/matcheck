import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  DatePicker,
  Form,
  List,
  Modal,
  Segmented,
  Space,
  Spin,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import {
  InboxOutlined,
  FileTextOutlined,
  CheckCircleTwoTone,
  CloseCircleTwoTone,
  LoadingOutlined,
} from '@ant-design/icons';
import type { UploadFile, UploadProps } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Dayjs } from 'dayjs';
import type { SourceDirection, ImportItem, ImportResult } from '@matcheck/contracts';
import { apiUploadDocuments, apiGetImportResult, ApiError } from '../../services/api';
import { CustomerCounterpartySelect } from './CustomerCounterpartySelect';
import { ResponsiblePersonSelect } from '../../components/ResponsiblePersonSelect';
import { SiteSelect } from './SiteSelect';

type FileRow = { uid: string; file: File };

/**
 * Единый вход «Загрузить документы» (рядом со старыми точечными кнопками).
 * Юзер кидает ПАЧКУ любых файлов (PDF/Excel/фото), они уходят одним POST на
 * /upload-documents — система сама классифицирует каждый файл и роутит в
 * существующие парсеры (УПД / накладные / vision для сканов и фото).
 *
 * Двухстадийное окно:
 *  1) «Форма» — выбор получателя/объекта/даты + перетаскивание файлов.
 *  2) «Результат» — после загрузки окно НЕ закрывается, а показывает живую
 *     сводку по пачке (poll import-result): сколько файлов принято на
 *     распознавание и по какому маршруту, что не удалось. Так менеджер видит,
 *     что процесс идёт и где искать документы (они появляются в списке
 *     «Документы» по строке на файл и распознаются в фоне). Это закрывает
 *     жалобу «загрузил — и непонятно, где документы / часть пропала».
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
  // bundleId !== null → стадия «Результат».
  const [bundleId, setBundleId] = useState<string | null>(null);

  // Poll журнала решений по пачке, пока классификация не завершилась.
  const resultQuery = useQuery({
    queryKey: ['import-result', bundleId],
    queryFn: () => apiGetImportResult(bundleId!),
    enabled: !!bundleId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'parsed' || s === 'parse_failed' ? false : 1500;
    },
  });

  // Когда классификация пачки завершилась — обновляем список «Документы», чтобы
  // созданные строки (по одной на файл) сразу появились. Дальнейшее доведение
  // до «обработано» делает штатный polling таблицы.
  const bundleStatus = resultQuery.data?.status;
  useEffect(() => {
    if (bundleStatus === 'parsed' || bundleStatus === 'parse_failed') {
      void qc.invalidateQueries({ queryKey: ['source-documents'] });
    }
  }, [bundleStatus, qc]);

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

  // «Загрузить ещё»: сбрасываем файлы и результат, но сохраняем получателя/
  // объект/дату — обычно следующая пачка идёт на тот же объект.
  function uploadMore() {
    setRows([]);
    setBundleId(null);
  }

  const canUpload = !!siteId && rows.length > 0 && !uploading;
  const inResult = bundleId !== null;
  const result = resultQuery.data;
  const inProgress =
    inResult && (!result || (result.status !== 'parsed' && result.status !== 'parse_failed'));

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
      // Сразу же обновим список (появится техническая строка пакета), а дальше
      // переключаемся на стадию «Результат» с поллингом журнала.
      await qc.invalidateQueries({ queryKey: ['source-documents'] });
      setUploading(false);
      setBundleId(res.bundleId);
      if (res.alreadyExists) {
        message.info('Этот набор файлов уже загружали — показываю результат.');
      }
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
        inResult ? (
          <Space>
            <Button onClick={uploadMore} disabled={inProgress}>
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
      width={720}
    >
      {inResult ? (
        <ImportResultPanel inProgress={inProgress} result={result} />
      ) : (
        <>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="Один вход для любых документов: УПД, накладные, Excel, фото."
            description="Система сама определит тип каждого файла. На каждый файл появится отдельная строка в списке «Документы» — она пройдёт статусы «в очереди» → «распознаётся» → «обработано». Сканы и фото распознаются по изображению."
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

/**
 * Панель результата пачки: пока классификация идёт — спиннер; когда готово —
 * сводка + список файлов с понятным исходом. Источник истины о судьбе пачки
 * (в т.ч. о файлах, не давших данных) — журнал bundle_import_items.
 */
function ImportResultPanel({
  inProgress,
  result,
}: {
  inProgress: boolean;
  result: ImportResult | undefined;
}) {
  if (inProgress || !result) {
    return (
      <div style={{ padding: '24px 0', textAlign: 'center' }}>
        <Spin indicator={<LoadingOutlined style={{ fontSize: 28 }} spin />} />
        <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
          Раскладываем пачку по типам и отправляем на распознавание…
        </Typography.Paragraph>
      </div>
    );
  }

  const { summary, items } = result;
  return (
    <>
      <Space size="small" wrap style={{ marginBottom: 12 }}>
        <Tag color="default">Файлов: {items.length}</Tag>
        <Tag color="green">Принято на распознавание: {summary.created}</Tag>
        {summary.failed > 0 && <Tag color="red">Ошибок: {summary.failed}</Tag>}
      </Space>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="Документы появились в списке «Документы»"
        description="Каждый файл — отдельная строка. Сейчас они распознаются в фоне: статус сменится с «в очереди»/«распознаётся» на «обработано». Окно можно закрыть."
      />
      <List
        size="small"
        bordered
        dataSource={items}
        renderItem={(it: ImportItem) => (
          <List.Item>
            <List.Item.Meta
              avatar={statusIcon(it.status)}
              title={it.sourceFilename}
              description={it.reason ?? statusLabel(it.status)}
            />
          </List.Item>
        )}
      />
    </>
  );
}

function statusIcon(status: string) {
  if (status === 'failed') return <CloseCircleTwoTone twoToneColor="#ff4d4f" style={{ fontSize: 18 }} />;
  return <CheckCircleTwoTone twoToneColor="#52c41a" style={{ fontSize: 18 }} />;
}

function statusLabel(status: string): string {
  switch (status) {
    case 'created':
      return 'Принято на распознавание';
    case 'failed':
      return 'Не удалось обработать файл';
    case 'needs_review':
      return 'Требует ручной проверки';
    default:
      return status;
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
