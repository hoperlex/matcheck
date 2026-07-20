import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Drawer,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
  message,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  LlmKind,
  LlmProviderCredentialDto,
  LlmProviderDto,
  LlmProviderUpsert,
} from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { LlmProviderCredentialsModal } from './LlmProviderCredentialsModal';

const KIND_DEFAULT_MODEL: Record<LlmKind, string> = {
  openrouter: 'anthropic/claude-sonnet-4.5',
  google_ai_studio: 'gemini-2.5-flash',
  qwen_self_hosted: 'qwen2.5-72b-instruct',
  vertex: 'gemini-2.5-pro',
};

const KIND_LABEL: Record<LlmKind, string> = {
  openrouter: 'OpenRouter',
  google_ai_studio: 'Google AI Studio (Gemini)',
  qwen_self_hosted: 'Qwen (self-hosted, OpenAI-compat)',
  vertex: 'Vertex AI',
};

const NEW_DEFAULTS: Partial<LlmProviderUpsert> = {
  kind: 'openrouter',
  model: KIND_DEFAULT_MODEL.openrouter,
  temperature: '0.2',
  maxTokens: 4096,
  isDefault: false,
  isActive: true,
};

export default function AdminLlmProvidersPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [credsOpen, setCredsOpen] = useState(false);
  const [editing, setEditing] = useState<LlmProviderDto | null>(null);
  const [form] = Form.useForm<LlmProviderUpsert>();

  const list = useQuery({
    queryKey: ['admin', 'llm-providers'],
    queryFn: () => api.get<LlmProviderDto[]>('/admin/llm-providers'),
  });

  const creds = useQuery({
    queryKey: ['admin', 'llm-provider-credentials'],
    queryFn: () => api.get<LlmProviderCredentialDto[]>('/admin/llm-provider-credentials'),
  });

  const credsByKind = useMemo(() => {
    const m = new Map<LlmKind, LlmProviderCredentialDto>();
    for (const c of creds.data ?? []) m.set(c.kind, c);
    return m;
  }, [creds.data]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin', 'llm-providers'] });

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (editing) {
      form.setFieldsValue({
        name: editing.name,
        kind: editing.kind,
        model: editing.model,
        temperature: editing.temperature,
        maxTokens: editing.maxTokens,
        isDefault: editing.isDefault,
        isActive: editing.isActive,
      });
    } else {
      form.setFieldsValue(NEW_DEFAULTS);
    }
  }, [open, editing, form]);

  const closeDrawer = () => {
    setOpen(false);
    setEditing(null);
  };

  const create = useMutation({
    mutationFn: (body: LlmProviderUpsert) => api.post('/admin/llm-providers', body),
    onSuccess: () => {
      message.success('Провайдер добавлен');
      closeDrawer();
      void invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<LlmProviderUpsert> }) =>
      api.patch(`/admin/llm-providers/${id}`, body),
    onSuccess: () => {
      message.success('Сохранено');
      closeDrawer();
      void invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<LlmProviderUpsert> }) =>
      api.patch(`/admin/llm-providers/${id}`, body),
    onSuccess: () => void invalidate(),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/llm-providers/${id}`),
    onSuccess: () => {
      message.success('Удалён');
      void invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const test = useMutation({
    mutationFn: (id: string) =>
      api.post<{ ok: boolean; output?: string; error?: string; durationMs: number }>(
        `/admin/llm-providers/${id}/test`,
        undefined,
        // Тест провайдера ходит в LLM (до ~20с) — свой таймаут выше дефолта.
        { timeoutMs: 60_000 },
      ),
    onSuccess: (r) => {
      if (r.ok) message.success(`OK (${r.durationMs} мс): ${r.output ?? ''}`);
      else message.error(`Ошибка: ${r.error}`);
    },
    onError: (err: Error) => message.error(err.message),
  });

  const onSubmit = (v: LlmProviderUpsert) => {
    if (editing) update.mutate({ id: editing.id, body: v });
    else create.mutate(v);
  };

  const openEdit = (r: LlmProviderDto) => {
    setEditing(r);
    setOpen(true);
  };

  const openCreate = () => {
    setEditing(null);
    setOpen(true);
  };

  return (
    <StickyPageHeader
      header={
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Typography.Title level={3} style={{ margin: 0 }}>
            LLM провайдеры
          </Typography.Title>
          <Space>
            <Button onClick={() => setCredsOpen(true)}>Ключи провайдеров</Button>
            <Button type="primary" onClick={openCreate}>
              Добавить
            </Button>
          </Space>
        </Space>
      }
    >
      <ResponsiveTable<LlmProviderDto>
        items={list.data ?? []}
        loading={list.isLoading}
        rowKey="id"
        numbered
        columns={[
          {
            title: 'Имя',
            dataIndex: 'name',
            render: (n: string, r: LlmProviderDto) => (
              <Space>
                <span>{n}</span>
                {r.isDefault && <Tag color="purple">default</Tag>}
                {!r.isActive && <Tag>не активен</Tag>}
                {!credsByKind.has(r.kind) && <Tag color="red">нет ключа</Tag>}
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
                <Button size="small" onClick={() => openEdit(r)}>
                  Редактировать
                </Button>
                <Button size="small" onClick={() => test.mutate(r.id)} loading={test.isPending}>
                  Тест
                </Button>
                <Button
                  size="small"
                  onClick={() => patch.mutate({ id: r.id, body: { isDefault: true } })}
                >
                  Сделать default
                </Button>
                <Switch
                  checked={r.isActive}
                  onChange={(v) => patch.mutate({ id: r.id, body: { isActive: v } })}
                />
                <Popconfirm
                  title="Удалить провайдера?"
                  okText="Удалить"
                  cancelText="Отмена"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => remove.mutate(r.id)}
                >
                  <Button size="small" danger>
                    Удалить
                  </Button>
                </Popconfirm>
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
                {!r.isActive && <Tag>не активен</Tag>}
                {!credsByKind.has(r.kind) && <Tag color="red">нет ключа</Tag>}
              </Space>
              <Typography.Text type="secondary">
                {r.kind} · {r.model}
              </Typography.Text>
              <Space wrap>
                <Button size="small" onClick={() => openEdit(r)}>
                  Редактировать
                </Button>
                <Button size="small" onClick={() => test.mutate(r.id)}>
                  Тест
                </Button>
                <Button
                  size="small"
                  onClick={() => patch.mutate({ id: r.id, body: { isDefault: true } })}
                >
                  Default
                </Button>
                <Popconfirm
                  title="Удалить провайдера?"
                  okText="Удалить"
                  cancelText="Отмена"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => remove.mutate(r.id)}
                >
                  <Button size="small" danger>
                    Удалить
                  </Button>
                </Popconfirm>
              </Space>
            </Space>
          </Card>
        )}
      />
      <Drawer
        open={open}
        onClose={closeDrawer}
        title={editing ? `Редактирование: ${editing.name}` : 'Новый LLM провайдер'}
        width={520}
        destroyOnClose
        maskClosable={false}
        keyboard={false}
      >
        <Form<LlmProviderUpsert>
          form={form}
          layout="vertical"
          onFinish={onSubmit}
          onValuesChange={(changed, all) => {
            if (editing) return;
            if (changed.kind && all.kind) {
              form.setFieldsValue({ model: KIND_DEFAULT_MODEL[all.kind] });
            }
          }}
        >
          <Form.Item name="name" label="Имя" rules={[{ required: true }]}>
            <Input placeholder="Claude Sonnet через OpenRouter" />
          </Form.Item>
          <Form.Item name="kind" label="Тип" rules={[{ required: true }]}>
            <Select
              options={(Object.keys(KIND_LABEL) as LlmKind[]).map((k) => ({
                value: k,
                label: credsByKind.has(k) ? KIND_LABEL[k] : `${KIND_LABEL[k]} — нет ключа`,
              }))}
            />
          </Form.Item>
          <Form.Item name="model" label="Модель" rules={[{ required: true }]}>
            <Input />
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
          <Button
            type="primary"
            htmlType="submit"
            block
            size="large"
            loading={create.isPending || update.isPending}
          >
            Сохранить
          </Button>
        </Form>
      </Drawer>
      <LlmProviderCredentialsModal
        open={credsOpen}
        onClose={() => setCredsOpen(false)}
        credentials={creds.data ?? []}
        modelsByKind={list.data ?? []}
      />
    </StickyPageHeader>
  );
}
