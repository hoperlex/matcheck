import { Select, Switch, Tag, Typography, Space, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Site, UserAdminPatch, UserDto, UserRole } from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';

const roles: UserRole[] = ['admin', 'manager', 'inspector_kpp'];

export default function AdminUsersPage() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api.get<UserDto[]>('/admin/users'),
  });
  const sitesQuery = useQuery({
    queryKey: ['sites', 'active'],
    queryFn: () => api.get<{ items: Site[]; total: number }>('/sites?activeOnly=true&limit=500'),
  });
  const sites = sitesQuery.data?.items ?? [];
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UserAdminPatch }) =>
      api.patch(`/admin/users/${id}`, body),
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const renderSiteCell = (row: UserDto) => {
    if (row.role !== 'inspector_kpp') {
      return <Typography.Text type="secondary">—</Typography.Text>;
    }
    return (
      <Select<string>
        value={row.siteId ?? undefined}
        style={{ width: 220 }}
        placeholder="Не назначен"
        showSearch
        optionFilterProp="label"
        loading={sitesQuery.isLoading}
        onChange={(v) => patch.mutate({ id: row.id, body: { siteId: v ?? null } })}
        options={sites.map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))}
      />
    );
  };

  return (
    <StickyPageHeader
      header={<Typography.Title level={3} style={{ margin: 0 }}>Пользователи</Typography.Title>}
    >
      <ResponsiveTable<UserDto>
        items={list.data ?? []}
        loading={list.isLoading}
        rowKey="id"
        numbered
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
            title: 'Объект',
            dataIndex: 'siteId',
            render: (_: unknown, row: UserDto) => renderSiteCell(row),
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
        cardRender={(u) => {
          const site = u.siteId ? sites.find((s) => s.id === u.siteId) : null;
          return (
            <Space direction="vertical" style={{ width: '100%' }}>
              <Typography.Text strong>{u.email}</Typography.Text>
              <Space wrap>
                <Tag>{u.role}</Tag>
                {u.isActive ? <Tag color="green">активен</Tag> : <Tag color="red">не активен</Tag>}
              </Space>
              {u.role === 'inspector_kpp' && (
                <Space>
                  <Typography.Text type="secondary">Объект:</Typography.Text>
                  {site ? (
                    <Typography.Text>{`${site.code} · ${site.name}`}</Typography.Text>
                  ) : (
                    <Tag color="orange">не назначен</Tag>
                  )}
                </Space>
              )}
            </Space>
          );
        }}
      />
    </StickyPageHeader>
  );
}
