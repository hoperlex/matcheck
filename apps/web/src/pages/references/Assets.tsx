import { useState } from 'react';
import {
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Space,
  Switch,
  Tag,
  Typography,
  message,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Asset, AssetUpsert } from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { stringSorter } from '../../shared/ui/tableSorters';

type List = { items: Asset[]; total: number };

export default function AssetsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [form] = Form.useForm<AssetUpsert>();

  const list = useQuery({
    queryKey: ['assets', search],
    queryFn: () => api.get<List>(`/assets${search ? `?q=${encodeURIComponent(search)}` : ''}`),
  });

  const create = useMutation({
    mutationFn: (body: AssetUpsert) => api.post('/assets', body),
    onSuccess: () => {
      message.success('ОС создано');
      setOpen(false);
      form.resetFields();
      void qc.invalidateQueries({ queryKey: ['assets'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  return (
    <StickyPageHeader
      header={
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Typography.Title level={3} style={{ margin: 0 }}>
            ОС (основные средства)
          </Typography.Title>
          <Space>
            <Input.Search placeholder="Название или код" allowClear onSearch={setSearch} />
            <Button type="primary" onClick={() => setOpen(true)}>
              Добавить
            </Button>
          </Space>
        </Space>
      }
    >
      <ResponsiveTable<Asset>
        items={list.data?.items ?? []}
        loading={list.isLoading}
        rowKey="id"
        numbered
        columns={[
          { title: 'Код', dataIndex: 'code', sorter: stringSorter<Asset>((r) => r.code) },
          { title: 'Название', dataIndex: 'name', sorter: stringSorter<Asset>((r) => r.name) },
          { title: 'Ед.', dataIndex: 'unit', sorter: stringSorter<Asset>((r) => r.unit) },
          {
            title: 'Статус',
            key: 'status',
            sorter: (a: Asset, b: Asset) => Number(b.isActive) - Number(a.isActive),
            render: (_: unknown, r: Asset) =>
              r.isActive ? (
                <Tag color="green">Активный</Tag>
              ) : (
                <Tag color="default">В архиве</Tag>
              ),
          },
        ]}
        cardRender={(r) => (
          <Card style={{ width: '100%' }} size="small">
            <Space direction="vertical" size={2}>
              <Space wrap>
                <Tag color="purple">ОС</Tag>
                <Typography.Text strong>{r.name}</Typography.Text>
              </Space>
              <Typography.Text type="secondary">
                {r.code ?? '—'} · {r.unit}
              </Typography.Text>
              {!r.isActive && <Tag color="default">В архиве</Tag>}
            </Space>
          </Card>
        )}
      />
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Новое ОС"
        width={420}
        destroyOnClose
        maskClosable={false}
        keyboard={false}
      >
        <Form<AssetUpsert>
          form={form}
          layout="vertical"
          initialValues={{ unit: 'шт', isActive: true }}
          onFinish={(v) => create.mutate(v)}
        >
          <Form.Item name="code" label="Код">
            <Input />
          </Form.Item>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="unit" label="Единица">
            <Input />
          </Form.Item>
          <Form.Item name="isActive" label="Активный" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={create.isPending} block size="large">
            Сохранить
          </Button>
        </Form>
      </Drawer>
    </StickyPageHeader>
  );
}
