import { useState } from 'react';
import {
  Button,
  Card,
  Drawer,
  Form,
  Input,
  InputNumber,
  Space,
  Switch,
  Typography,
  message,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MailAccountDto, MailAccountUpsert } from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';

export default function AdminMailAccountsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<MailAccountUpsert>();

  const list = useQuery({
    queryKey: ['admin', 'mail-accounts'],
    queryFn: () => api.get<MailAccountDto[]>('/admin/mail-accounts'),
  });
  const create = useMutation({
    mutationFn: (body: MailAccountUpsert) => api.post('/admin/mail-accounts', body),
    onSuccess: () => {
      message.success('Ящик добавлен');
      setOpen(false);
      form.resetFields();
      void qc.invalidateQueries({ queryKey: ['admin', 'mail-accounts'] });
    },
    onError: (err: Error) => message.error(err.message),
  });
  const sync = useMutation({
    mutationFn: (id: string) =>
      api.post<{ imported: number; failed: number }>(`/admin/mail-accounts/${id}/sync`),
    onSuccess: (r) => message.success(`Импорт: ${r.imported}, ошибок: ${r.failed}`),
    onError: (err: Error) => message.error(err.message),
  });

  return (
    <StickyPageHeader
      header={
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Typography.Title level={3} style={{ margin: 0 }}>
            Почтовые ящики
          </Typography.Title>
          <Button type="primary" onClick={() => setOpen(true)}>
            Добавить
          </Button>
        </Space>
      }
    >
      <ResponsiveTable<MailAccountDto>
        items={list.data ?? []}
        loading={list.isLoading}
        rowKey="id"
        numbered
        columns={[
          { title: 'Имя', dataIndex: 'name' },
          { title: 'Host', dataIndex: 'host' },
          { title: 'Пользователь', dataIndex: 'username' },
          { title: 'Папка', dataIndex: 'folder' },
          {
            title: 'Действия',
            key: 'a',
            render: (_: unknown, r: MailAccountDto) => (
              <Button onClick={() => sync.mutate(r.id)} loading={sync.isPending}>
                Sync
              </Button>
            ),
          },
        ]}
        cardRender={(r) => (
          <Card size="small" style={{ width: '100%' }}>
            <Space direction="vertical">
              <Typography.Text strong>{r.name}</Typography.Text>
              <Typography.Text type="secondary">
                {r.username}@{r.host}:{r.port}
              </Typography.Text>
              <Button size="small" onClick={() => sync.mutate(r.id)}>
                Sync
              </Button>
            </Space>
          </Card>
        )}
      />
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Новый ящик"
        width={480}
        destroyOnClose
        maskClosable={false}
        keyboard={false}
      >
        <Form<MailAccountUpsert>
          form={form}
          layout="vertical"
          onFinish={(v) => create.mutate(v)}
          initialValues={{ port: 993, useTls: true, folder: 'INBOX', isActive: true }}
        >
          <Form.Item name="name" label="Имя" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="host" label="IMAP host" rules={[{ required: true }]}>
            <Input placeholder="imap.example.com" />
          </Form.Item>
          <Space>
            <Form.Item name="port" label="Port" rules={[{ required: true }]}>
              <InputNumber min={1} max={65535} />
            </Form.Item>
            <Form.Item name="useTls" label="TLS" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item name="username" label="Логин" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="password" label="Пароль" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item name="folder" label="Папка" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" block size="large" loading={create.isPending}>
            Сохранить
          </Button>
        </Form>
      </Drawer>
    </StickyPageHeader>
  );
}
