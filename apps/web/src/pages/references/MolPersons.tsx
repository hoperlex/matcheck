import { useMemo, useState } from 'react';
import { Alert, Space, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { MolListResponse, MolPerson } from '@matcheck/contracts';
import { api } from '../../services/api';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { DebouncedSearch } from '../../shared/ui/DebouncedSearch';
import { stringSorter } from '../../shared/ui/tableSorters';

/**
 * Справочник МОЛ — read-only список из внешней БД ФОТ (`public.mol_persons`).
 * Не редактируется в MATCHECK: обновляется на стороне ФОТ при найме/увольнении.
 * Бэкенд (/api/v1/mol) кэширует список и при недоступности ФОТ отдаёт
 * последний кэш с флагом `stale` — здесь показываем предупреждение.
 */
export default function MolPersons() {
  const [search, setSearch] = useState('');

  const list = useQuery({
    queryKey: ['mol'],
    queryFn: () => api.get<MolListResponse>('/mol'),
    // Список меняется редко + бэкенд уже кэширует — не дёргаем часто.
    staleTime: 5 * 60 * 1000,
  });

  const items = useMemo(() => {
    const all = list.data?.items ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (p) =>
        p.fullName.toLowerCase().includes(q) ||
        p.positionName.toLowerCase().includes(q) ||
        (p.tabNumber ?? '').toLowerCase().includes(q),
    );
  }, [list.data, search]);

  const fetchedAt = list.data?.fetchedAt;

  return (
    <StickyPageHeader
      header={
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Space align="baseline" wrap>
            <Typography.Title level={3} style={{ margin: 0 }}>
              МОЛ
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              из БД ФОТ · только чтение
            </Typography.Text>
          </Space>
          <DebouncedSearch
            placeholder="ФИО, должность или табельный"
            value={search}
            onChange={setSearch}
            style={{ width: 300 }}
          />
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
            render: (v: number) => (
              <Tag style={{ marginInlineEnd: 0 }}>{v}</Tag>
            ),
          },
        ]}
      />
      {fetchedAt && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Обновлено из ФОТ: {new Date(fetchedAt).toLocaleString('ru-RU')}
        </Typography.Text>
      )}
    </StickyPageHeader>
  );
}
