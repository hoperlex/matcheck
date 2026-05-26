import { useState } from 'react';
import { Button, Card, Drawer, Form, Input, Space, Typography, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Material, MaterialUpsert } from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';

type List = { items: Material[]; total: number };

export default function MaterialsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [form] = Form.useForm<MaterialUpsert>();

  const list = useQuery({
    queryKey: ['materials', search],
    queryFn: () => api.get<List>(`/materials${search ? `?q=${encodeURIComponent(search)}` : ''}`),
  });

  const create = useMutation({
    mutationFn: (body: MaterialUpsert) => api.post('/materials', body),
    onSuccess: () => {
      message.success('Материал создан');
      setOpen(false);
      form.resetFields();
      void qc.invalidateQueries({ queryKey: ['materials'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  return (
    <StickyPageHeader
      header={
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Typography.Title level={3} style={{ margin: 0 }}>
            Номенклатура
          </Typography.Title>
          <Space>
            <Input.Search placeholder="Название" allowClear onSearch={setSearch} />
            <Button type="primary" onClick={() => setOpen(true)}>
              Добавить
            </Button>
          </Space>
        </Space>
      }
    >
      <ResponsiveTable<Material>
        items={list.data?.items ?? []}
        loading={list.isLoading}
        rowKey="id"
        columns={[
          { title: 'Код', dataIndex: 'code' },
          { title: 'Название', dataIndex: 'name' },
          { title: 'Ед.', dataIndex: 'unit' },
        ]}
        cardRender={(r) => (
          <Card style={{ width: '100%' }} size="small">
            <Space direction="vertical" size={2}>
              <Typography.Text strong>{r.name}</Typography.Text>
              <Typography.Text type="secondary">
                {r.code ?? '—'} · {r.unit}
              </Typography.Text>
            </Space>
          </Card>
        )}
      />
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Новый материал"
        width={420}
        destroyOnClose
      >
        <Form<MaterialUpsert> form={form} layout="vertical" onFinish={(v) => create.mutate(v)}>
          <Form.Item name="code" label="Код">
            <Input />
          </Form.Item>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="unit" label="Единица" initialValue="шт">
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={create.isPending} block size="large">
            Сохранить
          </Button>
        </Form>
      </Drawer>
    </StickyPageHeader>
  );
}
