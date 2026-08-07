import { useState } from 'react';
import {
  Alert,
  Button,
  Collapse,
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
import {
  CheckCircleTwoTone,
  CloseCircleTwoTone,
  DeleteOutlined,
  LoadingOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import type { PublicRejectReason } from '@matcheck/contracts';
import { FileDropList, pluralFiles, type FileRow } from '../inbox/upload/FileDropList';
import { PublicSiteSelect } from './PublicSiteSelect';
import { PublicApiError, publicUploadDocuments } from '../../services/publicApi';
import {
  MAX_DELIVERIES,
  submitDeliveries,
  type DeliveryState,
  type QueuePatch,
} from './submitQueue';

const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// Держим ниже nginx client_max_body_size: иначе он оборвёт запрос сам и
// ответит HTML-страницей, которую наша обработка ошибок увидит как «сервис
// недоступен» вместо понятного «слишком большой объём».
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_COMMENT = 500;

const ACCEPT =
  'application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,' +
  'image/jpeg,image/png,image/webp,image/heic,.pdf,.xlsx,.jpg,.jpeg,.png,.webp,.heic';

/**
 * Одна поставка: объект, дата, комментарий и свой комплект документов.
 *
 * Поставок в одной отправке может быть несколько — у поставщика за день
 * уходит несколько машин на разные объекты, и раскладывать их по отдельным
 * заходам на страницу неудобно. Каждая уезжает своим запросом (пакет
 * документов в системе и есть «объект + дата + файлы»), поэтому у каждой свой
 * пакет и своя судьба: упавшая не тянет за собой остальные.
 */
type DeliveryDraft = {
  id: string;
  siteId: string | null;
  expectedDate: Dayjs | null;
  comment: string;
  rows: FileRow[];
  state: DeliveryState;
  // Номер обращения от сервера. На экране НЕ показывается — поставщику он ничего
  // не говорит, а менеджеру в портале и так не виден (живёт в
  // ingest_events.public_ticket). Поле держим, потому что его пишет очередь
  // отправки и на нём стоят её тесты.
  ticket?: string;
  error?: string;
  rejected?: Array<{ filename: string; reason: PublicRejectReason }>;
};

let seq = 0;
function emptyDraft(): DeliveryDraft {
  seq += 1;
  return {
    id: `d${seq}-${Date.now()}`,
    siteId: null,
    expectedDate: null,
    comment: '',
    rows: [],
    state: 'draft',
  };
}

/** Что мешает отправить конкретную поставку; null — всё в порядке. */
function draftProblem(d: DeliveryDraft): string | null {
  if (!d.siteId) return 'Выберите объект';
  if (!d.expectedDate) return 'Укажите дату поставки';
  if (d.rows.length === 0) return 'Приложите хотя бы один документ';
  if (d.rows.length > MAX_FILES) return `Не больше ${MAX_FILES} файлов в одной поставке`;
  const big = d.rows.find((r) => r.file.size > MAX_FILE_BYTES);
  if (big) return `Файл «${big.file.name}» больше 10 МБ`;
  const total = d.rows.reduce((sum, r) => sum + r.file.size, 0);
  if (total > MAX_TOTAL_BYTES) return 'Суммарный объём поставки больше 20 МБ';
  return null;
}

export function PublicUploadModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [drafts, setDrafts] = useState<DeliveryDraft[]>(() => [emptyDraft()]);
  const [activeKeys, setActiveKeys] = useState<string[]>(() => [drafts[0]!.id]);
  // Ловушка для ботов: поле есть в DOM, но невидимо и вне обхода по Tab.
  const [honeypot, setHoneypot] = useState('');
  const [sending, setSending] = useState(false);
  const [finished, setFinished] = useState(false);

  const sentCount = drafts.filter((d) => d.state === 'sent').length;
  const failedCount = drafts.filter((d) => d.state === 'failed').length;
  const pending = drafts.filter((d) => d.state !== 'sent');
  const firstProblem = pending.map(draftProblem).find(Boolean) ?? null;
  const canSubmit = !sending && pending.length > 0 && !firstProblem;
  const allSent = drafts.length > 0 && sentCount === drafts.length;

  function patchDraft(id: string, patch: Partial<DeliveryDraft>) {
    setDrafts((prev) =>
      prev.map((d) => {
        if (d.id !== id) return d;
        // Правка неудачной поставки убирает старую ошибку: иначе рядом с уже
        // исправленным полем висит сообщение о прошлой попытке.
        const clearError = d.state === 'failed' ? { state: 'draft' as const, error: undefined } : {};
        return { ...d, ...clearError, ...patch };
      }),
    );
  }

  function applyQueuePatch(id: string, patch: QueuePatch) {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }

  function addDraft() {
    const next = emptyDraft();
    setDrafts((prev) => [...prev, next]);
    setActiveKeys((prev) => [...prev, next.id]);
  }

  function removeDraft(id: string) {
    setDrafts((prev) => (prev.length === 1 ? prev : prev.filter((d) => d.id !== id)));
  }

  function close() {
    if (sending) return;
    const fresh = emptyDraft();
    setDrafts([fresh]);
    setActiveKeys([fresh.id]);
    setHoneypot('');
    setFinished(false);
    onClose();
  }

  async function submit() {
    setSending(true);
    // Снимок очереди: цикл идёт по нему, а не по живому состоянию — пока
    // отправка не закончилась, список менять нельзя, и полагаться на него тоже.
    const snapshot = drafts.filter((d) => d.state !== 'sent');
    try {
      const summary = await submitDeliveries(snapshot, {
        send: async (item) => {
          const d = snapshot.find((x) => x.id === item.id)!;
          return publicUploadDocuments(
            d.rows.map((r) => r.file),
            {
              siteId: d.siteId!,
              expectedDate: d.expectedDate!.format('YYYY-MM-DD'),
              comment: d.comment,
              website: honeypot,
            },
          );
        },
        onUpdate: applyQueuePatch,
        describeError: (err) =>
          err instanceof PublicApiError
            ? err.message
            : 'Не удалось отправить. Проверьте связь и попробуйте ещё раз.',
      });
      setFinished(true);
      if (summary.failed > 0) {
        message.warning(
          `Принято ${summary.sent} из ${summary.sent + summary.failed}. Исправьте отмеченные поставки и отправьте их ещё раз.`,
        );
      }
    } finally {
      setSending(false);
    }
  }

  const footer = allSent ? (
    <Space>
      <Button
        onClick={() => {
          const fresh = emptyDraft();
          setDrafts([fresh]);
          setActiveKeys([fresh.id]);
          setFinished(false);
        }}
      >
        Отправить ещё
      </Button>
      <Button type="primary" onClick={close}>
        Готово
      </Button>
    </Space>
  ) : (
    <Space>
      <Button onClick={close} disabled={sending}>
        {sentCount > 0 ? 'Закрыть' : 'Отмена'}
      </Button>
      <Button type="primary" disabled={!canSubmit} loading={sending} onClick={submit}>
        {submitLabel(pending.length, failedCount)}
      </Button>
    </Space>
  );

  return (
    <Modal
      open={open}
      title="Загрузка документов на приёмку"
      onCancel={close}
      maskClosable={false}
      keyboard={false}
      closable={!sending}
      width="min(760px, 94vw)"
      centered
      styles={{ body: { maxHeight: '72vh', overflowY: 'auto' } }}
      footer={footer}
    >
      {allSent ? (
        <Result
          status="success"
          title={
            drafts.length === 1
              ? 'Документы приняты'
              : `Приняты все поставки: ${drafts.length}`
          }
          subTitle="Мы передали документы на обработку. Если что-то не удастся прочитать, менеджер свяжется с вами."
        />
      ) : (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Загрузите документы по каждой поставке: УПД, накладные, счета-фактуры."
          description="Подойдут PDF, фотографии документов и файлы Excel (.xlsx). Если машин несколько — добавьте отдельную поставку на каждую."
        />
      )}

      <Collapse
        activeKey={activeKeys}
        onChange={(keys) => setActiveKeys(Array.isArray(keys) ? keys : [keys])}
        items={drafts.map((d, i) => ({
          key: d.id,
          label: panelTitle(d, i),
          extra:
            // Удалять можно только то, что ещё не ушло: принятую поставку
            // отменить нельзя, документы уже в системе.
            drafts.length > 1 && (d.state === 'draft' || d.state === 'failed') && !sending ? (
              <Button
                type="text"
                size="small"
                icon={<DeleteOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  removeDraft(d.id);
                }}
              />
            ) : null,
          children: (
            <DeliveryFields
              draft={d}
              locked={sending || d.state === 'sent' || d.state === 'sending'}
              onChange={(patch) => patchDraft(d.id, patch)}
            />
          ),
        }))}
      />

      {!allSent && drafts.length < MAX_DELIVERIES && (
        <Button
          block
          type="dashed"
          icon={<PlusOutlined />}
          style={{ marginTop: 12 }}
          disabled={sending}
          onClick={addDraft}
        >
          Добавить поставку
        </Button>
      )}
      {drafts.length >= MAX_DELIVERIES && (
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          За один раз можно отправить до {MAX_DELIVERIES} поставок. Отправьте эти, потом добавите ещё.
        </Typography.Paragraph>
      )}

      {finished && failedCount > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 12 }}
          message={`Не отправлено поставок: ${failedCount}`}
          description="Исправьте отмеченные поставки и нажмите «Отправить». Уже принятые повторно не отправляются."
        />
      )}
      {!allSent && firstProblem && !sending && (
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          {firstProblem}
        </Typography.Paragraph>
      )}

      {/* Ловушка для ботов: невидима, вне обхода по Tab, автозаполнение
          выключено. Сервер на такую отправку отвечает как на успешную, но
          ничего не сохраняет. */}
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
    </Modal>
  );
}

function submitLabel(pendingCount: number, failedCount: number): string {
  if (failedCount > 0 && failedCount === pendingCount) {
    return `Отправить ещё раз (${failedCount})`;
  }
  if (pendingCount <= 1) return 'Отправить';
  return `Отправить ${pendingCount} ${pluralDeliveries(pendingCount)}`;
}

function pluralDeliveries(n: number): string {
  const last = n % 10;
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'поставок';
  if (last === 1) return 'поставку';
  if (last >= 2 && last <= 4) return 'поставки';
  return 'поставок';
}

function panelTitle(d: DeliveryDraft, index: number) {
  const parts: string[] = [];
  if (d.expectedDate) parts.push(d.expectedDate.format('DD.MM.YYYY'));
  if (d.rows.length > 0) parts.push(`${d.rows.length} ${pluralFiles(d.rows.length)}`);

  return (
    <Space size={8} wrap>
      <span>Поставка {index + 1}</span>
      {parts.length > 0 && <Typography.Text type="secondary">{parts.join(' · ')}</Typography.Text>}
      {d.state === 'sending' && (
        <Tag icon={<LoadingOutlined />} color="processing">
          отправляется
        </Tag>
      )}
      {d.state === 'sent' && (
        <Space size={4}>
          <CheckCircleTwoTone twoToneColor="#52c41a" />
          {/* Номер обращения поставщику не показываем: он непрозрачный, ни о чём
              ему не говорит, и менеджеру в портале тоже не виден. Слово рядом с
              галочкой оставляем — в свёрнутой панели иначе не отличить
              отправленную поставку от черновика. */}
          <Typography.Text type="secondary">принято</Typography.Text>
        </Space>
      )}
      {d.state === 'failed' && (
        <Space size={4}>
          <CloseCircleTwoTone twoToneColor="#ff4d4f" />
          <Typography.Text type="danger">{d.error}</Typography.Text>
        </Space>
      )}
    </Space>
  );
}

function DeliveryFields({
  draft,
  locked,
  onChange,
}: {
  draft: DeliveryDraft;
  locked: boolean;
  onChange: (patch: Partial<DeliveryDraft>) => void;
}) {
  if (draft.state === 'sent') {
    return (
      <>
        <Typography.Paragraph style={{ marginBottom: draft.rejected?.length ? 12 : 0 }}>
          Документы приняты и переданы в обработку.
        </Typography.Paragraph>
        {draft.rejected && draft.rejected.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message={`Не приняты файлы: ${draft.rejected.length}`}
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {draft.rejected.map((r) => (
                  <li key={r.filename}>
                    {r.filename} — {rejectLabel(r.reason)}
                  </li>
                ))}
              </ul>
            }
          />
        )}
      </>
    );
  }

  return (
    <Form layout="vertical">
      <Form.Item label="Объект поставки" required>
        <PublicSiteSelect
          value={draft.siteId}
          onChange={(siteId) => onChange({ siteId })}
          disabled={locked}
        />
      </Form.Item>
      <Form.Item label="Дата поставки" required extra="Дата, на которую машина приезжает на объект.">
        <DatePicker
          value={draft.expectedDate}
          onChange={(expectedDate) => onChange({ expectedDate })}
          format="DD.MM.YYYY"
          size="large"
          disabled={locked}
          style={{ width: '100%' }}
        />
      </Form.Item>
      <Form.Item label="Комментарий" extra="Необязательно. Например: «вторая машина, приедет после обеда».">
        <Input.TextArea
          value={draft.comment}
          onChange={(e) => onChange({ comment: e.target.value })}
          maxLength={MAX_COMMENT}
          showCount
          autoSize={{ minRows: 2, maxRows: 5 }}
          disabled={locked}
        />
      </Form.Item>
      <Form.Item label="Документы" required>
        <FileDropList
          rows={draft.rows}
          onChange={(rows) => onChange({ rows })}
          disabled={locked}
          accept={ACCEPT}
          hint={`До ${MAX_FILES} файлов, каждый не больше 10 МБ. Можно сфотографировать документы телефоном.`}
        />
      </Form.Item>
    </Form>
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
