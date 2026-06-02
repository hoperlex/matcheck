import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Popconfirm,
  Space,
  Switch,
  Tag,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Asset, AssetUpsert } from '@matcheck/contracts';
import { api } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { stringSorter } from '../../shared/ui/tableSorters';
import { DebouncedSearch } from '../../shared/ui/DebouncedSearch';

type List = { items: Asset[]; total: number };

export default function AssetsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [search, setSearch] = useState('');
  const [form] = Form.useForm<AssetUpsert>();
  const role = useAuthStore((s) => s.user?.role);
  const canDelete = role === 'admin';

  const list = useQuery({
    queryKey: ['assets', search],
    queryFn: () => api.get<List>(`/assets${search ? `?q=${encodeURIComponent(search)}` : ''}`),
  });

  function closeDrawer() {
    setOpen(false);
    setEditing(null);
    form.resetFields();
  }

  // Заполняем форму при открытии редактирования; resetFields при создании.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      form.setFieldsValue({
        code: editing.code ?? undefined,
        name: editing.name,
        unit: editing.unit,
        isActive: editing.isActive,
      });
    } else {
      form.resetFields();
      form.setFieldsValue({ unit: 'шт', isActive: true });
    }
  }, [open, editing, form]);

  function openEdit(row: Asset) {
    setEditing(row);
    setOpen(true);
  }

  const save = useMutation({
    mutationFn: async (body: AssetUpsert) => {
      if (editing) {
        return api.patch(`/assets/${editing.id}`, body);
      }
      return api.post('/assets', body);
    },
    onSuccess: () => {
      message.success(editing ? 'ОС сохранено' : 'ОС создано');
      closeDrawer();
      void qc.invalidateQueries({ queryKey: ['assets'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/assets/${id}`),
    onSuccess: () => {
      message.success('ОС удалено');
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
            <DebouncedSearch
              placeholder="Название или код"
              value={search}
              onChange={setSearch}
              style={{ width: 240 }}
            />
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
        onRowClick={openEdit}
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
          ...(canDelete
            ? [
                {
                  title: '',
                  key: 'actions',
                  width: 80,
                  render: (_: unknown, r: Asset) => (
                    <Popconfirm
                      title="Удалить ОС?"
                      description="Действие необратимо. Связанные позиции остаются, но без подтянутого названия."
                      okText="Да, удалить"
                      cancelText="Нет"
                      okButtonProps={{ danger: true }}
                      onConfirm={(e) => {
                        e?.stopPropagation();
                        del.mutate(r.id);
                      }}
                      onCancel={(e) => e?.stopPropagation()}
                    >
                      <Button
                        danger
                        size="small"
                        icon={<DeleteOutlined />}
                        loading={del.isPending && del.variables === r.id}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </Popconfirm>
                  ),
                },
              ]
            : []),
        ]}
        cardRender={(r) => (
          <Card style={{ width: '100%' }} size="small" onClick={() => openEdit(r)}>
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
        onClose={closeDrawer}
        title={editing ? `Редактирование: ${editing.name}` : 'Новое ОС'}
        width={420}
        destroyOnClose
        maskClosable={false}
        keyboard={false}
      >
        <Form<AssetUpsert>
          form={form}
          layout="vertical"
          initialValues={{ unit: 'шт', isActive: true }}
          onFinish={(v) => save.mutate(v)}
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
          <Button type="primary" htmlType="submit" loading={save.isPending} block size="large">
            Сохранить
          </Button>
        </Form>
      </Drawer>
    </StickyPageHeader>
  );
}
