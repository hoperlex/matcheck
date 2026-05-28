import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Popconfirm,
  Space,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Material, MaterialUpsert } from '@matcheck/contracts';
import { api } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { stringSorter } from '../../shared/ui/tableSorters';

type List = { items: Material[]; total: number };

export default function MaterialsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Material | null>(null);
  const [search, setSearch] = useState('');
  const [form] = Form.useForm<MaterialUpsert>();
  const role = useAuthStore((s) => s.user?.role);
  const canDelete = role === 'admin';

  const list = useQuery({
    queryKey: ['materials', search],
    queryFn: () => api.get<List>(`/materials${search ? `?q=${encodeURIComponent(search)}` : ''}`),
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
      });
    } else {
      form.resetFields();
    }
  }, [open, editing, form]);

  function openEdit(row: Material) {
    setEditing(row);
    setOpen(true);
  }

  const save = useMutation({
    mutationFn: async (body: MaterialUpsert) => {
      if (editing) {
        return api.patch(`/materials/${editing.id}`, body);
      }
      return api.post('/materials', body);
    },
    onSuccess: () => {
      message.success(editing ? 'Материал сохранён' : 'Материал создан');
      closeDrawer();
      void qc.invalidateQueries({ queryKey: ['materials'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/materials/${id}`),
    onSuccess: () => {
      message.success('Материал удалён');
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
        numbered
        onRowClick={openEdit}
        columns={[
          { title: 'Код', dataIndex: 'code', sorter: stringSorter<Material>((r) => r.code) },
          { title: 'Название', dataIndex: 'name', sorter: stringSorter<Material>((r) => r.name) },
          { title: 'Ед.', dataIndex: 'unit', sorter: stringSorter<Material>((r) => r.unit) },
          ...(canDelete
            ? [
                {
                  title: '',
                  key: 'actions',
                  width: 80,
                  render: (_: unknown, r: Material) => (
                    <Popconfirm
                      title="Удалить материал?"
                      description="Действие необратимо. Связанные позиции в УПД/приёмках/отгрузках остаются, но без подтянутого названия."
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
        onClose={closeDrawer}
        title={editing ? `Редактирование: ${editing.name}` : 'Новый материал'}
        width={420}
        destroyOnClose
        maskClosable={false}
        keyboard={false}
      >
        <Form<MaterialUpsert> form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <Form.Item name="code" label="Код">
            <Input />
          </Form.Item>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="unit" label="Единица" initialValue="шт">
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={save.isPending} block size="large">
            Сохранить
          </Button>
        </Form>
      </Drawer>
    </StickyPageHeader>
  );
}
