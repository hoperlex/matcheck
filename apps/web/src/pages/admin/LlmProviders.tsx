import { useState } from 'react';
import {
  Button,
  Card,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
  message,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LlmProviderDto, LlmProviderUpsert } from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';

const KIND_DEFAULTS: Record<string, { apiBaseUrl: string; model: string }> = {
  openrouter: { apiBaseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.5' },
  google_ai_studio: {
    apiBaseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.5-flash',
  },
  qwen_self_hosted: { apiBaseUrl: 'https://your-qwen-host/v1', model: 'qwen2.5-72b-instruct' },
  vertex: { apiBaseUrl: 'https://us-central1-aiplatform.googleapis.com', model: 'gemini-2.5-pro' },
};

export default function AdminLlmProvidersPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<LlmProviderUpsert>();

  const list = useQuery({
    queryKey: ['admin', 'llm-providers'],
    queryFn: () => api.get<LlmProviderDto[]>('/admin/llm-providers'),
  });

  const create = useMutation({
    mutationFn: (body: LlmProviderUpsert) => api.post('/admin/llm-providers', body),
    onSuccess: () => {
      message.success('Провайдер добавлен');
      setOpen(false);
      form.resetFields();
      void qc.invalidateQueries({ queryKey: ['admin', 'llm-providers'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<LlmProviderUpsert> }) =>
      api.patch(`/admin/llm-providers/${id}`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'llm-providers'] }),
  });

  const test = useMutation({
    mutationFn: (id: string) =>
      api.post<{ ok: boolean; output?: string; error?: string; durationMs: number }>(
        `/admin/llm-providers/${id}/test`,
      ),
    onSuccess: (r) => {
      if (r.ok) message.success(`OK (${r.durationMs} мс): ${r.output ?? ''}`);
      else message.error(`Ошибка: ${r.error}`);
    },
    onError: (err: Error) => message.error(err.message),
  });

  return (
    <div>
      <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          LLM провайдеры
        </Typography.Title>
        <Button type="primary" onClick={() => setOpen(true)}>
          Добавить
        </Button>
      </Space>
      <ResponsiveTable<LlmProviderDto>
        items={list.data ?? []}
        loading={list.isLoading}
        rowKey="id"
        columns={[
          {
            title: 'Имя',
            dataIndex: 'name',
            render: (n: string, r: LlmProviderDto) => (
              <Space>
                <span>{n}</span>
                {r.isDefault && <Tag color="purple">default</Tag>}
                {!r.isActive && <Tag>не активен</Tag>}
              </Space>
            ),
          },
          { title: 'Kind', dataIndex: 'kind' },
          { title: 'Модель', dataIndex: 'model' },
          {
            title: 'Действия',
            key: 'a',
            render: (_: unknown, r: LlmProviderDto) => (
              <Space wrap>
                <Button onClick={() => test.mutate(r.id)} loading={test.isPending}>
                  Тест
                </Button>
                <Button onClick={() => patch.mutate({ id: r.id, body: { isDefault: true } })}>
                  Сделать default
                </Button>
                <Switch
                  checked={r.isActive}
                  onChange={(v) => patch.mutate({ id: r.id, body: { isActive: v } })}
                />
              </Space>
            ),
          },
        ]}
        cardRender={(r) => (
          <Card style={{ width: '100%' }} size="small">
            <Space direction="vertical">
              <Space>
                <Typography.Text strong>{r.name}</Typography.Text>
                {r.isDefault && <Tag color="purple">default</Tag>}
              </Space>
              <Typography.Text type="secondary">
                {r.kind} · {r.model}
              </Typography.Text>
              <Space wrap>
                <Button size="small" onClick={() => test.mutate(r.id)}>
                  Тест
                </Button>
                <Button
                  size="small"
                  onClick={() => patch.mutate({ id: r.id, body: { isDefault: true } })}
                >
                  Default
                </Button>
              </Space>
            </Space>
          </Card>
        )}
      />
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Новый LLM провайдер"
        width={520}
        destroyOnClose
      >
        <Form<LlmProviderUpsert>
          form={form}
          layout="vertical"
          onFinish={(v) => create.mutate(v)}
          initialValues={{
            kind: 'openrouter',
            ...KIND_DEFAULTS.openrouter,
            temperature: '0.2',
            maxTokens: 4096,
            isDefault: false,
            isActive: true,
          }}
          onValuesChange={(changed, all) => {
            if (changed.kind && all.kind && KIND_DEFAULTS[all.kind]) {
              form.setFieldsValue(KIND_DEFAULTS[all.kind]);
            }
          }}
        >
          <Form.Item name="name" label="Имя" rules={[{ required: true }]}>
            <Input placeholder="Claude Sonnet через OpenRouter" />
          </Form.Item>
          <Form.Item name="kind" label="Тип" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'openrouter', label: 'OpenRouter' },
                { value: 'google_ai_studio', label: 'Google AI Studio (Gemini)' },
                { value: 'qwen_self_hosted', label: 'Qwen (self-hosted, OpenAI-compat)' },
                { value: 'vertex', label: 'Vertex AI' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="apiBaseUrl"
            label="API base URL"
            rules={[{ required: true, type: 'url' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="model" label="Модель" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="apiKey" label="API key" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
          <Space>
            <Form.Item name="temperature" label="Temperature">
              <Input />
            </Form.Item>
            <Form.Item name="maxTokens" label="Max tokens">
              <InputNumber min={1} />
            </Form.Item>
          </Space>
          <Form.Item name="isDefault" valuePropName="checked" label="По умолчанию">
            <Switch />
          </Form.Item>
          <Form.Item name="isActive" valuePropName="checked" label="Активен">
            <Switch />
          </Form.Item>
          <Button type="primary" htmlType="submit" block size="large" loading={create.isPending}>
            Сохранить
          </Button>
        </Form>
      </Drawer>
    </div>
  );
}
