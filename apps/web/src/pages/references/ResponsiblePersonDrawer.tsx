import { useEffect, useState } from 'react';
import { Alert, Button, Drawer, Form, Input, Space, Switch, Typography, message } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  ResponsiblePerson,
  ResponsiblePersonConflict,
  ResponsiblePersonCreateResponse,
  ResponsiblePersonUpsert,
} from '@matcheck/contracts';
import { api, ApiError } from '../../services/api';

/** 409 сервера по МОЛ с записью-тёзкой (mol_archived / mol_name_taken). */
function conflictOf(err: unknown): ResponsiblePersonConflict | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const p = err.payload as Partial<ResponsiblePersonConflict> | undefined;
  if ((p?.error === 'mol_archived' || p?.error === 'mol_name_taken') && p.existing) {
    return p as ResponsiblePersonConflict;
  }
  return null;
}

/**
 * Шторка создания и правки ручного МОЛ — общая для Справочники → МОЛ и
 * скрытой страницы «Ответственные лица».
 *
 * Создание: переключателя «Активный» нет — новая запись всегда активна. Что
 * произошло, говорит сервер (`outcome`), а не кэш списка: при первом открытии
 * вкладки кэша может не быть, а после обновления в нём уже и новая запись.
 * Если ручной тёзка лежит в архиве, сервер отвечает 409 и ничего не меняет:
 * вернуть запись — правка (PATCH), кнопка видна только с правом «edit».
 */
export function ResponsiblePersonDrawer({
  open,
  editing,
  canEdit,
  onClose,
}: {
  open: boolean;
  /** null — создание новой записи. */
  editing: ResponsiblePerson | null;
  canEdit: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form] = Form.useForm<ResponsiblePersonUpsert>();
  const [archived, setArchived] = useState<ResponsiblePerson | null>(null);

  useEffect(() => {
    if (!open) return;
    setArchived(null);
    if (editing) {
      form.setFieldsValue({
        fullName: editing.fullName,
        position: editing.position ?? undefined,
        phone: editing.phone ?? undefined,
        isActive: editing.isActive,
      });
    } else {
      form.resetFields();
    }
  }, [open, editing, form]);

  const done = (text: string, kind: 'success' | 'info' = 'success') => {
    message[kind](text);
    void qc.invalidateQueries({ queryKey: ['responsible-persons'] });
    onClose();
  };

  const save = useMutation({
    mutationFn: async (values: ResponsiblePersonUpsert) => {
      if (editing) {
        await api.patch<ResponsiblePerson>(`/responsible-persons/${editing.id}`, values);
        return null;
      }
      const { isActive: _ignored, ...body } = values;
      return api.post<ResponsiblePersonCreateResponse>('/responsible-persons', body);
    },
    onSuccess: (res) => {
      if (!res) return done('МОЛ сохранён');
      if (res.outcome === 'existing') return done(`Уже есть в справочнике: ${res.fullName}`, 'info');
      return done('МОЛ добавлен');
    },
    onError: (err: Error) => {
      const conflict = conflictOf(err);
      if (conflict?.error === 'mol_archived') {
        setArchived(conflict.existing);
        return;
      }
      message.error(err.message);
    },
  });

  const restore = useMutation({
    mutationFn: (id: string) =>
      api.patch<ResponsiblePerson>(`/responsible-persons/${id}`, { isActive: true }),
    onSuccess: (rec) => done(`МОЛ «${rec.fullName}» возвращён из архива`),
    onError: (err: Error) => message.error(err.message),
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={editing ? `Редактирование: ${editing.fullName}` : 'Новый МОЛ'}
      width={420}
      destroyOnClose
      maskClosable={false}
      keyboard={false}
    >
      <Form<ResponsiblePersonUpsert>
        form={form}
        layout="vertical"
        onFinish={(values) => save.mutate(values)}
        onValuesChange={() => setArchived(null)}
      >
        <Form.Item
          name="fullName"
          label="ФИО"
          rules={[{ required: true, whitespace: true, message: 'Укажите ФИО' }]}
        >
          <Input />
        </Form.Item>
        <Form.Item name="position" label="Должность">
          <Input />
        </Form.Item>
        <Form.Item name="phone" label="Телефон">
          <Input inputMode="tel" />
        </Form.Item>
        {editing && (
          <Form.Item
            name="isActive"
            label="Активный"
            valuePropName="checked"
            extra="Выключенный МОЛ уходит в архив: пропадает из списков выбора, в оформленных документах остаётся."
          >
            <Switch />
          </Form.Item>
        )}
        {archived && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message={`«${archived.fullName}» есть в справочнике, но в архиве`}
            description={
              canEdit ? (
                <Space direction="vertical" size={8}>
                  <span>Новую запись заводить не нужно — верните эту.</span>
                  <Button
                    size="small"
                    loading={restore.isPending}
                    onClick={() => restore.mutate(archived.id)}
                  >
                    Вернуть из архива
                  </Button>
                </Space>
              ) : (
                <Typography.Text>
                  Вернуть её может пользователь с правом редактирования справочника МОЛ.
                </Typography.Text>
              )
            }
          />
        )}
        <Button type="primary" htmlType="submit" loading={save.isPending} block size="large">
          Сохранить
        </Button>
      </Form>
    </Drawer>
  );
}
