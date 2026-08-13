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
  message,
} from 'antd';
import {
  CheckCircleTwoTone,
  CloseCircleTwoTone,
  ExclamationCircleTwoTone,
  FileTextOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Dayjs } from 'dayjs';
import type { SourceDirection, ImportItem, ImportResult } from '@matcheck/contracts';
import { apiUploadDocuments, apiGetImportResult, ApiError } from '../../services/api';
import { CustomerCounterpartySelect } from './CustomerCounterpartySelect';
import { ResponsiblePersonSelect } from '../../components/ResponsiblePersonSelect';
import { SiteSelect } from './SiteSelect';
import { FileDropList, pluralFiles, type FileRow } from './upload/FileDropList';

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
const UPLOAD_ACCEPT =
  'application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,image/jpeg,image/png,image/webp,.pdf,.xlsx,.xls,.jpg,.jpeg,.png,.webp';

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
  // Вторая зона: файлы, которые нужно только сохранить. Отдельное состояние, а
  // не флаг на строке, — так режим виден человеку в самой форме.
  const [extraRows, setExtraRows] = useState<FileRow[]>([]);
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
    setExtraRows([]);
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
    setExtraRows([]);
    setBundleId(null);
  }

  // Лимиты сервер считает по ВСЕМУ запросу, поэтому и здесь зоны складываются.
  const totalCount = rows.length + extraRows.length;
  const canUpload = !!siteId && totalCount > 0 && !uploading;
  const inResult = bundleId !== null;
  const result = resultQuery.data;
  const inProgress =
    inResult && (!result || (result.status !== 'parsed' && result.status !== 'parse_failed'));

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
        undefined,
        extraRows.map((r) => r.file),
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
              {totalCount > 0 ? `Загрузить ${totalCount} ${pluralFiles(totalCount)}` : 'Загрузить'}
            </Button>
          </Space>
        )
      }
      width="min(720px, 92vw)"
      centered
      // Ограничиваем высоту модалки под ~85vh: тело (форма + список файлов)
      // скроллится ВНУТРИ, а footer с кнопкой «Загрузить N файлов» вынесен из
      // тела и остаётся виден всегда — не нужно скроллить страницу к кнопке,
      // даже когда добавлено много файлов.
      styles={{ body: { maxHeight: '72vh', overflowY: 'auto' } }}
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
            <Form.Item label="УПД и накладные" required>
              <FileDropList
                rows={rows}
                onChange={setRows}
                disabled={uploading}
                accept={UPLOAD_ACCEPT}
                title="Перетащите УПД и накладные либо нажмите для выбора"
                hint="УПД, накладные, Excel, фото — вперемешку. Можно сразу несколько. Лимит на файл — 10 МБ."
                otherZone={extraRows}
              />
            </Form.Item>
            <Form.Item
              label="Дополнительные документы"
              extra="Сертификаты, паспорта качества, спецификации, акты и другие файлы. Они сохранятся без распознавания и будут видны в карточке поставки."
            >
              <FileDropList
                rows={extraRows}
                onChange={setExtraRows}
                disabled={uploading}
                accept={UPLOAD_ACCEPT}
                title="Перетащите дополнительные документы либо нажмите для выбора"
                hint="Эти файлы не распознаются — система просто сохранит их вместе с поставкой."
                otherZone={rows}
              />
            </Form.Item>
          </Form>
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
        {summary.created > 0 && <Tag color="green">Принято на распознавание: {summary.created}</Tag>}
        {summary.skipped > 0 && <Tag color="blue">Сохранено без распознавания: {summary.skipped}</Tag>}
        {summary.failed > 0 && <Tag color="red">Ошибок: {summary.failed}</Tag>}
      </Space>
      {/* Текст строится по сводке: у пачки без распознанных документов прежнее
          «документы появились в списке» было прямой неправдой. */}
      {summary.created > 0 ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Документы появились в списке «Документы»"
          description={
            summary.skipped > 0
              ? 'Каждый распознаваемый файл — отдельная строка; статус сменится с «в очереди»/«распознаётся» на «обработано». Остальные файлы сохранены как дополнительные и видны в карточке поставки. Окно можно закрыть.'
              : 'Каждый файл — отдельная строка. Сейчас они распознаются в фоне: статус сменится с «в очереди»/«распознаётся» на «обработано». Окно можно закрыть.'
          }
        />
      ) : (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Файлы сохранены, документов из них не создано"
          description="Распознавать эти файлы не требовалось — они лежат вместе с поставкой. Найти их можно в разделе «Комплекты без документов», а если в этой поставке появится УПД или накладная — и в её карточке."
        />
      )}
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
  // Файл, требующий ручной проверки, зелёной галкой помечать нельзя: с ним ещё
  // предстоит работа.
  if (status === 'needs_review') {
    return <ExclamationCircleTwoTone twoToneColor="#faad14" style={{ fontSize: 18 }} />;
  }
  if (status === 'skipped') return <FileTextOutlined style={{ fontSize: 18, color: '#1677ff' }} />;
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
    case 'skipped':
      return 'Сохранено без распознавания';
    default:
      return status;
  }
}
