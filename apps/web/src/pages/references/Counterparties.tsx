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
  Switch,
  Tag,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BulkDeleteResponse, Counterparty, CounterpartyUpsert } from '@matcheck/contracts';
import { isPlaceholderInn } from '@matcheck/contracts';
import { api } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { stringSorter } from '../../shared/ui/tableSorters';
import { useBulkSelection } from '../../shared/ui/useBulkSelection';
import { BulkActionInline } from '../../shared/ui/BulkActionInline';
import { DebouncedSearch } from '../../shared/ui/DebouncedSearch';

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

  // Массовое удаление контрагентов.
  const bulk = useBulkSelection<Counterparty>((r) => r.id);
  const bulkDel = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<BulkDeleteResponse>('/counterparties/bulk-delete', { ids }),
    onSuccess: (res) => {
      bulk.clear();
      if (res.deleted.length > 0) message.success(`Удалено: ${res.deleted.length}`);
      if (res.skipped.length > 0) {
        message.warning(`Пропущено ${res.skipped.length}: не найдены или другая причина`);
      }
      void qc.invalidateQueries({ queryKey: ['counterparties'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  // При открытии Drawer в режиме редактирования заполняем форму данными
  // выбранной строки. resetFields() — для создания, чтобы не было утечки
  // значений от предыдущего открытия.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      form.setFieldsValue({
        // Placeholder-ИНН («0000…») в форме показываем пустым полем — у
        // пользователя «нет ИНН»; реальный ИНН может появиться позже от LLM.
        inn: isPlaceholderInn(editing.inn) ? undefined : editing.inn,
        kpp: editing.kpp,
        name: editing.name,
        aliases: editing.aliases ?? [],
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
      <ResponsiveTable<Counterparty>
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
            sorter: stringSorter<Counterparty>((r) =>
              isPlaceholderInn(r.inn) ? null : r.inn,
            ),
            render: (v: string) => (isPlaceholderInn(v) ? '—' : v),
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
            label="ИНН (необязательно)"
            rules={[{ pattern: /^(\d{10}|\d{12})$/, message: '10 или 12 цифр' }]}
            extra="Если оставить пустым, сервер сгенерирует placeholder. Реальный ИНН можно добавить позже."
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
          <Form.Item
            name="aliases"
            label="Альтернативные названия"
            extra="Введите альтернативное написание и нажмите Enter. Используется для поиска и дедупа при «+ Создать» из combobox."
          >
            <Select<string[]>
              mode="tags"
              placeholder="Например: Лютик, ООО «Лютик», ООО Лютик"
              tokenSeparators={[',']}
            />
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

// Склонение «контрагент»: 1 контрагент / 2-4 контрагента / 5+ контрагентов.
function pluralizeCp(n: number): string {
  const last = n % 10;
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'контрагентов';
  if (last === 1) return 'контрагента';
  if (last >= 2 && last <= 4) return 'контрагента';
  return 'контрагентов';
}
