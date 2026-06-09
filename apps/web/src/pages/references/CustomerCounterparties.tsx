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
import type {
  BulkDeleteResponse,
  CustomerCounterparty,
  CustomerCounterpartyUpsert,
} from '@matcheck/contracts';
import { api } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { stringSorter } from '../../shared/ui/tableSorters';
import { useBulkSelection } from '../../shared/ui/useBulkSelection';
import { BulkActionInline } from '../../shared/ui/BulkActionInline';
import { DebouncedSearch } from '../../shared/ui/DebouncedSearch';

type List = { items: CustomerCounterparty[]; total: number };

export default function CustomerCounterpartiesPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  // null — режим создания, иначе редактируется конкретная запись.
  const [editing, setEditing] = useState<CustomerCounterparty | null>(null);
  const [search, setSearch] = useState('');
  const [form] = Form.useForm<CustomerCounterpartyUpsert>();

  const list = useQuery({
    queryKey: ['customer-counterparties', search],
    queryFn: () =>
      api.get<List>(
        `/customer-counterparties?limit=5000${search ? `&q=${encodeURIComponent(search)}` : ''}`,
      ),
  });

  const create = useMutation({
    mutationFn: (body: CustomerCounterpartyUpsert) => api.post('/customer-counterparties', body),
    onSuccess: () => {
      message.success('Контрагент создан');
      closeDrawer();
      void qc.invalidateQueries({ queryKey: ['customer-counterparties'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<CustomerCounterpartyUpsert> }) =>
      api.patch(`/customer-counterparties/${id}`, body),
    onSuccess: () => {
      message.success('Контрагент сохранён');
      closeDrawer();
      void qc.invalidateQueries({ queryKey: ['customer-counterparties'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/customer-counterparties/${id}`),
    onSuccess: () => {
      message.success('Контрагент удалён');
      void qc.invalidateQueries({ queryKey: ['customer-counterparties'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const role = useAuthStore((s) => s.user?.role);
  const canDelete = role === 'admin';

  const bulk = useBulkSelection<CustomerCounterparty>((r) => r.id);
  const bulkDel = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<BulkDeleteResponse>('/customer-counterparties/bulk-delete', { ids }),
    onSuccess: (res) => {
      bulk.clear();
      if (res.deleted.length > 0) message.success(`Удалено: ${res.deleted.length}`);
      if (res.skipped.length > 0) {
        message.warning(`Пропущено ${res.skipped.length}: не найдены`);
      }
      void qc.invalidateQueries({ queryKey: ['customer-counterparties'] });
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
        address: editing.address ?? undefined,
      });
    } else {
      form.resetFields();
    }
  }, [open, editing, form]);

  function openCreate() {
    setEditing(null);
    setOpen(true);
  }

  function openEdit(row: CustomerCounterparty) {
    setEditing(row);
    setOpen(true);
  }

  function closeDrawer() {
    setOpen(false);
    setEditing(null);
    form.resetFields();
  }

  function onFinish(values: CustomerCounterpartyUpsert) {
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
            Контрагенты
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
                confirmTitle={`Удалить ${bulk.selectedCount} ${pluralizeCp(bulk.selectedCount)}?`}
              />
            )}
            <Button type="primary" onClick={openCreate}>
              Добавить
            </Button>
          </Space>
        </Space>
      }
    >
      <ResponsiveTable<CustomerCounterparty>
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
            sorter: stringSorter<CustomerCounterparty>((r) => r.inn || null),
            render: (v: string) => v || '—',
          },
          {
            title: 'Название',
            dataIndex: 'name',
            sorter: stringSorter<CustomerCounterparty>((r) => r.name),
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
          {
            title: 'Адрес',
            dataIndex: 'address',
            sorter: stringSorter<CustomerCounterparty>((r) => r.address),
            render: (v: string | null) =>
              v ? (
                <Typography.Text>{v}</Typography.Text>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
          },
          ...(canDelete
            ? [
                {
                  title: '',
                  key: 'actions',
                  width: 80,
                  render: (_: unknown, r: CustomerCounterparty) => (
                    <Popconfirm
                      title="Удалить контрагента?"
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
              {r.address && <Typography.Text type="secondary">{r.address}</Typography.Text>}
            </Space>
          </Card>
        )}
      />
      <Drawer
        open={open}
        onClose={closeDrawer}
        title={editing ? 'Контрагент' : 'Новый контрагент'}
        width={420}
        destroyOnClose
        maskClosable={false}
        keyboard={false}
      >
        <Form<CustomerCounterpartyUpsert> form={form} layout="vertical" onFinish={onFinish}>
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
          <Form.Item name="address" label="Адрес">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={submitting} block size="large">
            Сохранить
          </Button>
        </Form>
      </Drawer>
    </StickyPageHeader>
  );
}

// Склонение «контрагент»: 1 контрагент / 2-4 контрагента / 5+ контрагентов.
function pluralizeCp(n: number): string {
  const last = n % 10;
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'контрагентов';
  if (last === 1) return 'контрагента';
  if (last >= 2 && last <= 4) return 'контрагента';
  return 'контрагентов';
}
