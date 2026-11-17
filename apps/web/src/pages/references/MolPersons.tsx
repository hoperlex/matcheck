import { useMemo, useState } from 'react';
import { Alert, Button, Card, Space, Switch, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { MolListResponse, MolPerson, ResponsiblePerson } from '@matcheck/contracts';
import { api } from '../../services/api';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { DebouncedSearch } from '../../shared/ui/DebouncedSearch';
import { stringSorter } from '../../shared/ui/tableSorters';
import { ResponsiblePersonDrawer } from './ResponsiblePersonDrawer';

/** Запрос блока ручных МОЛ. */
export function manualMolUrl(showArchived: boolean): string {
  // activeOnly=false не передаём: сервер разбирает его через z.coerce.boolean,
  // и строка «false» превращается в true. Архивные видны без параметра.
  return `/responsible-persons?source=local&limit=500${showArchived ? '' : '&activeOnly=true'}`;
}

/**
 * Справочник МОЛ — два источника на одной вкладке.
 *
 * 1. Список из внешней БД ФОТ (`public.mol_persons`, начальники участков):
 *    только чтение, обновляется на стороне ФОТ при найме/увольнении. Бэкенд
 *    (/api/v1/mol) кэширует его и при недоступности ФОТ отдаёт последний кэш
 *    с флагом `stale` — тогда показываем предупреждение.
 * 2. «Добавлены вручную» — МОЛ, которых в ФОТ нет (кладовщики). Заводит и
 *    правит менеджер; удаления нет, человека уводят в архив.
 *
 * В списках выбора МОЛ (документы, приёмка, отгрузка) видны активные из обоих.
 */
export default function MolPersons() {
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<ResponsiblePerson | null>(null);
  // Права ручных МОЛ — ячейки справочника «Ответственные лица»: на них же
  // закрыты POST и PATCH /responsible-persons.
  const { can } = usePermissions();
  const canCreate = can('references.responsible_persons', 'create');
  const canEdit = can('references.responsible_persons', 'edit');

  const list = useQuery({
    queryKey: ['mol'],
    queryFn: () => api.get<MolListResponse>('/mol'),
    // Список меняется редко + бэкенд уже кэширует — не дёргаем часто.
    staleTime: 5 * 60 * 1000,
  });

  const manual = useQuery({
    queryKey: ['responsible-persons', 'local', showArchived ? 'all' : 'active'],
    queryFn: () =>
      api.get<{ items: ResponsiblePerson[]; total: number }>(manualMolUrl(showArchived)),
  });

  const q = search.trim().toLowerCase();
  const items = useMemo(() => {
    const all = list.data?.items ?? [];
    if (!q) return all;
    return all.filter(
      (p) =>
        p.fullName.toLowerCase().includes(q) ||
        p.positionName.toLowerCase().includes(q) ||
        (p.tabNumber ?? '').toLowerCase().includes(q),
    );
  }, [list.data, q]);

  const manualItems = useMemo(() => {
    const all = manual.data?.items ?? [];
    if (!q) return all;
    return all.filter(
      (p) =>
        p.fullName.toLowerCase().includes(q) ||
        (p.position ?? '').toLowerCase().includes(q) ||
        (p.phone ?? '').toLowerCase().includes(q),
    );
  }, [manual.data, q]);

  const fetchedAt = list.data?.fetchedAt;

  function openCreate() {
    setEditing(null);
    setDrawerOpen(true);
  }
  function openEdit(r: ResponsiblePerson) {
    setEditing(r);
    setDrawerOpen(true);
  }

  return (
    <StickyPageHeader
      header={
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Space align="baseline" wrap>
            <Typography.Title level={3} style={{ margin: 0 }}>
              МОЛ
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              из БД ФОТ + добавленные вручную
            </Typography.Text>
          </Space>
          <Space wrap>
            <DebouncedSearch
              placeholder="ФИО, должность или табельный"
              value={search}
              onChange={setSearch}
              style={{ width: 300 }}
            />
            {canCreate && (
              <Button type="primary" onClick={openCreate}>
                Добавить МОЛ
              </Button>
            )}
          </Space>
        </Space>
      }
    >
      {list.data?.stale && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message="Список мог устареть"
          description="Не удалось обновить данные из БД ФОТ — показан последний загруженный список."
        />
      )}
      <ResponsiveTable<MolPerson>
        items={items}
        loading={list.isLoading}
        rowKey="employeeId"
        numbered
        // Список МОЛ приходит целиком (без limit), поиск — на клиенте.
        autoColumnTools={{ total: items.length }}
        columns={[
          {
            title: 'ФИО',
            dataIndex: 'fullName',
            sorter: stringSorter<MolPerson>((r) => r.fullName),
          },
          {
            title: 'Должность',
            dataIndex: 'positionName',
            sorter: stringSorter<MolPerson>((r) => r.positionName),
          },
          {
            title: 'Табельный',
            dataIndex: 'tabNumber',
            width: 140,
            sorter: stringSorter<MolPerson>((r) => r.tabNumber),
            render: (v: string | null) => v ?? '—',
          },
          {
            title: 'ID ФОТ',
            dataIndex: 'employeeId',
            width: 120,
            render: (v: number) => <Tag style={{ marginInlineEnd: 0 }}>{v}</Tag>,
            tools: { text: (r) => String(r.employeeId), sortValue: (r) => r.employeeId },
          },
        ]}
        // На узком экране ResponsiveTable рисует карточки, а не таблицу, и без
        // cardRender страница справочника падала бы прямо при рендере списка.
        cardRender={(r) => (
          <Card style={{ width: '100%' }} size="small">
            <Space direction="vertical" size={4}>
              <Typography.Text strong>{r.fullName}</Typography.Text>
              <Typography.Text type="secondary">{r.positionName}</Typography.Text>
              <Space size={8} wrap>
                {r.tabNumber && (
                  <Typography.Text type="secondary">Таб. № {r.tabNumber}</Typography.Text>
                )}
                <Tag style={{ marginInlineEnd: 0 }}>{r.employeeId}</Tag>
              </Space>
            </Space>
          </Card>
        )}
      />
      {fetchedAt && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Обновлено из ФОТ: {new Date(fetchedAt).toLocaleString('ru-RU')}
        </Typography.Text>
      )}

      <Space
        style={{ width: '100%', justifyContent: 'space-between', marginTop: 24, marginBottom: 8 }}
        wrap
      >
        <Space align="baseline" wrap>
          <Typography.Title level={4} style={{ margin: 0 }}>
            Добавлены вручную
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            кого нет в ФОТ, например кладовщики
          </Typography.Text>
        </Space>
        <Space size={8}>
          <Switch
            size="small"
            checked={showArchived}
            onChange={setShowArchived}
            aria-label="Показать архивные"
          />
          <Typography.Text>Показать архивные</Typography.Text>
        </Space>
      </Space>
      <ResponsiveTable<ResponsiblePerson>
        items={manualItems}
        loading={manual.isLoading}
        rowKey="id"
        numbered
        onRowClick={canEdit ? openEdit : undefined}
        autoColumnTools={{ total: manualItems.length }}
        columns={[
          {
            title: 'ФИО',
            dataIndex: 'fullName',
            sorter: stringSorter<ResponsiblePerson>((r) => r.fullName),
          },
          {
            title: 'Должность',
            dataIndex: 'position',
            sorter: stringSorter<ResponsiblePerson>((r) => r.position),
            render: (v: string | null) => v ?? '—',
          },
          {
            title: 'Телефон',
            dataIndex: 'phone',
            width: 180,
            sorter: stringSorter<ResponsiblePerson>((r) => r.phone),
            render: (v: string | null) => v ?? '—',
          },
          {
            title: 'Статус',
            key: 'status',
            width: 130,
            sorter: (a: ResponsiblePerson, b: ResponsiblePerson) =>
              Number(b.isActive) - Number(a.isActive),
            tools: { text: (r) => (r.isActive ? 'Активный' : 'В архиве') },
            render: (_: unknown, r: ResponsiblePerson) =>
              r.isActive ? <Tag color="green">Активный</Tag> : <Tag>В архиве</Tag>,
          },
        ]}
        cardRender={(r) => (
          <Card style={{ width: '100%' }} size="small">
            <Space direction="vertical" size={4}>
              <Typography.Text strong>{r.fullName}</Typography.Text>
              {r.position && <Typography.Text type="secondary">{r.position}</Typography.Text>}
              {r.phone && <Typography.Text type="secondary">{r.phone}</Typography.Text>}
              {!r.isActive && <Tag>В архиве</Tag>}
            </Space>
          </Card>
        )}
      />
      <ResponsiblePersonDrawer
        open={drawerOpen}
        editing={editing}
        canEdit={canEdit}
        onClose={() => {
          setDrawerOpen(false);
          setEditing(null);
        }}
      />
    </StickyPageHeader>
  );
}
