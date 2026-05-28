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
import type { Counterparty, CounterpartyUpsert } from '@matcheck/contracts';
import { api } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { stringSorter } from '../../shared/ui/tableSorters';

type List = { items: Counterparty[]; total: number };

export default function CounterpartiesPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  // null — режим создания, иначе редактируется конкретная запись.
  const [editing, setEditing] = useState<Counterparty | null>(null);
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
      closeDrawer();
      void qc.invalidateQueries({ queryKey: ['counterparties'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<CounterpartyUpsert> }) =>
      api.patch(`/counterparties/${id}`, body),
    onSuccess: () => {
      message.success('Контрагент сохранён');
      closeDrawer();
      void qc.invalidateQueries({ queryKey: ['counterparties'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/counterparties/${id}`),
    onSuccess: () => {
      message.success('Контрагент удалён');
      void qc.invalidateQueries({ queryKey: ['counterparties'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const role = useAuthStore((s) => s.user?.role);
  const canDelete = role === 'admin';

  // При открытии Drawer в режиме редактирования заполняем форму данными
  // выбранной строки. resetFields() — для создания, чтобы не было утечки
  // значений от предыдущего открытия.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      form.setFieldsValue({
        inn: editing.inn,
        kpp: editing.kpp,
        name: editing.name,
        address: editing.address ?? undefined,
        isSelf: editing.isSelf,
        isSupplier: editing.isSupplier,
        isCustomer: editing.isCustomer,
        isContractor: editing.isContractor,
      });
    } else {
      form.resetFields();
    }
  }, [open, editing, form]);

  function openCreate() {
    setEditing(null);
    setOpen(true);
  }

  function openEdit(row: Counterparty) {
    setEditing(row);
    setOpen(true);
  }

  function closeDrawer() {
    setOpen(false);
    setEditing(null);
    form.resetFields();
  }

  function onFinish(values: CounterpartyUpsert) {
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
            <Input.Search placeholder="ИНН или название" allowClear onSearch={setSearch} />
            <Button type="primary" onClick={openCreate}>
              Добавить
            </Button>
          </Space>
        </Space>
      }
    >
      <ResponsiveTable<Counterparty>
        items={list.data?.items ?? []}
        loading={list.isLoading}
        rowKey="id"
        numbered
        onRowClick={openEdit}
        columns={[
          {
            title: 'ИНН',
            dataIndex: 'inn',
            sorter: stringSorter<Counterparty>((r) => r.inn),
          },
          {
            title: 'КПП',
            dataIndex: 'kpp',
            sorter: stringSorter<Counterparty>((r) => r.kpp),
          },
          {
            title: 'Название',
            dataIndex: 'name',
            sorter: stringSorter<Counterparty>((r) => r.name),
          },
          {
            title: 'Роли',
            key: 'roles',
            // Сортировка по сумме включённых флагов — «более универсальные»
            // (наш / поставщик / заказчик / подрядчик одновременно) выше.
            sorter: (a: Counterparty, b: Counterparty) => {
              const w = (r: Counterparty) =>
                Number(r.isSelf) + Number(r.isSupplier) + Number(r.isCustomer) + Number(r.isContractor);
              return w(b) - w(a);
            },
            render: (_: unknown, r: Counterparty) => (
              <Space wrap>
                {r.isSelf && <Tag color="purple">Наш</Tag>}
                {r.isSupplier && <Tag color="blue">Поставщик</Tag>}
                {r.isCustomer && <Tag color="green">Заказчик</Tag>}
                {r.isContractor && <Tag color="orange">Подрядчик</Tag>}
              </Space>
            ),
          },
          ...(canDelete
            ? [
                {
                  title: '',
                  key: 'actions',
                  width: 80,
                  render: (_: unknown, r: Counterparty) => (
                    <Popconfirm
                      title="Удалить контрагента?"
                      description="Действие необратимо. Связанные приёмки/отгрузки остаются, но без подтянутого имени."
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
              <Typography.Text type="secondary">
                ИНН {r.inn}
                {r.kpp ? ` · КПП ${r.kpp}` : ''}
              </Typography.Text>
              <Space wrap>
                {r.isSupplier && <Tag color="blue">Поставщик</Tag>}
                {r.isCustomer && <Tag color="green">Заказчик</Tag>}
                {r.isContractor && <Tag color="orange">Подрядчик</Tag>}
              </Space>
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
        <Form<CounterpartyUpsert> form={form} layout="vertical" onFinish={onFinish}>
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
              <Form.Item name="isContractor" valuePropName="checked" noStyle>
                <Switch checkedChildren="Подрядчик" unCheckedChildren="Подрядчик" />
              </Form.Item>
              <Form.Item name="isSelf" valuePropName="checked" noStyle>
                <Switch checkedChildren="Наша" unCheckedChildren="Наша" />
              </Form.Item>
            </Space>
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={submitting} block size="large">
            Сохранить
          </Button>
        </Form>
      </Drawer>
    </StickyPageHeader>
  );
}
