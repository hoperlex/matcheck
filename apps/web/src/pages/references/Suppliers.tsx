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
  Tag,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BulkDeleteResponse, Supplier, SupplierUpsert } from '@matcheck/contracts';
import { api } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { stringSorter } from '../../shared/ui/tableSorters';
import { useBulkSelection } from '../../shared/ui/useBulkSelection';
import { BulkActionInline } from '../../shared/ui/BulkActionInline';
import { DebouncedSearch } from '../../shared/ui/DebouncedSearch';

type List = { items: Supplier[]; total: number };

// Подпись + цвет тега статуса проверки СБ заказчика.
function securityTag(status: string | null) {
  if (status === 'approved') return <Tag color="green">Согласован</Tag>;
  if (status === 'rejected') return <Tag color="red">Отклонён</Tag>;
  return <Typography.Text type="secondary">—</Typography.Text>;
}

export default function SuppliersPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  // null — режим создания, иначе редактируется конкретная запись.
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [search, setSearch] = useState('');
  const [form] = Form.useForm<SupplierUpsert>();

  // Справочник цельный (~1000 строк) — тянем весь, фильтр/сортировка на клиенте
  // через ResponsiveTable. q на сервере оставлен на случай частичной выборки.
  const list = useQuery({
    queryKey: ['suppliers', search],
    queryFn: () =>
      api.get<List>(`/suppliers?limit=5000${search ? `&q=${encodeURIComponent(search)}` : ''}`),
  });

  const create = useMutation({
    mutationFn: (body: SupplierUpsert) => api.post('/suppliers', body),
    onSuccess: () => {
      message.success('Поставщик создан');
      closeDrawer();
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<SupplierUpsert> }) =>
      api.patch(`/suppliers/${id}`, body),
    onSuccess: () => {
      message.success('Поставщик сохранён');
      closeDrawer();
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/suppliers/${id}`),
    onSuccess: () => {
      message.success('Поставщик удалён');
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const role = useAuthStore((s) => s.user?.role);
  const canDelete = role === 'admin';

  const bulk = useBulkSelection<Supplier>((r) => r.id);
  const bulkDel = useMutation({
    mutationFn: (ids: string[]) => api.post<BulkDeleteResponse>('/suppliers/bulk-delete', { ids }),
    onSuccess: (res) => {
      bulk.clear();
      if (res.deleted.length > 0) message.success(`Удалено: ${res.deleted.length}`);
      if (res.skipped.length > 0) {
        message.warning(`Пропущено ${res.skipped.length}: не найдены`);
      }
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  useEffect(() => {
    if (!open) return;
    if (editing) {
      form.setFieldsValue({
        inn: editing.inn || undefined,
        name: editing.name,
        aliases: editing.aliases ?? [],
        lastSecurityStatus:
          editing.lastSecurityStatus === 'approved' || editing.lastSecurityStatus === 'rejected'
            ? editing.lastSecurityStatus
            : undefined,
        foundingDocumentsComment: editing.foundingDocumentsComment ?? undefined,
      });
    } else {
      form.resetFields();
    }
  }, [open, editing, form]);

  function openCreate() {
    setEditing(null);
    setOpen(true);
  }

  function openEdit(row: Supplier) {
    setEditing(row);
    setOpen(true);
  }

  function closeDrawer() {
    setOpen(false);
    setEditing(null);
    form.resetFields();
  }

  function onFinish(values: SupplierUpsert) {
    if (editing) {
      update.mutate({ id: editing.id, body: values });
    } else {
      create.mutate(values);
    }
  }

  const submitting = create.isPending || update.isPending;

  return (
    <StickyPageHeader
      header={
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Typography.Title level={3} style={{ margin: 0 }}>
            Поставщики
          </Typography.Title>
          <Space>
            <DebouncedSearch
              placeholder="ИНН или название"
              value={search}
              onChange={setSearch}
              style={{ width: 260 }}
            />
            {canDelete && (
              <BulkActionInline
                selectedCount={bulk.selectedCount}
                onClear={bulk.clear}
                onDelete={() => bulkDel.mutate(Array.from(bulk.selectedIds))}
                deleting={bulkDel.isPending}
                confirmTitle={`Удалить ${bulk.selectedCount} ${pluralizeSup(bulk.selectedCount)}?`}
              />
            )}
            <Button type="primary" onClick={openCreate}>
              Добавить
            </Button>
          </Space>
        </Space>
      }
    >
      <ResponsiveTable<Supplier>
        items={list.data?.items ?? []}
        loading={list.isLoading}
        rowKey="id"
        numbered
        rowSelection={canDelete ? bulk.selection : undefined}
        onRowClick={openEdit}
        columns={[
          {
            title: 'ИНН',
            dataIndex: 'inn',
            sorter: stringSorter<Supplier>((r) => r.inn || null),
            render: (v: string) => v || '—',
          },
          {
            title: 'Название',
            dataIndex: 'name',
            sorter: stringSorter<Supplier>((r) => r.name),
          },
          {
            title: 'Альтернативные названия',
            dataIndex: 'aliases',
            render: (v: string[] | null | undefined) =>
              v && v.length > 0 ? (
                <Space size={[4, 4]} wrap>
                  {v.map((a) => (
                    <Tag key={a} style={{ marginInlineEnd: 0 }}>
                      {a}
                    </Tag>
                  ))}
                </Space>
              ) : (
                '—'
              ),
          },
          ...(canDelete
            ? [
                {
                  title: '',
                  key: 'actions',
                  width: 80,
                  render: (_: unknown, r: Supplier) => (
                    <Popconfirm
                      title="Удалить поставщика?"
                      description="Действие необратимо."
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
            <Space direction="vertical" size={4}>
              <Typography.Text strong>{r.name}</Typography.Text>
              <Typography.Text type="secondary">ИНН {r.inn || '—'}</Typography.Text>
              <div>{securityTag(r.lastSecurityStatus)}</div>
            </Space>
          </Card>
        )}
      />
      <Drawer
        open={open}
        onClose={closeDrawer}
        title={editing ? 'Поставщик' : 'Новый поставщик'}
        width={420}
        destroyOnClose
        maskClosable={false}
        keyboard={false}
      >
        <Form<SupplierUpsert> form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="inn" label="ИНН (необязательно)">
            <Input />
          </Form.Item>
          <Form.Item
            name="aliases"
            label="Альтернативные названия"
            extra="Введите альтернативное написание и нажмите Enter."
          >
            <Select<string[]>
              mode="tags"
              placeholder="Например: Лютик, ООО «Лютик»"
              tokenSeparators={[',']}
            />
          </Form.Item>
          <Form.Item name="lastSecurityStatus" label="Проверка СБ">
            <Select
              allowClear
              placeholder="Не задан"
              options={[
                { value: 'approved', label: 'Согласован' },
                { value: 'rejected', label: 'Отклонён' },
              ]}
            />
          </Form.Item>
          <Form.Item name="foundingDocumentsComment" label="Комментарий (учредительные документы)">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={submitting} block size="large">
            Сохранить
          </Button>
        </Form>
      </Drawer>
    </StickyPageHeader>
  );
}

// Склонение «поставщик»: 1 поставщик / 2-4 поставщика / 5+ поставщиков.
function pluralizeSup(n: number): string {
  const last = n % 10;
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'поставщиков';
  if (last === 1) return 'поставщика';
  if (last >= 2 && last <= 4) return 'поставщика';
  return 'поставщиков';
}
