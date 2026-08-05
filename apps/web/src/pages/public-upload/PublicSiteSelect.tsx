import { Button, Select, Spin, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { publicGetSites } from '../../services/publicApi';

/**
 * Выбор объекта на публичной странице.
 *
 * Отдельный компонент, а не общий SiteSelect: тот ходит в /api/v1/sites через
 * авторизованный клиент. Здесь — публичный справочник, где у объекта есть
 * только id и название.
 */
export function PublicSiteSelect({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  const list = useQuery({
    queryKey: ['public-sites'],
    queryFn: publicGetSites,
    staleTime: 60_000,
  });

  return (
    <Select
      showSearch
      allowClear
      size="large"
      placeholder="Начните вводить название объекта"
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
      notFoundContent={
        list.isLoading ? (
          <Spin size="small" />
        ) : list.isError ? (
          <div style={{ padding: 8, textAlign: 'center' }}>
            <Typography.Text type="secondary">Не удалось загрузить список</Typography.Text>{' '}
            <Button size="small" type="link" onClick={() => void list.refetch()}>
              Повторить
            </Button>
          </div>
        ) : undefined
      }
      options={(list.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))}
    />
  );
}
