import { useState } from 'react';
import {
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Switch,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BulkDeleteResponse,
  Unit,
  UnitUpsert,
} from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { stringSorter } from '../../shared/ui/tableSorters';
import { useAuthStore } from '../../stores/auth';
import { useBulkSelection } from '../../shared/ui/useBulkSelection';
import { BulkActionInline } from '../../shared/ui/BulkActionInline';
import { DebouncedSearch } from '../../shared/ui/DebouncedSearch';

type List = { items: Unit[]; total: number };

function pluralizeUnit(n: number): string {
  const last = n % 10;
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'единиц';
  if (last === 1) return 'единицу';
  if (last >= 2 && last <= 4) return 'единицы';
  return 'единиц';
}

export default function UnitsPage(): JSX.Element {
  const qc = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const canEdit = role === 'admin' || role === 'manager';
  const canDelete = role === 'admin';

  const [editing, setEditing] = useState<Unit | null>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [form] = Form.useForm<UnitUpsert>();

  const list = useQuery({
    queryKey: ['units', search],
    queryFn: () =>
      api.get<List>(`/units${search ? `?q=${encodeURIComponent(search)}` : ''}`),
  });

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ code: '', name: '', okeiCode: null, isActive: true });
    setOpen(true);
  };
  const openEdit = (u: Unit) => {
    setEditing(u);
    form.resetFields();
    form.setFieldsValue({
      code: u.code,
      name: u.name,
      okeiCode: u.okeiCode,
      isActive: u.isActive,
    });
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: async (body: UnitUpsert) => {
      if (editing) return api.patch<Unit>(`/units/${editing.id}`, body);
      return api.post<Unit>('/units', body);
    },
    onSuccess: () => {
      message.success(editing ? 'Единица обновлена' : 'Единица создана');
      setOpen(false);
      setEditing(null);
      form.resetFields();
      void qc.invalidateQueries({ queryKey: ['units'] });
      void qc.invalidateQueries({ queryKey: ['references-counts'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/units/${id}`),
    onSuccess: () => {
      message.success('Удалено');
      void qc.invalidateQueries({ queryKey: ['units'] });
      void qc.invalidateQueries({ queryKey: ['references-counts'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const bulk = useBulkSelection<Unit>((r) => r.id);
  const bulkDel = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<BulkDeleteResponse>('/units/bulk-delete', { ids }),
    onSuccess: (res) => {
      bulk.clear();
      if (res.deleted.length > 0) message.success(`Удалено: ${res.deleted.length}`);
      if (res.skipped.length > 0) message.warning(`Пропущено: ${res.skipped.length}`);
      void qc.invalidateQueries({ queryKey: ['units'] });
      void qc.invalidateQueries({ queryKey: ['references-counts'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  return (
    <StickyPageHeader
      header={
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Space>
            <Typography.Title level={3} style={{ margin: 0 }}>
              Единицы измерения
            </Typography.Title>
            <DebouncedSearch
              placeholder="Код или название"
              value={search}
              onChange={setSearch}
              style={{ width: 240 }}
            />
          </Space>
          <Space>
            {canDelete && (
              <BulkActionInline
                selectedCount={bulk.selectedCount}
                onClear={bulk.clear}
                onDelete={() => bulkDel.mutate(Array.from(bulk.selectedIds))}
                deleting={bulkDel.isPending}
                confirmTitle={`Удалить ${bulk.selectedCount} ${pluralizeUnit(bulk.selectedCount)}?`}
              />
            )}
            {canEdit && (
              <Button type="primary" onClick={openCreate}>
                Добавить
              </Button>
            )}
          </Space>
        </Space>
      }
    >
      <ResponsiveTable<Unit>
        items={list.data?.items ?? []}
        loading={list.isLoading}
        rowKey="id"
        numbered
        rowSelection={canDelete ? bulk.selection : undefined}
        onRowClick={canEdit ? openEdit : undefined}
        cardRender={(u) => (
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <Typography.Text strong>{u.code}</Typography.Text>
            <Typography.Text type="secondary">{u.name}</Typography.Text>
            {u.okeiCode && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                ОКЕИ {u.okeiCode}
              </Typography.Text>
            )}
          </Space>
        )}
        columns={[
          {
            title: 'Код',
            dataIndex: 'code',
            sorter: stringSorter<Unit>((r) => r.code),
            width: 120,
          },
          {
            title: 'Название',
            dataIndex: 'name',
            sorter: stringSorter<Unit>((r) => r.name),
          },
          {
            title: 'ОКЕИ',
            dataIndex: 'okeiCode',
            width: 100,
            render: (v: string | null) => v || '—',
          },
          {
            title: 'Активна',
            dataIndex: 'isActive',
            width: 100,
            render: (v: boolean) => (v ? 'да' : 'нет'),
          },
          ...(canDelete
            ? [
                {
                  title: '',
                  key: 'actions',
                  width: 60,
                  render: (_: unknown, r: Unit) => (
                    <Popconfirm
                      title="Удалить единицу?"
                      okText="Да"
                      cancelText="Нет"
                      okButtonProps={{ danger: true }}
                      onConfirm={(e) => {
                        e?.stopPropagation();
                        del.mutate(r.id);
                      }}
                      onCancel={(e) => e?.stopPropagation()}
                    >
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </Popconfirm>
                  ),
                },
              ]
            : []),
        ]}
      />

      <Modal
        open={open}
        title={editing ? 'Единица измерения' : 'Новая единица'}
        onCancel={() => {
          setOpen(false);
          setEditing(null);
        }}
        onOk={() => form.submit()}
        okText={editing ? 'Сохранить' : 'Создать'}
        confirmLoading={save.isPending}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => save.mutate(v)}
          initialValues={{ isActive: true }}
        >
          <Form.Item
            name="code"
            label="Код (короткая форма)"
            extra="Короткое обозначение, как в позициях УПД: «шт», «кг», «м³»."
            rules={[{ required: true, message: 'Заполните код' }]}
          >
            <Input maxLength={32} placeholder="шт" />
          </Form.Item>
          <Form.Item
            name="name"
            label="Полное название"
            rules={[{ required: true, message: 'Заполните название' }]}
          >
            <Input maxLength={128} placeholder="Штука" />
          </Form.Item>
          <Form.Item
            name="okeiCode"
            label="Код ОКЕИ"
            extra="Опционально. Общероссийский классификатор единиц измерения (например, 796 = шт, 166 = кг)."
          >
            <Input maxLength={8} placeholder="796" />
          </Form.Item>
          <Form.Item name="isActive" label="Активна" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </StickyPageHeader>
  );
}
