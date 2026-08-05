import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  DatePicker,
  Form,
  Input,
  Modal,
  Result,
  Space,
  Tag,
  Typography,
  message,
} from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { Dayjs } from 'dayjs';
import { FileDropList, pluralFiles, type FileRow } from '../inbox/upload/FileDropList';
import { PublicSiteSelect } from './PublicSiteSelect';
import {
  PublicApiError,
  publicGetUploadStatus,
  publicUploadDocuments,
} from '../../services/publicApi';

const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// Держим ниже nginx client_max_body_size: иначе он оборвёт запрос сам и
// ответит HTML-страницей, которую наша обработка ошибок увидит как «сервис
// недоступен» вместо понятного «слишком большой объём».
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const ACCEPT =
  'application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,' +
  'image/jpeg,image/png,image/webp,image/heic,.pdf,.xlsx,.jpg,.jpeg,.png,.webp,.heic';

/** Анкету помним на время вкладки: телефон в localStorage без спроса не кладём. */
const CONTACT_KEY = 'matcheck.publicUpload.contact';

type Contact = { name: string; phone: string };

function loadContact(): Contact {
  try {
    const raw = sessionStorage.getItem(CONTACT_KEY);
    if (!raw) return { name: '', phone: '' };
    const parsed = JSON.parse(raw) as Partial<Contact>;
    return { name: parsed.name ?? '', phone: parsed.phone ?? '' };
  } catch {
    return { name: '', phone: '' };
  }
}

export function PublicUploadModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [siteId, setSiteId] = useState<string | null>(null);
  const [expectedDate, setExpectedDate] = useState<Dayjs | null>(null);
  const [contact, setContact] = useState<Contact>(() => loadContact());
  const [rows, setRows] = useState<FileRow[]>([]);
  // Honeypot: поле есть в DOM, но невидимо и не попадает в обход по Tab —
  // человек его не заполнит, а простой бот, проходящий по всем input, заполнит.
  const [honeypot, setHoneypot] = useState('');
  const [uploading, setUploading] = useState(false);
  const [ticket, setTicket] = useState<string | null>(null);
  const [rejected, setRejected] = useState<Array<{ filename: string; reason: string }>>([]);
  // Поллинг статуса не бесконечный: распознавание идёт минутами, держать
  // человека у экрана незачем.
  const [pollingUntil, setPollingUntil] = useState<number>(0);

  const statusQuery = useQuery({
    queryKey: ['public-upload-status', ticket],
    queryFn: () => publicGetUploadStatus(ticket!),
    enabled: !!ticket,
    refetchInterval: (q) => {
      if (Date.now() > pollingUntil) return false;
      return q.state.data?.status === 'processing' ? 2000 : false;
    },
    retry: false,
  });

  useEffect(() => {
    if (!open) return;
    setContact(loadContact());
  }, [open]);

  const totalBytes = rows.reduce((sum, r) => sum + r.file.size, 0);
  const tooManyFiles = rows.length > MAX_FILES;
  const oversized = rows.find((r) => r.file.size > MAX_FILE_BYTES);
  const totalTooBig = totalBytes > MAX_TOTAL_BYTES;
  const canSubmit =
    !!siteId &&
    !!expectedDate &&
    contact.name.trim().length >= 2 &&
    contact.phone.trim().length >= 5 &&
    rows.length > 0 &&
    !tooManyFiles &&
    !oversized &&
    !totalTooBig &&
    !uploading;

  function resetAll() {
    setSiteId(null);
    setExpectedDate(null);
    setRows([]);
    setTicket(null);
    setRejected([]);
    setUploading(false);
  }

  function close() {
    if (uploading) return;
    resetAll();
    onClose();
  }

  /** Следующая пачка обычно идёт на тот же объект и от того же человека. */
  function uploadMore() {
    setRows([]);
    setTicket(null);
    setRejected([]);
  }

  async function submit() {
    if (!siteId || !expectedDate) return;
    setUploading(true);
    try {
      const res = await publicUploadDocuments(
        rows.map((r) => r.file),
        {
          siteId,
          expectedDate: expectedDate.format('YYYY-MM-DD'),
          submitterName: contact.name.trim(),
          submitterPhone: contact.phone.trim(),
          website: honeypot,
        },
      );
      try {
        sessionStorage.setItem(CONTACT_KEY, JSON.stringify(contact));
      } catch {
        // Приватный режим браузера — не повод ронять отправку.
      }
      setTicket(res.ticket);
      setRejected(res.filesRejected);
      setPollingUntil(Date.now() + 60_000);
    } catch (err) {
      message.error(
        err instanceof PublicApiError
          ? err.message
          : 'Не удалось отправить документы. Проверьте связь и попробуйте ещё раз.',
      );
    } finally {
      setUploading(false);
    }
  }

  const sent = ticket !== null;

  return (
    <Modal
      open={open}
      title="Загрузка документов на приёмку"
      onCancel={close}
      maskClosable={false}
      keyboard={false}
      closable={!uploading}
      width="min(720px, 92vw)"
      centered
      styles={{ body: { maxHeight: '72vh', overflowY: 'auto' } }}
      footer={
        sent ? (
          <Space>
            <Button onClick={uploadMore}>Отправить ещё</Button>
            <Button type="primary" onClick={close}>
              Готово
            </Button>
          </Space>
        ) : (
          <Space>
            <Button onClick={close} disabled={uploading}>
              Отмена
            </Button>
            <Button type="primary" disabled={!canSubmit} loading={uploading} onClick={submit}>
              {rows.length > 0
                ? `Отправить ${rows.length} ${pluralFiles(rows.length)}`
                : 'Отправить'}
            </Button>
          </Space>
        )
      }
    >
      {sent ? (
        <>
          <Result
            status="success"
            title="Документы приняты"
            subTitle={
              <>
                Мы передали их на обработку. Номер обращения:{' '}
                <Typography.Text strong copyable>
                  {ticket}
                </Typography.Text>
                . Если что-то не удастся прочитать, менеджер свяжется с вами.
              </>
            }
          />
          {statusQuery.data && (
            <Space size="small" wrap style={{ marginBottom: 12 }}>
              <Tag color="green">Принято файлов: {statusQuery.data.filesAccepted}</Tag>
              {statusQuery.data.status === 'processing' && <Tag>Идёт обработка…</Tag>}
              {statusQuery.data.status === 'done' && <Tag color="blue">Обработано</Tag>}
              {statusQuery.data.status === 'failed' && (
                <Tag color="red">Не удалось обработать — с вами свяжутся</Tag>
              )}
            </Space>
          )}
          {rejected.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message={`Не приняты файлы: ${rejected.length}`}
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {rejected.map((r) => (
                    <li key={r.filename}>
                      {r.filename} — {rejectLabel(r.reason)}
                    </li>
                  ))}
                </ul>
              }
            />
          )}
        </>
      ) : (
        <>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="Загрузите документы по поставке: УПД, накладные, счета-фактуры."
            description="Подойдут PDF, фотографии документов и файлы Excel (.xlsx). Система распознает их автоматически."
          />
          <Form layout="vertical">
            <Form.Item label="Объект поставки" required>
              <PublicSiteSelect value={siteId} onChange={setSiteId} disabled={uploading} />
            </Form.Item>
            <Form.Item
              label="Дата поставки"
              required
              extra="Дата, на которую машина приезжает на объект."
            >
              <DatePicker
                value={expectedDate}
                onChange={setExpectedDate}
                format="DD.MM.YYYY"
                size="large"
                disabled={uploading}
                style={{ width: '100%' }}
              />
            </Form.Item>
            <Form.Item label="Организация или ФИО" required>
              <Input
                size="large"
                placeholder="ООО «Ромашка» / Иванов Иван"
                value={contact.name}
                maxLength={120}
                disabled={uploading}
                onChange={(e) => setContact((c) => ({ ...c, name: e.target.value }))}
              />
            </Form.Item>
            <Form.Item label="Телефон для связи" required>
              <Input
                size="large"
                inputMode="tel"
                placeholder="+7 900 000-00-00"
                value={contact.phone}
                maxLength={32}
                disabled={uploading}
                onChange={(e) => setContact((c) => ({ ...c, phone: e.target.value }))}
              />
            </Form.Item>
            <Form.Item label="Документы" required>
              <FileDropList
                rows={rows}
                onChange={setRows}
                disabled={uploading}
                accept={ACCEPT}
                hint={`До ${MAX_FILES} файлов, каждый не больше 10 МБ. Можно сфотографировать документы телефоном.`}
              />
            </Form.Item>

            {/* Ловушка для ботов: невидима, вне обхода по Tab, autocomplete
                выключен — заполнить её может только автомат. Сервер на такую
                отправку отвечает как на успешную, но ничего не сохраняет. */}
            <input
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              value={honeypot}
              onChange={(e) => setHoneypot(e.target.value)}
              style={{
                position: 'absolute',
                left: '-9999px',
                width: 1,
                height: 1,
                opacity: 0,
                pointerEvents: 'none',
              }}
            />
          </Form>

          {(tooManyFiles || oversized || totalTooBig) && (
            <Alert
              type="error"
              showIcon
              message={
                tooManyFiles
                  ? `За один раз можно отправить не больше ${MAX_FILES} файлов.`
                  : oversized
                    ? `Файл «${oversized.file.name}» больше 10 МБ.`
                    : 'Суммарный объём больше 20 МБ — отправьте документы в два приёма.'
              }
            />
          )}
        </>
      )}
    </Modal>
  );
}

function rejectLabel(reason: string): string {
  switch (reason) {
    case 'unsupported_type':
      return 'неподдерживаемый формат (нужны PDF, фото или .xlsx)';
    case 'empty':
      return 'пустой файл';
    case 'too_large':
      return 'файл больше 10 МБ';
    case 'signature_image':
      return 'слишком маленькое изображение — документ на нём не прочитать';
    case 'archive_suspicious':
      return 'файл не удалось прочитать';
    default:
      return 'не принят';
  }
}
