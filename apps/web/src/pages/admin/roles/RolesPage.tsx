import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MANAGED_ROLES,
  PAGE_ACTIONS,
  PAGE_ACTION_LABELS,
  PAGE_GROUPS,
  PAGE_GROUP_LABELS,
  type ManagedRole,
  type PageAction,
  type PageGroup,
  type RolePermissionsResponse,
  type UserRole,
} from '@matcheck/contracts';
import { api } from '../../../services/api';
import { StickyPageHeader } from '../../../shared/ui/StickyPageHeader';
import { ResponsiveTable } from '../../../shared/ui/ResponsiveTable';
import { roleLabel } from '../../../shared/constants/roleLabels';
import {
  applyCell,
  applyGroup,
  cellState,
  cloneMatrix,
  diffMatrix,
  groupState,
  roleHasChanges,
  type CatalogEntry,
  type Matrix,
} from './matrixDraft';

const ROLE_TABS: UserRole[] = ['admin', ...MANAGED_ROLES];

/** Подсказка под каждым состоянием ячейки — почему её нельзя тронуть. */
const CELL_HINT: Record<string, string> = {
  locked:
    'Требуется мобильному приложению КПП: планшет не показывает ошибку доступа и просто перестанет работать',
  'not-in-base': 'Роли это действие недоступно и сейчас — матрица умеет только сужать доступ',
};

type Row = CatalogEntry;

export default function RolesPage() {
  const qc = useQueryClient();
  const [role, setRole] = useState<ManagedRole>('manager');
  const [adminSelected, setAdminSelected] = useState(false);
  const [draft, setDraft] = useState<Matrix | null>(null);

  const query = useQuery({
    queryKey: ['role-permissions'],
    queryFn: () => api.get<RolePermissionsResponse>('/admin/role-permissions'),
  });

  const server = useMemo(
    () => (query.data ? (query.data.matrix as Matrix) : null),
    [query.data],
  );
  const lockedCells = useMemo(
    () => new Set(query.data?.lockedCells ?? []),
    [query.data?.lockedCells],
  );
  // Каталог берём ИЗ ОТВЕТА сервера, а не из @matcheck/contracts: при
  // раздельном выкате веба и API списки страниц разъедутся, и админ будет
  // править строки, которых сервер не знает.
  const catalog = query.data?.catalog ?? [];

  // Черновик поднимается один раз на загрузку. Пере-инициализация на каждый
  // ответ (в т.ч. фоновый refetch) стирала бы несохранённые правки.
  useEffect(() => {
    if (server && !draft) setDraft(cloneMatrix(server));
  }, [server, draft]);

  const changes = server && draft ? diffMatrix(server, draft) : [];
  const dirty = changes.length > 0;

  // Уход со страницы с несохранёнными правками. useBlocker здесь не
  // применяем — вкладка живёт внутри AdminLayout, и достаточно предупредить
  // о закрытии/перезагрузке; навигацию человек делает осознанно, а черновик
  // не переживает перезагрузку в любом случае.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const save = useMutation({
    mutationFn: (payload: typeof changes) =>
      api.patch<RolePermissionsResponse>('/admin/role-permissions', { changes: payload }),
    onSuccess: (res) => {
      // Ответ — уже пересчитанная матрица: берём её как новую основу и
      // черновик, иначе следующий diff считался бы от устаревшего снимка.
      qc.setQueryData(['role-permissions'], res);
      setDraft(cloneMatrix(res.matrix as Matrix));
      message.success('Права сохранены');
    },
    onError: (err: Error) => message.error(err.message),
  });

  const reset = useMutation({
    mutationFn: (target: ManagedRole) =>
      api.delete<RolePermissionsResponse>(`/admin/role-permissions/${target}`),
    onSuccess: (res) => {
      qc.setQueryData(['role-permissions'], res);
      setDraft(cloneMatrix(res.matrix as Matrix));
      message.success('Права роли сброшены к значениям по умолчанию');
    },
    onError: (err: Error) => message.error(err.message),
  });

  if (query.isLoading || !draft || !server) {
    return (
      <div style={{ padding: 24 }}>
        <Spin />
      </div>
    );
  }
  if (query.isError) {
    return <Alert type="error" showIcon message="Не удалось загрузить матрицу прав" />;
  }

  const toggleCell = (entry: Row, action: PageAction, allowed: boolean) => {
    setDraft((d) => (d ? applyCell(d, entry, role, action, allowed, lockedCells) : d));
  };

  const toggleGroup = (entries: Row[], action: PageAction, allowed: boolean) => {
    setDraft((d) => (d ? applyGroup(d, entries, role, action, allowed, lockedCells) : d));
  };

  const renderCell = (entry: Row, action: PageAction) => {
    const state = cellState(entry, role, action, lockedCells);
    // Неприменимое действие не рисуем вовсе: прочерк ломал бы выравнивание
    // колонки, а пустая ячейка читается как «нет такого измерения».
    if (state === 'not-applicable') return null;
    const checked = state === 'locked' ? true : Boolean(draft[role]?.[entry.id]?.[action]);
    const box = (
      <Checkbox
        checked={checked}
        disabled={state !== 'editable'}
        onChange={(e) => toggleCell(entry, action, e.target.checked)}
      />
    );
    const hint = CELL_HINT[state];
    return hint ? (
      <Tooltip title={hint}>
        <span>{box}</span>
      </Tooltip>
    ) : (
      box
    );
  };

  const groupsWithPages: { group: PageGroup; entries: Row[] }[] = PAGE_GROUPS.map((g) => ({
    group: g,
    entries: catalog.filter((c) => c.group === g),
  })).filter((g) => g.entries.length > 0);

  const isAdminView = adminSelected;

  return (
    <StickyPageHeader
      header={
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
            <Space wrap>
              {ROLE_TABS.map((r) => {
                const isAdminRole = r === 'admin';
                const active = isAdminRole ? adminSelected : !adminSelected && r === role;
                const changed =
                  !isAdminRole && roleHasChanges(server, draft, r as ManagedRole);
                return (
                  <Button
                    key={r}
                    type={active ? 'primary' : 'default'}
                    onClick={() => {
                      setAdminSelected(isAdminRole);
                      if (!isAdminRole) setRole(r as ManagedRole);
                    }}
                  >
                    <Badge dot={changed} offset={[4, -2]}>
                      {roleLabel(r)}
                    </Badge>
                  </Button>
                );
              })}
            </Space>
            <Space wrap>
              {dirty && <Tag color="orange">Есть несохранённые изменения</Tag>}
              <Button
                onClick={() => setDraft(cloneMatrix(server))}
                disabled={!dirty || save.isPending}
              >
                Отменить
              </Button>
              <Popconfirm
                title={`Сбросить права роли «${roleLabel(role)}» к значениям по умолчанию?`}
                okText="Сбросить"
                cancelText="Отмена"
                onConfirm={() => reset.mutate(role)}
                disabled={isAdminView}
              >
                <Button danger disabled={isAdminView} loading={reset.isPending}>
                  Сбросить к дефолту
                </Button>
              </Popconfirm>
              <Button
                type="primary"
                disabled={!dirty}
                loading={save.isPending}
                onClick={() => save.mutate(changes)}
              >
                Сохранить
              </Button>
            </Space>
          </Space>
          {!query.data?.enforced && (
            <Alert
              type="info"
              showIcon
              message="Применение прав выключено"
              description="Матрица сохраняется, но пока не действует: сервер запущен с PERMISSIONS_ENFORCE=0. Настройки оживут после включения."
            />
          )}
          {isAdminView && (
            <Alert
              type="warning"
              showIcon
              message="Права администратора не настраиваются"
              description="Это единственная роль, которая может вернуть доступ остальным: закрыв ей что-либо, восстановить настройки было бы уже нечем."
            />
          )}
        </Space>
      }
    >
      {groupsWithPages.map(({ group, entries }) => (
        <Card
          key={group}
          size="small"
          style={{ marginBottom: 12 }}
          title={
            <Space wrap size={16}>
              <Typography.Text strong>{PAGE_GROUP_LABELS[group]}</Typography.Text>
              {!isAdminView &&
                PAGE_ACTIONS.map((action) => {
                  const st = groupState(draft, entries, role, action, lockedCells);
                  if (st.disabled && !st.checked) return null;
                  return (
                    <Checkbox
                      key={action}
                      checked={st.checked}
                      indeterminate={st.indeterminate}
                      disabled={st.disabled}
                      onChange={(e) => toggleGroup(entries, action, e.target.checked)}
                    >
                      <Typography.Text type="secondary">
                        {PAGE_ACTION_LABELS[action]}
                      </Typography.Text>
                    </Checkbox>
                  );
                })}
            </Space>
          }
        >
          <ResponsiveTable<Row>
            items={entries}
            rowKey={(r) => r.id}
            pagination={false}
            columns={[
              {
                title: 'Страница',
                dataIndex: 'label',
                render: (_: unknown, r: Row) => (
                  <Space size={6}>
                    <span>{r.label}</span>
                    {r.hidden && (
                      <Tooltip title="Пункта меню нет — страница открывается только по прямой ссылке">
                        <Tag>скрытая</Tag>
                      </Tooltip>
                    )}
                  </Space>
                ),
              },
              ...PAGE_ACTIONS.map((action) => ({
                title: PAGE_ACTION_LABELS[action],
                key: action,
                width: 130,
                render: (_: unknown, r: Row) =>
                  isAdminView ? (
                    <Checkbox checked disabled />
                  ) : (
                    renderCell(r, action)
                  ),
              })),
            ]}
            cardRender={(r) => (
              <Card size="small" style={{ width: '100%' }}>
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Typography.Text strong>{r.label}</Typography.Text>
                  <Space wrap size={12}>
                    {PAGE_ACTIONS.filter((a) => r.actions.includes(a)).map((action) => (
                      <Space key={action} size={4}>
                        {isAdminView ? <Checkbox checked disabled /> : renderCell(r, action)}
                        <Typography.Text type="secondary">
                          {PAGE_ACTION_LABELS[action]}
                        </Typography.Text>
                      </Space>
                    ))}
                  </Space>
                </Space>
              </Card>
            )}
          />
        </Card>
      ))}
    </StickyPageHeader>
  );
}
