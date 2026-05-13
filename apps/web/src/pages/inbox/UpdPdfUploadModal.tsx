import { useState } from 'react';
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
import type { SourceDocumentDetail, UpdPdfParseResponse, UpdPdfParsed } from '@matcheck/contracts';
import { api, apiUploadFile, ApiError } from '../../services/api';

type Stage = 'select' | 'parsing' | 'review' | 'saving';

export function UpdPdfUploadModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [stage, setStage] = useState<Stage>('select');
  const [parseRes, setParseRes] = useState<UpdPdfParseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm<UpdPdfParsed>();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  function reset() {
    setStage('select');
    setParseRes(null);
    setError(null);
    setPreviewUrl(null);
    form.resetFields();
  }

  function close() {
    reset();
    onClose();
  }

  const uploadProps: UploadProps = {
    accept: '.pdf,application/pdf',
    maxCount: 1,
    showUploadList: false,
    beforeUpload: async (file) => {
      setError(null);
      setStage('parsing');
      try {
        const localUrl = URL.createObjectURL(file);
        setPreviewUrl(localUrl);
        const res = await apiUploadFile<UpdPdfParseResponse>(
          '/source-documents/parse-upd-pdf',
          file as unknown as File,
        );
        setParseRes(res);
        form.setFieldsValue(res.parsed);
        setStage('review');
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'Не удалось разобрать PDF';
        setError(msg);
        setStage('select');
      }
      return false;
    },
  };

  const confirm = async () => {
    if (!parseRes) return;
    try {
      const values = await form.validateFields();
      setStage('saving');
      await api.post<SourceDocumentDetail>('/source-documents/confirm-upd-pdf', {
        draftS3Key: parseRes.draftS3Key,
        contentHash: parseRes.contentHash,
        parsed: values,
      });
      message.success('УПД сохранён');
      void qc.invalidateQueries({ queryKey: ['source-documents'] });
      close();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Ошибка сохранения';
      setError(msg);
      setStage('review');
    }
  };

  const lowConfidence = parseRes && parseRes.llmConfidence < 0.7;

  return (
    <Modal
      open={open}
      onCancel={close}
      title="Загрузка УПД (PDF)"
      width={stage === 'review' ? '90vw' : 560}
      footer={
        stage === 'review'
          ? [
              <Button key="cancel" onClick={close} disabled={stage !== 'review'}>
                Отменить
              </Button>,
              <Button
                key="save"
                type="primary"
                onClick={confirm}
                loading={(stage as Stage) === 'saving'}
              >
                Сохранить
              </Button>,
            ]
          : null
      }
      destroyOnClose
      style={stage === 'review' ? { top: 20 } : {}}
    >
      {error && (
        <Alert type="error" message={error} showIcon style={{ marginBottom: 12 }} closable />
      )}

      {stage === 'select' && (
        <Upload.Dragger {...uploadProps}>
          <p style={{ fontSize: 16, marginBottom: 8 }}>
            Перетащите PDF сюда или кликните для выбора
          </p>
          <Typography.Text type="secondary">
            Поддерживаются только PDF с текстовым слоем. Максимум 10 МБ.
          </Typography.Text>
        </Upload.Dragger>
      )}

      {stage === 'parsing' && (
        <Space direction="vertical" align="center" style={{ width: '100%', padding: 32 }}>
          <Spin size="large" />
          <Typography.Text>Распознавание PDF через LLM…</Typography.Text>
        </Space>
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
            {lowConfidence && (
              <Alert
                type="warning"
                message={`Низкая уверенность: ${(parseRes.llmConfidence * 100).toFixed(0)}%`}
                description="Проверьте данные перед сохранением."
                showIcon
                style={{ marginBottom: 12 }}
              />
            )}
            <Form form={form} layout="vertical" disabled={(stage as Stage) === 'saving'}>
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
