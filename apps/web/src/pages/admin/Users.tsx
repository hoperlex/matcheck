import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Input,
  Select,
  Switch,
  Tag,
  Tooltip,
  Typography,
  Space,
  message,
} from 'antd';
import { EditOutlined, LinkOutlined, PhoneOutlined, SearchOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CustomerCounterparty,
  PasswordResetState,
  PasswordResetStateListResponse,
  Site,
  UserAdminPatch,
  UserDto,
  UserRole,
} from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { roleLabel } from '../../shared/constants/roleLabels';
import { UserEditModal } from './UserEditModal';
import { PasswordResetLinkModal } from './PasswordResetLinkModal';
import { formatDateRu, formatDateTimeRu } from '../../shared/utils/formatRu';
import { usePermissions } from '../../shared/hooks/usePermissions';

// Список ролей выбора. Дубль UserRoleSchema: компилятор его не сверяет, а
// typecheck веба сейчас не проверяет файлы вовсе (корневой tsconfig с
// files: []), поэтому полноту стережёт roleLabels.test.ts.
const roles: UserRole[] = [
  'admin',
  'manager',
  'inspector_kpp',
  'contractor',
  'monitor',
  'observer',
];

// ИНН считаем валидным, если после удаления нецифр остаётся непустая
// не-нулевая строка. Подрядчик без валидного ИНН → скоуп по ИНН вернёт пусто,
// поэтому такие записи справочника нельзя выбирать при назначении.
function hasValidInn(inn: string | null | undefined): boolean {
  const digits = (inn ?? '').replace(/[^0-9]/g, '');
  return digits.length > 0 && !/^0+$/.test(digits);
}

export default function AdminUsersPage() {
  const qc = useQueryClient();
  // Страницу можно выдать на просмотр (admin.users:view), а правку — нельзя:
  // admin.users:edit|delete в NEVER_GRANTABLE, потому что через PATCH
  // пользователя выдаётся роль admin. Значит режим «только смотрю» здесь не
  // экзотика, а штатное состояние для всех, кроме администратора, и контролы
  // обязаны его отражать — иначе каждый из них ответит 403.
  const { can } = usePermissions();
  const canEditUsers = can('admin.users', 'edit');
  const [editing, setEditing] = useState<UserDto | null>(null);
  const [resetFor, setResetFor] = useState<UserDto | null>(null);
  // Поиск — client-side: бэк /admin/users отдаёт плоский UserDto[] без
  // пагинации, на проде типично ~40-50 пользователей. Server-side q-фильтр
  // тут — overkill: лишний round-trip без выгоды по производительности.
  const [search, setSearch] = useState('');
  const list = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api.get<UserDto[]>('/admin/users'),
  });
  // toLocaleLowerCase('ru') корректно опускает кириллицу (включая Ё→ё)
  // в отличие от обычного toLowerCase(), который для русского работает
  // через generic Unicode-таблицу и в edge-case'ах даёт другую раскладку.
  // Поиск по email и ФИО — substring, без учёта регистра.
  const filteredItems = useMemo(() => {
    const all = list.data ?? [];
    const q = search.trim().toLocaleLowerCase('ru');
    if (!q) return all;
    return all.filter((u) => {
      const email = u.email.toLocaleLowerCase('ru');
      const name = (u.fullName ?? '').toLocaleLowerCase('ru');
      return email.includes(q) || name.includes(q);
    });
  }, [list.data, search]);
  const sitesQuery = useQuery({
    queryKey: ['sites', 'active'],
    queryFn: () => api.get<{ items: Site[]; total: number }>('/sites?activeOnly=true&limit=500'),
  });
  const sites = sitesQuery.data?.items ?? [];
  // Справочник контрагентов-подрядчиков заказчика — для привязки роли contractor.
  const customerCpQuery = useQuery({
    queryKey: ['customer-counterparties', 'all'],
    queryFn: () =>
      api.get<{ items: CustomerCounterparty[]; total: number }>(
        '/customer-counterparties?limit=5000',
      ),
  });
  const customerCps = customerCpQuery.data?.items ?? [];
  // Состояние сброса пароля: заявки от людей и выданные ссылки. Намеренно
  // отдельным запросом, а не полями в UserDto — тот DTO ходит в мобильное
  // приложение, и админская механика ему не нужна. Ни токенов, ни URL здесь
  // нет: только метаданные, ссылку отдаёт reveal по одной.
  const resetsQuery = useQuery({
    queryKey: ['admin', 'password-resets'],
    queryFn: () => api.get<PasswordResetStateListResponse>('/admin/password-resets'),
  });
  const resetByUser = useMemo(() => {
    const map = new Map<string, PasswordResetState>();
    for (const item of resetsQuery.data?.items ?? []) map.set(item.userId, item);
    return map;
  }, [resetsQuery.data]);
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UserAdminPatch }) =>
      api.patch(`/admin/users/${id}`, body),
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const PhoneCell = ({ row }: { row: UserDto }) => {
    // Локальный draft, чтобы не дёргать PATCH при каждом нажатии клавиши.
    // Шлём изменение только на blur/Enter и только если значение реально
    // отличается от серверного (после trim). Пустая строка — это null,
    // мобила различает «нет контакта» именно по null.
    const [draft, setDraft] = useState<string>(row.phone ?? '');
    const commit = () => {
      const next = draft.trim();
      const cur = (row.phone ?? '').trim();
      if (next === cur) return;
      patch.mutate({ id: row.id, body: { phone: next.length > 0 ? next : null } });
    };
    return (
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onPressEnter={(e) => (e.target as HTMLInputElement).blur()}
        placeholder="+7 …"
        allowClear
        disabled={!canEditUsers}
        // Ширину задаёт колонка: с фиксированной шириной контрол вылезал за
        // её границу и обрезался на стыке ячеек.
        style={{ width: '100%' }}
        prefix={<PhoneOutlined style={{ color: '#bfbfbf' }} />}
      />
    );
  };

  const renderSiteCell = (row: UserDto) => {
    if (row.role !== 'inspector_kpp') {
      return <Typography.Text type="secondary">—</Typography.Text>;
    }
    return (
      <Select<string>
        value={row.siteId ?? undefined}
        style={{ width: '100%' }}
        placeholder="Не назначен"
        showSearch
        optionFilterProp="label"
        loading={sitesQuery.isLoading}
        disabled={!canEditUsers}
        onChange={(v) => patch.mutate({ id: row.id, body: { siteId: v ?? null } })}
        options={sites.map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))}
      />
    );
  };

  // Селект подрядчика — только для роли contractor (аналог renderSiteCell).
  // Записи справочника без валидного ИНН задизейблены: скоуп по ИНН вернёт
  // пусто, подрядчик увидел бы пустоту.
  const renderContractorCell = (row: UserDto) => {
    if (row.role !== 'contractor') {
      return <Typography.Text type="secondary">—</Typography.Text>;
    }
    return (
      <Select<string>
        value={row.contractorCustomerId ?? undefined}
        style={{ width: '100%' }}
        placeholder="Не назначен"
        showSearch
        optionFilterProp="label"
        loading={customerCpQuery.isLoading}
        disabled={!canEditUsers}
        onChange={(v) => patch.mutate({ id: row.id, body: { contractorCustomerId: v ?? null } })}
        options={customerCps.map((c) => ({
          value: c.id,
          label: `${c.name} · ИНН ${c.inn || '—'}`,
          disabled: !hasValidInn(c.inn),
        }))}
      />
    );
  };

  return (
    <StickyPageHeader
      header={
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap size={[16, 8]}>
          <Typography.Title level={3} style={{ margin: 0 }}>
            Пользователи
          </Typography.Title>
          <Input
            placeholder="Поиск по email или ФИО"
            allowClear
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
            style={{ width: 320, maxWidth: '100%' }}
            // Иначе браузер принимает поле за «логин» и автозаполняет его
            // email-ом текущего аккаунта (триггерится autofill пароля рядом).
            autoComplete="off"
            name="user-search"
          />
        </Space>
      }
    >
      {list.isError && (
        // Иначе упавший GET показывал бы пустую таблицу «Нет данных», неотличимо
        // от отсутствия пользователей (симптом «зависшего» раздела при сбое сети).
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="Не удалось загрузить пользователей"
          action={
            <Button size="small" onClick={() => void list.refetch()}>
              Повторить
            </Button>
          }
        />
      )}
      <ResponsiveTable<UserDto>
        items={filteredItems}
        loading={list.isLoading}
        rowKey="id"
        numbered
        // Колонок десять; на 1024-1366px без минимальной ширины они сжимаются
        // до нечитаемых 60px. Скроллим саму таблицу, а не страницу.
        scrollX={1240}
        columns={[
          { title: 'Email', dataIndex: 'email' },
          {
            title: 'Роль',
            dataIndex: 'role',
            render: (r: UserRole, row: UserDto) => (
              <Select
                value={r}
                style={{ width: '100%' }}
                disabled={!canEditUsers}
                onChange={(v) => patch.mutate({ id: row.id, body: { role: v } })}
                options={roles.map((rl) => ({ value: rl, label: roleLabel(rl) }))}
              />
            ),
          },
          {
            title: 'Объект',
            dataIndex: 'siteId',
            render: (_: unknown, row: UserDto) => renderSiteCell(row),
          },
          {
            title: 'Подрядчик',
            dataIndex: 'contractorCustomerId',
            render: (_: unknown, row: UserDto) => renderContractorCell(row),
          },
          {
            title: 'Активен',
            dataIndex: 'isActive',
            width: 80,
            render: (a: boolean, row: UserDto) => (
              <Switch
                checked={a}
                disabled={!canEditUsers}
                onChange={(v) => patch.mutate({ id: row.id, body: { isActive: v } })}
              />
            ),
          },
          {
            // Без render в ячейку попадала сырая ISO-строка вида
            // «2026-08-12T07:31:53.178Z» — обрезанная по ширине колонки и
            // нечитаемая. Время локальное: сервер пишет UTC, админ смотрит
            // московское.
            title: 'Создан',
            dataIndex: 'createdAt',
            width: 140,
            render: (v: string | null) => formatDateTimeRu(v),
          },
          {
            title: 'Контакт',
            key: 'phone',
            render: (_: unknown, row: UserDto) => <PhoneCell row={row} />,
          },
          {
            title: 'ФИО',
            dataIndex: 'fullName',
            render: (v: string | null) => v ?? '—',
          },
          {
            title: 'Действия',
            key: 'actions',
            width: 90,
            align: 'right' as const,
            render: (_: unknown, row: UserDto) => {
              const reset = resetByUser.get(row.id);
              // Обе кнопки ведут к правке (ссылка на смену пароля — это
              // POST .../password-reset-link). Без права их не рисуем вовсе:
              // задизейбленная иконка без подписи выглядит как сбой, а не как
              // «не положено».
              if (!canEditUsers) return <Typography.Text type="secondary">—</Typography.Text>;
              return (
                <Space size={0}>
                  <Tooltip
                    title={
                      reset?.requestedAt
                        ? `Запросил сброс ${formatDateRu(reset.requestedAt)}`
                        : 'Ссылка на смену пароля'
                    }
                  >
                    <Button
                      type="text"
                      // Заявку подсвечиваем: админ должен видеть, кому нужна
                      // ссылка, не открывая карточки.
                      danger={Boolean(reset?.requestedAt)}
                      icon={<LinkOutlined />}
                      onClick={() => setResetFor(row)}
                    />
                  </Tooltip>
                  <Tooltip title="Редактировать">
                    <Button type="text" icon={<EditOutlined />} onClick={() => setEditing(row)} />
                  </Tooltip>
                </Space>
              );
            },
          },
        ]}
        cardRender={(u) => {
          const site = u.siteId ? sites.find((s) => s.id === u.siteId) : null;
          const contractorCp = u.contractorCustomerId
            ? customerCps.find((c) => c.id === u.contractorCustomerId)
            : null;
          return (
            <Space direction="vertical" style={{ width: '100%' }}>
              <Typography.Text strong>{u.email}</Typography.Text>
              <Space wrap>
                <Tag>{roleLabel(u.role)}</Tag>
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
              {u.role === 'contractor' && (
                <Space>
                  <Typography.Text type="secondary">Подрядчик:</Typography.Text>
                  {contractorCp ? (
                    <Typography.Text>{contractorCp.name}</Typography.Text>
                  ) : (
                    <Tag color="orange">не назначен</Tag>
                  )}
                </Space>
              )}
            </Space>
          );
        }}
      />
      <UserEditModal
        user={editing}
        sites={sites}
        customerCps={customerCps}
        open={editing !== null}
        onClose={() => setEditing(null)}
        onOpenPasswordReset={(u) => {
          setEditing(null);
          setResetFor(u);
        }}
      />
      {resetFor ? (
        <PasswordResetLinkModal
          user={resetFor}
          state={resetByUser.get(resetFor.id)}
          open
          onClose={() => setResetFor(null)}
        />
      ) : null}
    </StickyPageHeader>
  );
}
