import { Button, Select, Spin, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { Site } from '@matcheck/contracts';
import { api } from '../../services/api';

type SiteListResponse = { items: Site[]; total: number };

// Селект объекта (sites) для загрузки УПД. Используется и в PDF-, и в XML-диалоге.
// Берём только активные объекты — неактивные в списке выбора не нужны.
export function SiteSelect({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  const list = useQuery({
    queryKey: ['sites', { activeOnly: true }],
    queryFn: () => api.get<SiteListResponse>('/sites?activeOnly=true&limit=500'),
  });

  return (
    <Select
      showSearch
      allowClear
      placeholder="Выберите объект"
      value={value ?? undefined}
      onChange={(v) => onChange(v ?? null)}
      loading={list.isLoading}
      disabled={disabled}
      style={{ width: '100%' }}
      filterOption={(input, opt) =>
        String(opt?.label ?? '')
          .toLowerCase()
          .includes(input.toLowerCase())
      }
      // isError отличаем от пустого справочника: раньше упавший GET схлопывался
      // в пустой список и выглядел как «Нет данных». Теперь — явная ошибка с
      // «Повторить», иначе сбой сети/таймаут неотличим от отсутствия объектов.
      notFoundContent={
        list.isLoading ? (
          <Spin size="small" />
        ) : list.isError ? (
          <div style={{ padding: 8, textAlign: 'center' }}>
            <Typography.Text type="secondary">Не удалось загрузить</Typography.Text>{' '}
            <Button size="small" type="link" onClick={() => void list.refetch()}>
              Повторить
            </Button>
          </div>
        ) : undefined
      }
      options={(list.data?.items ?? []).map((s) => ({
        value: s.id,
        label: s.code ? `${s.code} — ${s.name}` : s.name,
      }))}
    />
  );
}
