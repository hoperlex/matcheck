import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  DatePicker,
  Input,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import {
  DELIVERY_GROUP_MAX,
  type Delivery,
  type DeliveryGroupMembersResponse,
  type DeliveryListResponseSchema,
} from '@matcheck/contracts';
import type { z } from 'zod';
import { ApiError, api } from '../../services/api';
import { formatDateTimeRu } from '../../shared/utils/formatRu';
import { deliveriesCount } from './deliveryGroupRows';
import { useDeliveryGroupMutations } from './useDeliveryGroups';

type List = z.infer<typeof DeliveryListResponseSchema>;
type Row = List['items'][number];

/** Что показываем о приёмке в окне — хватает строки списка или состава. */
type Lite = Pick<Delivery, 'id' | 'displayId' | 'vehiclePlate' | 'arrivedAt' | 'supplierName'>;

const lite = (d: Lite): Lite => ({
  id: d.id,
  displayId: d.displayId,
  vehiclePlate: d.vehiclePlate,
  arrivedAt: d.arrivedAt,
  supplierName: d.supplierName,
});

const SEARCH_PAGE = 20;
/** Окно поиска по умолчанию — ±3 дня от отмеченных: рейсы одной поставки рядом. */
const WINDOW_DAYS = 3;

/** Почему приёмку из поиска нельзя добавить; null — можно. */
function unavailable(row: Row, groupId: string | null): string | null {
  if (row.deliveryGroup && row.deliveryGroup.id !== groupId) {
    const others = row.deliveryGroup.members
      .filter((m) => m.deliveryId !== row.id)
      .map((m) => m.displayId)
      .join(', ');
    return `в группе с ${others}`;
  }
  if (row.sourceShipmentId) return 'из отгрузки';
  if (row.status.code === 'draft') return 'черновик';
  return null;
}

function defaultWindow(rows: readonly Lite[]): [Dayjs, Dayjs] | null {
  const times = rows
    .map((r) => (r.arrivedAt ? Date.parse(r.arrivedAt) : NaN))
    .filter((t) => Number.isFinite(t));
  if (!times.length) return null;
  return [
    dayjs(Math.min(...times))
      .subtract(WINDOW_DAYS, 'day')
      .startOf('day'),
    dayjs(Math.max(...times))
      .add(WINDOW_DAYS, 'day')
      .endOf('day'),
  ];
}

/**
 * Окно «Группа приёмок»: создать группу из отмеченных или поменять состав
 * существующей. Рейсы одной поставки бывают на разных страницах списка, поэтому
 * здесь свой поиск по объекту, а выбор переживает листание.
 *
 * Все правки — «Убрать» и добавление — применяются одной операцией по
 * «Сохранить»: замена в группе из двух не распускает её посередине.
 */
export function DeliveryGroupModal({
  open,
  groupId,
  siteId,
  siteName,
  initial,
  onClose,
  onDone,
}: {
  open: boolean;
  /** Существующая группа — правка состава; null — новая группа. */
  groupId: string | null;
  siteId: string;
  siteName: string | null;
  /** Отмеченные в списке приёмки: в новую группу — все, в существующую — недостающие. */
  initial: readonly Lite[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { compose } = useDeliveryGroupMutations();
  // Начальное состояние — сразу из отмеченных: иначе первый поиск ушёл бы без
  // окна дат, и следом второй — уже с ним.
  const [added, setAdded] = useState<Map<string, Lite>>(
    () => new Map(initial.map((d) => [d.id, lite(d)])),
  );
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(() => defaultWindow(initial));
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAdded(new Map(initial.map((d) => [d.id, lite(d)])));
    setRemoved(new Set());
    setSearch('');
    setQuery('');
    setRange(defaultWindow(initial));
    setPage(1);
    setError(null);
    // Состав отмеченных меняется только между открытиями.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, groupId]);

  const membersQuery = useQuery({
    queryKey: ['delivery-group-members', groupId],
    queryFn: () => api.get<DeliveryGroupMembersResponse>(`/delivery-groups/${groupId}/members`),
    enabled: open && !!groupId,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  const members: Lite[] = useMemo(
    () => (groupId ? (membersQuery.data?.items ?? []).map(lite) : []),
    [groupId, membersQuery.data],
  );
  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members]);

  const candidates = useQuery({
    queryKey: [
      'delivery-group-candidates',
      siteId,
      query,
      range?.[0].toISOString() ?? null,
      range?.[1].toISOString() ?? null,
      page,
    ],
    queryFn: () => {
      const qs = new URLSearchParams({
        siteIds: siteId,
        grouped: '1',
        limit: String(SEARCH_PAGE),
        offset: String((page - 1) * SEARCH_PAGE),
      });
      if (/^\d+$/.test(query)) qs.set('displayId', query);
      else if (query) qs.set('plate', query);
      if (range) {
        qs.set('arrivedFrom', range[0].toISOString());
        qs.set('arrivedTo', range[1].toISOString());
      }
      return api.get<List>(`/deliveries?${qs}`);
    },
    enabled: open,
  });

  // Добавленные — без тех, кто уже в группе: в новую группу добавляется всё.
  const toAdd = [...added.values()].filter((d) => !memberIds.has(d.id));
  const kept = members.filter((m) => !removed.has(m.id));
  const finalCount = kept.length + toAdd.length;
  const changed = toAdd.length > 0 || removed.size > 0;

  const saveBlock = !changed
    ? 'Нет изменений'
    : !groupId && finalCount < 2
      ? 'Для группы нужны хотя бы две приёмки — найдите остальные поиском'
      : finalCount > DELIVERY_GROUP_MAX
        ? `В группе не больше ${DELIVERY_GROUP_MAX} приёмок`
        : null;

  const save = () => {
    setError(null);
    compose.mutate(
      groupId
        ? {
            groupId,
            expectedMemberIds: members.map((m) => m.id),
            add: toAdd.map((d) => d.id),
            remove: [...removed],
          }
        : { add: toAdd.map((d) => d.id) },
      {
        onSuccess: (result) => {
          message.success(
            result.dissolved
              ? 'Группа распущена: в ней осталось меньше двух приёмок'
              : groupId
                ? 'Состав группы сохранён'
                : `Группа из ${deliveriesCount(result.members.length)} создана`,
          );
          onDone();
        },
        onError: (err) => {
          setError(err instanceof Error ? err.message : 'Не удалось сохранить группу');
          if (err instanceof ApiError && err.code === 'group_changed') {
            setRemoved(new Set());
            void membersQuery.refetch();
          }
        },
      },
    );
  };

  const toggleAdded = (row: Lite, on: boolean) =>
    setAdded((prev) => {
      const next = new Map(prev);
      if (on) next.set(row.id, lite(row));
      else next.delete(row.id);
      return next;
    });
  const toggleRemoved = (id: string) =>
    setRemoved((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const composition: Array<Lite & { member: boolean }> = [
    ...members.map((m) => ({ ...m, member: true })),
    ...toAdd.map((d) => ({ ...d, member: false })),
  ];
  const results = candidates.data?.items ?? [];

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={groupId ? 'Группа приёмок — состав' : 'Новая группа приёмок'}
      width="min(1000px, 96vw)"
      centered
      destroyOnClose
      footer={
        <Space>
          {groupId && changed && finalCount < 2 && (
            <Typography.Text type="warning">
              Останется меньше двух приёмок — группа будет распущена
            </Typography.Text>
          )}
          <Button onClick={onClose} disabled={compose.isPending}>
            Отмена
          </Button>
          <Button
            type="primary"
            disabled={!!saveBlock}
            title={saveBlock ?? undefined}
            loading={compose.isPending}
            onClick={save}
          >
            Сохранить
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          {siteName ? `Объект: ${siteName}. ` : ''}В группе — рейсы одной поставки (одна УПД на
          несколько машин). Только приёмки этого объекта, не больше {DELIVERY_GROUP_MAX}.
        </Typography.Text>
        {error && <Alert type="error" showIcon message={error} />}
        {membersQuery.isError && (
          <Alert type="error" showIcon message="Не удалось загрузить состав группы" />
        )}

        <div>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            В группе: {deliveriesCount(finalCount)}
          </Typography.Title>
          <Table<Lite & { member: boolean }>
            rowKey="id"
            size="small"
            pagination={false}
            loading={!!groupId && membersQuery.isLoading}
            dataSource={composition}
            locale={{ emptyText: 'Пока пусто — отметьте приёмки в поиске ниже' }}
            rowClassName={(row) => (row.member && removed.has(row.id) ? 'mc-group-removed' : '')}
            columns={[
              { title: 'id', dataIndex: 'displayId', width: 90 },
              {
                title: 'Прибытие',
                key: 'arrivedAt',
                width: 150,
                render: (_v, row) => (row.arrivedAt ? formatDateTimeRu(row.arrivedAt) : '—'),
              },
              {
                title: 'Авто',
                key: 'plate',
                width: 120,
                render: (_v, row) => row.vehiclePlate ?? '—',
              },
              { title: 'Поставщик', key: 'supplier', render: (_v, row) => row.supplierName ?? '—' },
              {
                title: '',
                key: 'action',
                width: 150,
                align: 'right',
                render: (_v, row) =>
                  row.member ? (
                    <Space size={4}>
                      {removed.has(row.id) && <Tag color="red">будет убрана</Tag>}
                      <Button size="small" type="link" onClick={() => toggleRemoved(row.id)}>
                        {removed.has(row.id) ? 'Вернуть' : 'Убрать'}
                      </Button>
                    </Space>
                  ) : (
                    <Space size={4}>
                      <Tag color="green">добавится</Tag>
                      <Button size="small" type="link" onClick={() => toggleAdded(row, false)}>
                        Убрать
                      </Button>
                    </Space>
                  ),
              },
            ]}
          />
        </div>

        <div>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            Найти рейсы этого объекта
          </Typography.Title>
          <Space wrap style={{ marginBottom: 8 }}>
            <Input.Search
              allowClear
              placeholder="№ приёмки или номер авто"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                if (!event.target.value) {
                  setQuery('');
                  setPage(1);
                }
              }}
              onSearch={(value) => {
                setQuery(value.trim());
                setPage(1);
              }}
              style={{ width: 280 }}
            />
            <DatePicker.RangePicker
              value={range}
              format="DD.MM.YYYY"
              allowClear
              placeholder={['Прибытие с', 'по']}
              onChange={(value) => {
                setRange(
                  value?.[0] && value[1] ? [value[0].startOf('day'), value[1].endOf('day')] : null,
                );
                setPage(1);
              }}
            />
          </Space>
          <Table<Row>
            rowKey="id"
            size="small"
            loading={candidates.isLoading}
            dataSource={results}
            locale={{ emptyText: 'Ничего не найдено — уточните поиск или даты' }}
            pagination={{
              current: page,
              pageSize: SEARCH_PAGE,
              total: candidates.data?.total ?? 0,
              showSizeChanger: false,
              size: 'small',
              onChange: setPage,
            }}
            rowSelection={{
              selectedRowKeys: results
                .filter(
                  (row) => (memberIds.has(row.id) && !removed.has(row.id)) || added.has(row.id),
                )
                .map((row) => row.id),
              onSelect: (row, selected) => toggleAdded(row, selected),
              onSelectAll: (selected, _rows, changedRows) =>
                changedRows
                  .filter((row) => !memberIds.has(row.id) && !unavailable(row, groupId))
                  .forEach((row) => toggleAdded(row, selected)),
              getCheckboxProps: (row) => ({
                disabled: memberIds.has(row.id) || !!unavailable(row, groupId),
              }),
            }}
            columns={[
              { title: 'id', dataIndex: 'displayId', width: 90 },
              {
                title: 'Прибытие',
                key: 'arrivedAt',
                width: 150,
                render: (_v, row) => (row.arrivedAt ? formatDateTimeRu(row.arrivedAt) : '—'),
              },
              {
                title: 'Авто',
                key: 'plate',
                width: 120,
                render: (_v, row) => row.vehiclePlate ?? '—',
              },
              { title: 'Поставщик', key: 'supplier', render: (_v, row) => row.supplierName ?? '—' },
              {
                title: '',
                key: 'state',
                width: 220,
                render: (_v, row) => {
                  if (memberIds.has(row.id)) return <Tag color="purple">в этой группе</Tag>;
                  const why = unavailable(row, groupId);
                  return why ? <Tag>{why}</Tag> : null;
                },
              },
            ]}
          />
        </div>
      </Space>
      <style>{`.mc-group-removed td:not(:last-child) { opacity: 0.55; text-decoration: line-through; }`}</style>
    </Modal>
  );
}
