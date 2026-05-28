import { useState } from 'react';
import { Button, Card, Drawer, Form, Input, Space, Tag, Typography, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EdoAccountDto, EdoAccountUpsert } from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';

export default function AdminEdoAccountsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();

  const list = useQuery({
    queryKey: ['admin', 'edo-accounts'],
    queryFn: () => api.get<EdoAccountDto[]>('/admin/edo-accounts'),
  });

  const create = useMutation({
    mutationFn: (body: EdoAccountUpsert) => api.post('/admin/edo-accounts', body),
    onSuccess: () => {
      message.success('Учётка добавлена');
      setOpen(false);
      form.resetFields();
      void qc.invalidateQueries({ queryKey: ['admin', 'edo-accounts'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const sync = useMutation({
    mutationFn: (id: string) =>
      api.post<{ imported: number; failed: number }>(`/admin/edo-accounts/${id}/sync`),
    onSuccess: (r) => message.success(`Импортировано: ${r.imported}, ошибок: ${r.failed}`),
    onError: (err: Error) => message.error(err.message),
  });

  return (
    <StickyPageHeader
      header={
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Typography.Title level={3} style={{ margin: 0 }}>
            ЭДО учётки (Диадок)
          </Typography.Title>
          <Button type="primary" onClick={() => setOpen(true)}>
            Добавить
          </Button>
        </Space>
      }
    >
      <ResponsiveTable<EdoAccountDto>
        items={list.data ?? []}
        loading={list.isLoading}
        rowKey="id"
        numbered
        columns={[
          { title: 'Имя', dataIndex: 'name' },
          { title: 'Провайдер', dataIndex: 'provider', render: (p: string) => <Tag>{p}</Tag> },
          { title: 'Последняя синхронизация', dataIndex: 'lastSyncAt' },
          {
            title: 'Действия',
            key: 'a',
            render: (_: unknown, r: EdoAccountDto) => (
              <Button onClick={() => sync.mutate(r.id)} loading={sync.isPending}>
                Sync now
              </Button>
            ),
          },
        ]}
        cardRender={(r) => (
          <Card size="small" style={{ width: '100%' }}>
            <Space direction="vertical">
              <Typography.Text strong>{r.name}</Typography.Text>
              <Typography.Text type="secondary">{r.provider}</Typography.Text>
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
        title="Новая ЭДО-учётка"
        width={480}
        destroyOnClose
        maskClosable={false}
        keyboard={false}
      >
        <Form<EdoAccountUpsert>
          form={form}
          layout="vertical"
          onFinish={(v) => create.mutate(v)}
          initialValues={{ provider: 'diadoc', isActive: true }}
        >
          <Form.Item name="name" label="Имя" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name={['credentials', 'apiClientId']}
            label="API client ID"
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name={['credentials', 'login']} label="Логин" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name={['credentials', 'password']} label="Пароль" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item name={['credentials', 'boxId']} label="Box ID" rules={[{ required: true }]}>
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
