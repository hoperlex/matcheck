import { useState } from 'react';
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Site, SiteUpsert } from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { stringSorter } from '../../shared/ui/tableSorters';
import { useAuthStore } from '../../stores/auth';

const SYSTEM_SITE_ID = '00000000-0000-0000-0000-000000000001';

type List = { items: Site[]; total: number };

export default function SitesPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Site | null>(null);
  const [search, setSearch] = useState('');
  const [form] = Form.useForm<SiteUpsert>();
  const role = useAuthStore((s) => s.user?.role);
  const canEdit = role === 'admin' || role === 'manager';
  const canDelete = role === 'admin';

  const list = useQuery({
    queryKey: ['sites', search],
    queryFn: () => api.get<List>(`/sites${search ? `?q=${encodeURIComponent(search)}` : ''}`),
  });

  const save = useMutation({
    mutationFn: async (body: SiteUpsert) => {
      if (editing) return api.patch(`/sites/${editing.id}`, body);
      return api.post('/sites', body);
    },
    onSuccess: () => {
      message.success(editing ? 'Объект обновлён' : 'Объект создан');
      setOpen(false);
      setEditing(null);
      form.resetFields();
      void qc.invalidateQueries({ queryKey: ['sites'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/sites/${id}`),
    onSuccess: () => {
      message.success('Объект удалён');
      void qc.invalidateQueries({ queryKey: ['sites'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  function openCreate() {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ isActive: true });
    setOpen(true);
  }

  function openEdit(s: Site) {
    setEditing(s);
    form.setFieldsValue({
      code: s.code,
      name: s.name,
      fullName: s.fullName ?? undefined,
      address: s.address ?? undefined,
      isActive: s.isActive,
    });
    setOpen(true);
  }

  return (
    <StickyPageHeader
      header={
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Space>
            <Input.Search placeholder="Код или название" allowClear onSearch={setSearch} />
          </Space>
          {canEdit && (
            <Button type="primary" onClick={openCreate}>
              Добавить объект
            </Button>
          )}
        </Space>
      }
    >
      <ResponsiveTable<Site>
        items={list.data?.items ?? []}
        loading={list.isLoading}
        rowKey="id"
        numbered
        onRowClick={(r) => canEdit && r.id !== SYSTEM_SITE_ID && openEdit(r)}
        columns={[
          {
            title: 'Код',
            dataIndex: 'code',
            width: 100,
            sorter: stringSorter<Site>((r) => r.code),
          },
          {
            title: 'Название',
            dataIndex: 'name',
            sorter: stringSorter<Site>((r) => r.name),
          },
          {
            title: 'Полное название',
            dataIndex: 'fullName',
            sorter: stringSorter<Site>((r) => r.fullName),
            render: (v) => v ?? '—',
          },
          {
            title: 'Адрес',
            dataIndex: 'address',
            sorter: stringSorter<Site>((r) => r.address),
            render: (v) => v ?? '—',
          },
          {
            title: 'Активен',
            dataIndex: 'isActive',
            width: 110,
            sorter: (a: Site, b: Site) => Number(b.isActive) - Number(a.isActive),
            render: (v: boolean) => (v ? <Tag color="green">Да</Tag> : <Tag>Нет</Tag>),
          },
          ...(canDelete
            ? [
                {
                  title: '',
                  key: 'actions',
                  width: 80,
                  render: (_: unknown, r: Site) =>
                    r.id !== SYSTEM_SITE_ID && (
                      <Popconfirm
                        title="Удалить объект?"
                        okText="Да"
                        cancelText="Нет"
                        onConfirm={(e) => {
                          e?.stopPropagation();
                          del.mutate(r.id);
                        }}
                        onCancel={(e) => e?.stopPropagation()}
                      >
                        <Button
                          danger
                          size="small"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Удалить
                        </Button>
                      </Popconfirm>
                    ),
                },
              ]
            : []),
        ]}
        cardRender={(r) => (
          <Card style={{ width: '100%' }} size="small" onClick={() => canEdit && r.id !== SYSTEM_SITE_ID && openEdit(r)}>
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Space>
                <Typography.Text strong>{r.code}</Typography.Text>
                <Typography.Text>{r.name}</Typography.Text>
                {!r.isActive && <Tag>Не активен</Tag>}
              </Space>
              {r.fullName && <Typography.Text type="secondary">{r.fullName}</Typography.Text>}
              {r.address && <Typography.Text type="secondary">{r.address}</Typography.Text>}
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
        title={editing ? `Объект ${editing.code}` : 'Новый объект'}
        width={420}
        destroyOnClose
        maskClosable={false}
        keyboard={false}
      >
        <Form<SiteUpsert>
          form={form}
          layout="vertical"
          onFinish={(values) => save.mutate(values)}
          initialValues={{ isActive: true }}
        >
          <Form.Item
            name="code"
            label="Код (до 5 символов)"
            rules={[
              { required: true, message: 'Обязательно' },
              { max: 5, message: 'Не более 5 символов' },
              {
                pattern: /^[A-Za-zА-Яа-я0-9_-]+$/,
                message: 'Только буквы, цифры, тире и подчёркивание',
              },
            ]}
          >
            <Input placeholder="например, A1" maxLength={5} />
          </Form.Item>
          <Form.Item name="name" label="Название" rules={[{ required: true, max: 500 }]}>
            <Input placeholder="ЖК «Северный»" />
          </Form.Item>
          <Form.Item name="fullName" label="Полное название">
            <Input.TextArea rows={2} maxLength={1000} />
          </Form.Item>
          <Form.Item name="address" label="Адрес">
            <Input.TextArea rows={2} maxLength={1000} />
          </Form.Item>
          <Form.Item name="isActive" label="Активен" valuePropName="checked">
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
