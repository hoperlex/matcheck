import { useState } from 'react';
import {
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Modal,
  Space,
  Switch,
  Tag,
  Typography,
  message,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Counterparty, CounterpartyUpsert } from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';

type List = { items: Counterparty[]; total: number };

export default function CounterpartiesPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [form] = Form.useForm<CounterpartyUpsert>();

  const list = useQuery({
    queryKey: ['counterparties', search],
    queryFn: () =>
      api.get<List>(`/counterparties${search ? `?q=${encodeURIComponent(search)}` : ''}`),
  });

  const create = useMutation({
    mutationFn: (body: CounterpartyUpsert) => api.post('/counterparties', body),
    onSuccess: () => {
      message.success('Контрагент создан');
      setOpen(false);
      form.resetFields();
      void qc.invalidateQueries({ queryKey: ['counterparties'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  return (
    <div>
      <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }} wrap>
        <Typography.Title level={3} style={{ margin: 0 }}>
          Контрагенты
        </Typography.Title>
        <Space>
          <Input.Search placeholder="ИНН или название" allowClear onSearch={setSearch} />
          <Button type="primary" onClick={() => setOpen(true)}>
            Добавить
          </Button>
        </Space>
      </Space>
      <ResponsiveTable<Counterparty>
        items={list.data?.items ?? []}
        loading={list.isLoading}
        rowKey="id"
        columns={[
          { title: 'ИНН', dataIndex: 'inn' },
          { title: 'КПП', dataIndex: 'kpp' },
          { title: 'Название', dataIndex: 'name' },
          {
            title: 'Роли',
            key: 'roles',
            render: (_: unknown, r: Counterparty) => (
              <Space wrap>
                {r.isSelf && <Tag color="purple">Наш</Tag>}
                {r.isSupplier && <Tag color="blue">Поставщик</Tag>}
                {r.isCustomer && <Tag color="green">Заказчик</Tag>}
                {r.isCarrier && <Tag color="orange">Перевозчик</Tag>}
              </Space>
            ),
          },
        ]}
        cardRender={(r) => (
          <Card style={{ width: '100%' }} size="small">
            <Space direction="vertical" size={4}>
              <Typography.Text strong>{r.name}</Typography.Text>
              <Typography.Text type="secondary">
                ИНН {r.inn}
                {r.kpp ? ` · КПП ${r.kpp}` : ''}
              </Typography.Text>
              <Space wrap>
                {r.isSupplier && <Tag color="blue">Поставщик</Tag>}
                {r.isCustomer && <Tag color="green">Заказчик</Tag>}
                {r.isCarrier && <Tag color="orange">Перевозчик</Tag>}
              </Space>
            </Space>
          </Card>
        )}
      />
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Новый контрагент"
        width={420}
        destroyOnClose
      >
        <Form<CounterpartyUpsert>
          form={form}
          layout="vertical"
          onFinish={(values) => create.mutate(values)}
        >
          <Form.Item
            name="inn"
            label="ИНН"
            rules={[{ required: true, pattern: /^(\d{10}|\d{12})$/ }]}
          >
            <Input inputMode="numeric" />
          </Form.Item>
          <Form.Item
            name="kpp"
            label="КПП (если есть)"
            rules={[{ pattern: /^\d{9}$/, message: '9 цифр' }]}
          >
            <Input inputMode="numeric" />
          </Form.Item>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="address" label="Адрес">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item label="Роли">
            <Space direction="vertical">
              <Form.Item name="isSupplier" valuePropName="checked" noStyle>
                <Switch checkedChildren="Поставщик" unCheckedChildren="Поставщик" />
              </Form.Item>
              <Form.Item name="isCustomer" valuePropName="checked" noStyle>
                <Switch checkedChildren="Заказчик" unCheckedChildren="Заказчик" />
              </Form.Item>
              <Form.Item name="isCarrier" valuePropName="checked" noStyle>
                <Switch checkedChildren="Перевозчик" unCheckedChildren="Перевозчик" />
              </Form.Item>
              <Form.Item name="isSelf" valuePropName="checked" noStyle>
                <Switch checkedChildren="Наша" unCheckedChildren="Наша" />
              </Form.Item>
            </Space>
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={create.isPending} block size="large">
            Сохранить
          </Button>
        </Form>
      </Drawer>
      <Modal open={false} onCancel={() => undefined} footer={null} />
    </div>
  );
}
