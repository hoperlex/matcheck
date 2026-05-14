import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Space,
  Spin,
  Typography,
  Upload,
  message,
} from 'antd';
import type { UploadProps } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import type {
  SourceDirection,
  SourceDocumentDetail,
  UpdDuplicateExisting,
  UpdPdfParseResponse,
  UpdPdfParsed,
} from '@matcheck/contracts';
import { api, apiUploadFile, ApiError } from '../../services/api';
import { ContractorSelect } from './ContractorSelect';

type Stage = 'select' | 'parsing' | 'review' | 'saving' | 'conflict';

// Потолок ожидания запроса распознавания УПД (10 мин + 1 мин буфер). На сервере
// LLM-запрос ограничен 600с, Fastify requestTimeout — 660с; клиент не должен
// обрывать раньше сервера.
const PARSE_TIMEOUT_MS = 660_000;

function readDuplicateExisting(err: unknown): UpdDuplicateExisting | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== 'duplicate_upd') {
    return null;
  }
  const payload = err.payload as { existing?: UpdDuplicateExisting } | null;
  return payload?.existing ?? null;
}

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
  const [stage, setStage] = useState<Stage>('select');
  const [parseRes, setParseRes] = useState<UpdPdfParseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm<UpdPdfParsed>();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [lastFile, setLastFile] = useState<File | null>(null);
  const [contractorId, setContractorId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<UpdDuplicateExisting | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function reset() {
    setStage('select');
    setParseRes(null);
    setError(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setLastFile(null);
    setContractorId(null);
    setConflict(null);
    form.resetFields();
  }

  function close() {
    reset();
    onClose();
  }

  async function parseFile(file: File, modeOverride?: 'llm' | 'local'): Promise<void> {
    setError(null);
    setStage('parsing');
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), PARSE_TIMEOUT_MS);
    try {
      const path = modeOverride
        ? `/source-documents/parse-upd-pdf?mode=${modeOverride}`
        : '/source-documents/parse-upd-pdf';
      const res = await apiUploadFile<UpdPdfParseResponse>(path, file, { signal: ac.signal });
      setParseRes(res);
      form.setFieldsValue(res.parsed);
      setStage('review');
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === 'AbortError';
      const msg = aborted
        ? 'Распознавание превысило 10 минут — попробуйте позже или другой режим'
        : err instanceof ApiError
          ? err.message
          : 'Не удалось разобрать PDF';
      setError(msg);
      setStage('select');
    } finally {
      window.clearTimeout(timer);
    }
  }

  const uploadProps: UploadProps = {
    accept: '.pdf,application/pdf',
    maxCount: 1,
    showUploadList: false,
    disabled: !contractorId,
    beforeUpload: async (file) => {
      if (!contractorId) {
        message.warning('Сначала выберите подрядчика');
        return false;
      }
      const f = file as unknown as File;
      const localUrl = URL.createObjectURL(f);
      setPreviewUrl(localUrl);
      setLastFile(f);
      await parseFile(f);
      return false;
    },
  };

  async function saveConfirm(replaceExistingId?: string): Promise<void> {
    if (!parseRes || !contractorId) return;
    setError(null);
    try {
      const values = await form.validateFields();
      setStage('saving');
      await api.post<SourceDocumentDetail>('/source-documents/confirm-upd-pdf', {
        draftS3Key: parseRes.draftS3Key,
        contentHash: parseRes.contentHash,
        parsed: values,
        direction,
        contractorId,
        ...(replaceExistingId ? { replaceExistingId } : {}),
      });
      message.success(replaceExistingId ? 'УПД заменён' : 'УПД сохранён');
      void qc.invalidateQueries({ queryKey: ['source-documents'] });
      close();
    } catch (err) {
      const existing = readDuplicateExisting(err);
      if (existing) {
        setConflict(existing);
        setStage('conflict');
        return;
      }
      if (err instanceof ApiError && err.code === 'has_references') {
        message.error(err.message);
        setStage('review');
        return;
      }
      const msg = err instanceof ApiError ? err.message : 'Ошибка сохранения';
      setError(msg);
      setStage('review');
    }
  }

  const confirm = () => saveConfirm();
  const replaceExisting = () => {
    if (conflict) void saveConfirm(conflict.id);
  };

  const lowConfidence = parseRes && parseRes.llmConfidence < 0.7;
  const localEmpty =
    parseRes && parseRes.parseSource === 'local' && parseRes.parsed.items.length === 0;

  let footer: React.ReactNode = null;
  if (stage === 'review') {
    footer = [
      <Button key="cancel" onClick={close}>
        Отменить
      </Button>,
      <Button key="save" type="primary" onClick={confirm}>
        Сохранить
      </Button>,
    ];
  } else if (stage === 'saving') {
    footer = [
      <Button key="cancel" onClick={close} disabled>
        Отменить
      </Button>,
      <Button key="save" type="primary" loading>
        Сохранить
      </Button>,
    ];
  } else if (stage === 'conflict') {
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
      title="Загрузка УПД (PDF)"
      width={stage === 'review' || stage === 'saving' ? '90vw' : 560}
      footer={footer}
      destroyOnClose
      style={stage === 'review' || stage === 'saving' ? { top: 20 } : {}}
    >
      {error && (
        <Alert type="error" message={error} showIcon style={{ marginBottom: 12 }} closable />
      )}

      {stage === 'select' && (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Typography.Text strong>Подрядчик</Typography.Text>
            <div style={{ marginTop: 4 }}>
              <ContractorSelect value={contractorId} onChange={setContractorId} />
            </div>
          </div>
          <Upload.Dragger {...uploadProps}>
            <p style={{ fontSize: 16, marginBottom: 8 }}>
              Перетащите PDF сюда или кликните для выбора
            </p>
            <Typography.Text type="secondary">
              {contractorId
                ? 'Поддерживаются только PDF с текстовым слоем. Максимум 10 МБ.'
                : 'Сначала выберите подрядчика выше.'}
            </Typography.Text>
          </Upload.Dragger>
        </Space>
      )}

      {stage === 'parsing' && (
        <Space direction="vertical" align="center" style={{ width: '100%', padding: 32 }}>
          <Spin size="large" />
          <Typography.Text>Распознавание PDF… (до 10 минут)</Typography.Text>
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
                «Заменить» удалит старый документ и сохранит свежераспознанный.
                Если старый уже привязан к приёмке/отгрузке — заменить не получится,
                сначала отвяжите его.
              </Typography.Text>
            </Space>
          }
        />
      )}

      {(stage === 'review' || stage === 'saving') && parseRes && (
        <div style={{ display: 'flex', gap: 16, minHeight: '60vh' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {previewUrl ? (
              <iframe
                src={previewUrl}
                title="PDF preview"
                style={{ width: '100%', height: '70vh', border: '1px solid #f0f0f0' }}
              />
            ) : (
              <Typography.Text type="secondary">Превью PDF недоступно</Typography.Text>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0, maxHeight: '70vh', overflowY: 'auto' }}>
            {localEmpty && (
              <Alert
                type="warning"
                message="Локальный парсер не распознал ни одной позиции"
                description="Шаблон документа отличается от поддерживаемого. Можно попробовать распознать через LLM."
                action={
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => lastFile && void parseFile(lastFile, 'llm')}
                    disabled={!lastFile}
                  >
                    Распознать через LLM
                  </Button>
                }
                showIcon
                style={{ marginBottom: 12 }}
              />
            )}
            {lowConfidence && !localEmpty && (
              <Alert
                type="warning"
                message={`Низкая уверенность: ${(parseRes.llmConfidence * 100).toFixed(0)}% (${
                  parseRes.parseSource === 'local' ? 'локально' : 'через LLM'
                })`}
                description="Проверьте данные перед сохранением."
                showIcon
                style={{ marginBottom: 12 }}
              />
            )}
            <Form form={form} layout="vertical" disabled={stage === 'saving'}>
              <Space.Compact block>
                <Form.Item name="docNumber" label="№ документа" style={{ flex: 1, marginRight: 8 }}>
                  <Input />
                </Form.Item>
                <Form.Item name="docDate" label="Дата (YYYY-MM-DD)" style={{ flex: 1 }}>
                  <Input placeholder="2026-05-13" />
                </Form.Item>
              </Space.Compact>
              <Space.Compact block>
                <Form.Item name="totalSum" label="Сумма" style={{ flex: 1, marginRight: 8 }}>
                  <InputNumber style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item name="vatSum" label="НДС" style={{ flex: 1 }}>
                  <InputNumber style={{ width: '100%' }} />
                </Form.Item>
              </Space.Compact>
              <Typography.Title level={5}>Поставщик</Typography.Title>
              <Space.Compact block>
                <Form.Item
                  name={['supplier', 'inn']}
                  label="ИНН"
                  style={{ flex: 1, marginRight: 8 }}
                >
                  <Input />
                </Form.Item>
                <Form.Item
                  name={['supplier', 'kpp']}
                  label="КПП"
                  style={{ flex: 1, marginRight: 8 }}
                >
                  <Input />
                </Form.Item>
                <Form.Item name={['supplier', 'name']} label="Название" style={{ flex: 2 }}>
                  <Input />
                </Form.Item>
              </Space.Compact>
              <Typography.Title level={5}>Позиции</Typography.Title>
              <Form.List name="items">
                {(fields, { add, remove }) => (
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {fields.map(({ key, name }) => (
                      <Space.Compact key={key} block>
                        <Form.Item
                          name={[name, 'nameRaw']}
                          rules={[{ required: true, message: 'Наименование обязательно' }]}
                          style={{ flex: 3, marginRight: 4 }}
                        >
                          <Input placeholder="Наименование" />
                        </Form.Item>
                        <Form.Item
                          name={[name, 'qty']}
                          rules={[{ required: true, message: 'Кол-во' }]}
                          style={{ flex: 1, marginRight: 4 }}
                        >
                          <InputNumber placeholder="Кол-во" style={{ width: '100%' }} />
                        </Form.Item>
                        <Form.Item name={[name, 'unit']} style={{ flex: 1, marginRight: 4 }}>
                          <Input placeholder="шт" />
                        </Form.Item>
                        <Form.Item name={[name, 'price']} style={{ flex: 1, marginRight: 4 }}>
                          <InputNumber placeholder="Цена" style={{ width: '100%' }} />
                        </Form.Item>
                        <Button danger onClick={() => remove(name)}>
                          ×
                        </Button>
                      </Space.Compact>
                    ))}
                    <Button block onClick={() => add({ nameRaw: '', qty: 0, unit: 'шт' })}>
                      + Добавить позицию
                    </Button>
                  </Space>
                )}
              </Form.List>
              <Form.Item name="confidence" hidden>
                <InputNumber />
              </Form.Item>
            </Form>
          </div>
        </div>
      )}
    </Modal>
  );
}
