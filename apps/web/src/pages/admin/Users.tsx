import { Select, Switch, Tag, Typography, Space, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UserDto, UserRole } from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';

const roles: UserRole[] = ['admin', 'manager', 'inspector_kpp'];

export default function AdminUsersPage() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api.get<UserDto[]>('/admin/users'),
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { role?: UserRole; isActive?: boolean } }) =>
      api.patch(`/admin/users/${id}`, body),
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  return (
    <div>
      <Typography.Title level={3}>Пользователи</Typography.Title>
      <ResponsiveTable<UserDto>
        items={list.data ?? []}
        loading={list.isLoading}
        rowKey="id"
        columns={[
          { title: 'Email', dataIndex: 'email' },
          {
            title: 'Роль',
            dataIndex: 'role',
            render: (r: UserRole, row: UserDto) => (
              <Select
                value={r}
                style={{ width: 160 }}
                onChange={(v) => patch.mutate({ id: row.id, body: { role: v } })}
                options={roles.map((rl) => ({ value: rl, label: rl }))}
              />
            ),
          },
          {
            title: 'Активен',
            dataIndex: 'isActive',
            render: (a: boolean, row: UserDto) => (
              <Switch
                checked={a}
                onChange={(v) => patch.mutate({ id: row.id, body: { isActive: v } })}
              />
            ),
          },
          { title: 'Создан', dataIndex: 'createdAt' },
        ]}
        cardRender={(u) => (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Text strong>{u.email}</Typography.Text>
            <Space>
              <Tag>{u.role}</Tag>
              {u.isActive ? <Tag color="green">активен</Tag> : <Tag color="red">не активен</Tag>}
            </Space>
          </Space>
        )}
      />
    </div>
  );
}
