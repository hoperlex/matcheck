import { useEffect, useState } from 'react';
import { Button, Card, Drawer, Form, Input, Popconfirm, Space, Typography, message } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Material, MaterialUpsert } from '@matcheck/contracts';
import { api } from '../../services/api';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { stringSorter } from '../../shared/ui/tableSorters';
import { DebouncedSearch } from '../../shared/ui/DebouncedSearch';

type List = { items: Material[]; total: number };

export default function MaterialsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Material | null>(null);
  const [search, setSearch] = useState('');
  const [form] = Form.useForm<MaterialUpsert>();
  // Права страницы. До включения матрицы значения те же, что были у ролей
  // (правит manager, удаляет admin) — так задан дефолт в PAGE_CATALOG.
  // «Создавать» и «Редактировать» разведены: раньше обе кнопки жили на одном
  // флаге, и действие «Создавать» в матрице оказалось бы мёртвым.
  const { can } = usePermissions();
  const canCreate = can('references.materials', 'create');
  const canEdit = can('references.materials', 'edit');
  const canDelete = can('references.materials', 'delete');

  // Серверная пагинация. Справочник большой (тысячи позиций), а сервер по
  // умолчанию отдавал 50 строк: таблица показывала первую полусотню по алфавиту
  // и рисовала одну страницу — «есть ли уже такая позиция» проверить было
  // нельзя, поиск точно так же обрывался на 50 совпадениях.
  const PAGE_SIZE = 100;
  const [page, setPage] = useState(1);
  // Новый запрос — всегда с первой страницы: иначе после сужения поиска
  // пользователь остаётся на седьмой странице пустого результата.
  useEffect(() => {
    setPage(1);
  }, [search]);
  const list = useQuery({
    queryKey: ['materials', { search, page, pageSize: PAGE_SIZE }],
    queryFn: () => {
      const qs = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String((page - 1) * PAGE_SIZE),
      });
      if (search) qs.set('q', search);
      return api.get<List>(`/materials?${qs.toString()}`);
    },
    placeholderData: keepPreviousData,
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
            <DebouncedSearch
              placeholder="Название"
              value={search}
              onChange={setSearch}
              style={{ width: 240 }}
            />
            {canCreate && (
              <Button type="primary" onClick={() => setOpen(true)}>
                Добавить
              </Button>
            )}
          </Space>
        </Space>
      }
    >
      <ResponsiveTable<Material>
        items={list.data?.items ?? []}
        loading={list.isLoading}
        rowKey="id"
        numbered
        numberedOffset={(page - 1) * PAGE_SIZE}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: list.data?.total ?? 0,
          onChange: setPage,
          showSizeChanger: false,
          showTotal: (total) => `Всего: ${total}`,
        }}
        onRowClick={canEdit ? openEdit : undefined}
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
          <Card style={{ width: '100%' }} size="small" onClick={() => canEdit && openEdit(r)}>
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
