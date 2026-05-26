import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PromptDocKind, PromptDto, PromptUpsert } from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';

const DOC_KIND_LABEL: Record<PromptDocKind, string> = {
  upd: 'УПД (PDF)',
  request: 'Заявка (письмо)',
};

type FormValues = PromptUpsert;

export default function AdminPromptsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PromptDto | null>(null);
  const [form] = Form.useForm<FormValues>();

  const list = useQuery({
    queryKey: ['admin', 'prompts'],
    queryFn: () => api.get<PromptDto[]>('/admin/prompts'),
  });

  useEffect(() => {
    if (open) {
      form.resetFields();
      if (editing) {
        form.setFieldsValue({
          docKind: editing.docKind,
          name: editing.name,
          content: editing.content,
          isActive: editing.isActive,
        });
      } else {
        form.setFieldsValue({ docKind: 'upd', isActive: false });
      }
    }
  }, [open, editing, form]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin', 'prompts'] });

  const create = useMutation({
    mutationFn: (body: FormValues) => api.post('/admin/prompts', body),
    onSuccess: () => {
      message.success('Промпт добавлен');
      setOpen(false);
      setEditing(null);
      void invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { name?: string; content?: string } }) =>
      api.patch(`/admin/prompts/${id}`, body),
    onSuccess: () => {
      message.success('Сохранено');
      setOpen(false);
      setEditing(null);
      void invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const activate = useMutation({
    mutationFn: (id: string) => api.post(`/admin/prompts/${id}/activate`),
    onSuccess: () => {
      message.success('Активирован');
      void invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/prompts/${id}`),
    onSuccess: () => {
      message.success('Удалён');
      void invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const onSubmit = (v: FormValues) => {
    if (editing) {
      patch.mutate({ id: editing.id, body: { name: v.name, content: v.content } });
    } else {
      create.mutate(v);
    }
  };

  return (
    <StickyPageHeader
      header={
        <>
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Typography.Title level={3} style={{ margin: 0 }}>
              Промпты LLM
            </Typography.Title>
            <Button
              type="primary"
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
            >
              Добавить
            </Button>
          </Space>
          <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            Системные промпты для распознавания документов через LLM. У каждого типа документа
            активен только один промпт. При активации новой версии прежняя автоматически
            деактивируется.
          </Typography.Paragraph>
        </>
      }
    >
      <ResponsiveTable<PromptDto>
        items={list.data ?? []}
        loading={list.isLoading}
        rowKey="id"
        columns={[
          {
            title: 'Тип',
            dataIndex: 'docKind',
            render: (k: PromptDocKind) => DOC_KIND_LABEL[k],
            width: 160,
          },
          {
            title: 'Имя',
            dataIndex: 'name',
            render: (n: string, r: PromptDto) => (
              <Space>
                <span>{n}</span>
                {r.isActive && <Tag color="green">активен</Tag>}
              </Space>
            ),
          },
          {
            title: 'Обновлён',
            dataIndex: 'updatedAt',
            render: (s: string) => new Date(s).toLocaleString('ru-RU'),
            width: 160,
          },
          {
            title: 'Действия',
            key: 'a',
            render: (_: unknown, r: PromptDto) => (
              <Space wrap>
                <Button
                  size="small"
                  onClick={() => {
                    setEditing(r);
                    setOpen(true);
                  }}
                >
                  Редактировать
                </Button>
                {!r.isActive && (
                  <Button
                    size="small"
                    onClick={() => activate.mutate(r.id)}
                    loading={activate.isPending}
                  >
                    Активировать
                  </Button>
                )}
                <Tooltip title={r.isActive ? 'Активный промпт нельзя удалить' : ''}>
                  <Popconfirm
                    title="Удалить промпт?"
                    onConfirm={() => remove.mutate(r.id)}
                    disabled={r.isActive}
                  >
                    <Button size="small" danger disabled={r.isActive}>
                      Удалить
                    </Button>
                  </Popconfirm>
                </Tooltip>
              </Space>
            ),
          },
        ]}
        cardRender={(r) => (
          <Card size="small" style={{ width: '100%' }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Space>
                <Tag>{DOC_KIND_LABEL[r.docKind]}</Tag>
                <Typography.Text strong>{r.name}</Typography.Text>
                {r.isActive && <Tag color="green">активен</Tag>}
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Обновлён {new Date(r.updatedAt).toLocaleString('ru-RU')}
              </Typography.Text>
              <Space wrap>
                <Button
                  size="small"
                  onClick={() => {
                    setEditing(r);
                    setOpen(true);
                  }}
                >
                  Редактировать
                </Button>
                {!r.isActive && (
                  <Button size="small" onClick={() => activate.mutate(r.id)}>
                    Активировать
                  </Button>
                )}
              </Space>
            </Space>
          </Card>
        )}
      />

      <Drawer
        open={open}
        onClose={() => {
          setOpen(false);
          setEditing(null);
        }}
        title={editing ? `Редактирование: ${editing.name}` : 'Новый промпт'}
        width={Math.min(720, Math.round(window.innerWidth * 0.95))}
        destroyOnClose
      >
        <Form<FormValues> form={form} layout="vertical" onFinish={onSubmit}>
          <Form.Item name="docKind" label="Тип документа" rules={[{ required: true }]}>
            <Select
              disabled={!!editing}
              options={[
                { value: 'upd', label: 'УПД (PDF)' },
                { value: 'request', label: 'Заявка (письмо)' },
              ]}
            />
          </Form.Item>
          <Form.Item name="name" label="Имя версии" rules={[{ required: true, max: 200 }]}>
            <Input placeholder="например: с расчётом объёма v2" />
          </Form.Item>
          <Form.Item
            name="content"
            label="Текст промпта"
            rules={[{ required: true, min: 1, max: 50000 }]}
            extra="Возвращай только JSON по схеме. Метаданные документа доступны в user-сообщении."
          >
            <Input.TextArea
              autoSize={{ minRows: 15, maxRows: 30 }}
              style={{ fontFamily: 'JetBrains Mono, Consolas, monospace', fontSize: 12 }}
            />
          </Form.Item>
          {!editing && (
            <Form.Item name="isActive" valuePropName="checked" label="Сделать активным сразу">
              <Switch />
            </Form.Item>
          )}
          <Button
            type="primary"
            htmlType="submit"
            block
            size="large"
            loading={create.isPending || patch.isPending}
          >
            Сохранить
          </Button>
        </Form>
      </Drawer>
    </StickyPageHeader>
  );
}
