import { useEffect } from 'react';
import {
  Button,
  Divider,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Tag,
  Typography,
  message,
} from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  LlmKind,
  LlmProviderCredentialDto,
  LlmProviderCredentialUpsert,
  LlmProviderDto,
} from '@matcheck/contracts';
import { api } from '../../services/api';

const KIND_LABEL: Record<LlmKind, string> = {
  openrouter: 'OpenRouter',
  google_ai_studio: 'Google AI Studio (Gemini)',
  qwen_self_hosted: 'Qwen (self-hosted, OpenAI-compat)',
  vertex: 'Vertex AI',
};

const KIND_DEFAULT_URL: Record<LlmKind, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  google_ai_studio: 'https://generativelanguage.googleapis.com',
  qwen_self_hosted: 'https://your-qwen-host/v1',
  vertex: 'https://us-central1-aiplatform.googleapis.com',
};

const KINDS = Object.keys(KIND_LABEL) as LlmKind[];

interface Props {
  open: boolean;
  onClose: () => void;
  credentials: LlmProviderCredentialDto[];
  modelsByKind: LlmProviderDto[];
}

export function LlmProviderCredentialsModal({
  open,
  onClose,
  credentials,
  modelsByKind,
}: Props) {
  const credsMap = new Map(credentials.map((c) => [c.kind, c]));
  const usageCount = (kind: LlmKind) =>
    modelsByKind.filter((m) => m.kind === kind).length;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title="Ключи провайдеров"
      width={640}
      destroyOnClose
      maskClosable={false}
      keyboard={false}
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        Один ключ хранится на тип провайдера и переиспользуется всеми моделями этого типа.
      </Typography.Paragraph>
      {KINDS.map((kind, i) => (
        <div key={kind}>
          {i > 0 && <Divider />}
          <KindCredentialForm
            kind={kind}
            current={credsMap.get(kind)}
            modelsCount={usageCount(kind)}
          />
        </div>
      ))}
    </Modal>
  );
}

function KindCredentialForm({
  kind,
  current,
  modelsCount,
}: {
  kind: LlmKind;
  current: LlmProviderCredentialDto | undefined;
  modelsCount: number;
}) {
  const qc = useQueryClient();
  const [form] = Form.useForm<LlmProviderCredentialUpsert>();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['admin', 'llm-provider-credentials'] });

  useEffect(() => {
    form.setFieldsValue({
      apiBaseUrl: current?.apiBaseUrl ?? KIND_DEFAULT_URL[kind],
      apiKey: '',
    });
  }, [current?.apiBaseUrl, current?.updatedAt, kind, form]);

  const save = useMutation({
    mutationFn: (body: LlmProviderCredentialUpsert) =>
      api.put<LlmProviderCredentialDto>(
        `/admin/llm-provider-credentials/${kind}`,
        body,
      ),
    onSuccess: () => {
      message.success('Сохранено');
      form.setFieldsValue({ apiKey: '' });
      void invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/admin/llm-provider-credentials/${kind}`),
    onSuccess: () => {
      message.success('Удалено');
      void invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const test = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; output?: string; error?: string; durationMs: number }>(
        `/admin/llm-provider-credentials/${kind}/test`,
      ),
    onSuccess: (r) => {
      if (r.ok) message.success(`OK (${r.durationMs} мс): ${r.output ?? ''}`);
      else message.error(`Ошибка: ${r.error}`);
    },
    onError: (err: Error) => message.error(err.message),
  });

  const onSubmit = (v: LlmProviderCredentialUpsert) => {
    const body: LlmProviderCredentialUpsert = {
      apiBaseUrl: v.apiBaseUrl,
      ...(v.apiKey ? { apiKey: v.apiKey } : {}),
    };
    save.mutate(body);
  };

  return (
    <Form<LlmProviderCredentialUpsert>
      form={form}
      layout="vertical"
      onFinish={onSubmit}
    >
      <Space style={{ marginBottom: 8 }}>
        <Typography.Text strong>{KIND_LABEL[kind]}</Typography.Text>
        {current ? <Tag color="green">ключ задан</Tag> : <Tag>ключ не задан</Tag>}
        {modelsCount > 0 && <Tag>моделей: {modelsCount}</Tag>}
      </Space>
      <Form.Item
        name="apiBaseUrl"
        label="API base URL"
        rules={[{ required: true, type: 'url' }]}
      >
        <Input />
      </Form.Item>
      <Form.Item
        name="apiKey"
        label={current ? 'API key (новый)' : 'API key'}
        rules={current ? [] : [{ required: true, message: 'Введите ключ' }]}
        extra={current ? 'Оставьте пустым, чтобы не менять текущий ключ' : undefined}
      >
        <Input.Password
          placeholder={current ? 'Оставьте пустым, чтобы не менять' : undefined}
          autoComplete="new-password"
        />
      </Form.Item>
      <Space wrap>
        <Button type="primary" htmlType="submit" loading={save.isPending}>
          Сохранить
        </Button>
        <Button
          onClick={() => test.mutate()}
          loading={test.isPending}
          disabled={!current}
        >
          Тест
        </Button>
        <Popconfirm
          title="Удалить ключ?"
          description={
            modelsCount > 0
              ? `Сначала удалите модели этого типа (${modelsCount})`
              : undefined
          }
          okText="Удалить"
          cancelText="Отмена"
          okButtonProps={{ danger: true, disabled: modelsCount > 0 }}
          onConfirm={() => modelsCount === 0 && remove.mutate()}
        >
          <Button danger disabled={!current || modelsCount > 0}>
            Удалить
          </Button>
        </Popconfirm>
      </Space>
    </Form>
  );
}
