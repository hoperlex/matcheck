import { Select } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { Counterparty } from '@matcheck/contracts';
import { api } from '../../services/api';

type CounterpartyListResponse = { items: Counterparty[]; total: number };

// Селект подрядчика для загрузки УПД. Источник — /counterparties?role=contractor
// (фильтр по is_contractor=true). Используется и в PDF-, и в XML-диалоге.
export function ContractorSelect({
  value,
  onChange,
  disabled,
  placeholder = 'Выберите подрядчика',
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const list = useQuery({
    queryKey: ['counterparties', { role: 'contractor' }],
    queryFn: () =>
      api.get<CounterpartyListResponse>('/counterparties?role=contractor&limit=500'),
  });

  return (
    <Select
      showSearch
      allowClear
      placeholder={placeholder}
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
      options={(list.data?.items ?? []).map((c) => ({
        value: c.id,
        label: c.name + (c.inn ? ` (ИНН ${c.inn})` : ''),
      }))}
    />
  );
}
