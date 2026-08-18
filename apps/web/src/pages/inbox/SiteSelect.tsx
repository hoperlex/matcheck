import { useMemo } from 'react';
import { Button, Select, Spin, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { Site } from '@matcheck/contracts';
import { api } from '../../services/api';

type SiteListResponse = { items: Site[]; total: number };

// Селект объекта (sites) для загрузки УПД. Используется и в PDF-, и в XML-диалоге.
// Берём только активные объекты — неактивные в списке выбора не нужны.
//
// currentLabel — название объекта, который УЖЕ стоит у записи. Нужен там, где
// селект правит существующий документ: объект могли деактивировать после
// загрузки, в activeOnly-списке его нет, и antd показал бы в поле сырой uuid
// вместо названия. Такой объект добавляется отдельной опцией с пометкой, чтобы
// поле читалось, но выбрать его заново было нельзя по ошибке.
export function SiteSelect({
  value,
  onChange,
  disabled,
  currentLabel,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  currentLabel?: string | null;
}) {
  const list = useQuery({
    queryKey: ['sites', { activeOnly: true }],
    queryFn: () => api.get<SiteListResponse>('/sites?activeOnly=true&limit=500'),
  });

  const options = useMemo(() => {
    const items = (list.data?.items ?? []).map((s) => ({
      value: s.id,
      label: s.code ? `${s.code} — ${s.name}` : s.name,
    }));
    // Объект записи не нашёлся среди активных — значит его деактивировали уже
    // после того, как документ на него приняли. Показываем его первым и с
    // пометкой: без этой опции в поле оказался бы uuid. Пока список грузится,
    // items пуст — опция появится и просто уступит место настоящей, когда
    // ответ придёт.
    if (value && !items.some((o) => o.value === value)) {
      const label = currentLabel?.trim();
      items.unshift({ value, label: label ? `${label} (не активен)` : 'Объект не активен' });
    }
    return items;
  }, [list.data, value, currentLabel]);

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
      options={options}
    />
  );
}
